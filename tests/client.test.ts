import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getEventListeners } from 'node:events'
import {
  AdbClient,
  E_NO_SERIAL,
  E_TIMEOUT,
  E_ABORTED,
  adbChildCount,
  killAllAdbChildren,
} from '../electron/adb/client'

const isWin = process.platform === 'win32'

// 用系统自带解释器充当「假 adb」：它必须能容忍命令行前缀 -s <serial>。
// Windows 的 cmd 会忽略 /c 之前的参数，因此行为可预测。
const SHELL = isWin ? 'cmd' : 'bash'

function echoArgs(word: string): string[] {
  return isWin ? ['/c', 'echo', word] : ['-c', `echo ${word}`]
}

function stderrArgs(): string[] {
  return isWin ? ['/c', 'type', 'no-such-file-task2-probe.txt'] : ['-c', 'cat /no-such-file-task2-probe.txt']
}

/*
 * 先挂起约 5 秒，再写标记文件。若子进程真被 kill，标记文件永远不会出现。
 *
 * 【任务 8 修的 flake】原来是 ping -n 2 / sleep 1（约 1 秒），而超时只有 100ms、
 * killTree 在 Windows 上又是异步 taskkill —— 全量并行跑测试时机器一忙，
 * taskkill 排在进程真正结束之前，ping 自己跑完就把标记写了，用例假红。
 * 实测：单跑必过、全量并行必挂、--no-file-parallelism 又必过，即典型的负载竞态。
 *
 * 判断谁错：断言（超时后进程树必须死）是对的，夹具的「1 秒窗口」太紧。
 * 把挂起时间拉到 5 秒（远大于下方 1600ms 的观察窗）+ 把观察窗放宽，
 * 断言强度一点没降（真没死照样会写标记），只是不再依赖机器当下有多闲。
 */
function hangThenWriteArgs(marker: string): string[] {
  return isWin
    ? ['/c', 'ping', '-n', '6', '127.0.0.1', '>nul', '&', 'echo', `alive>${marker}`]
    : ['-c', `sleep 5; echo alive > ${marker}`]
}

function markerPath(): string {
  return `task2-proc-marker-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// 用 node 脚本当假 adb：cmd /c <node> <script>，POSIX 用 bash -c exec。
const dirs: string[] = []
afterEach(() => {
  killAllAdbChildren()
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function scriptDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'task2-adb-'))
  dirs.push(dir)
  return dir
}

function nodeAdbArgs(scriptPath: string): string[] {
  return isWin
    ? ['/c', process.execPath, scriptPath]
    : ['-c', `exec "${process.execPath}" "${scriptPath}"`]
}

describe('AdbClient', () => {
  it('缺少 serial 直接抛错', () => {
    expect(() => new AdbClient('')).toThrow(E_NO_SERIAL)
  })

  it('命令自动带 -s serial', () => {
    const client = new AdbClient('ABC123')
    expect(client.buildArgs(['shell', 'ls'])).toEqual(['-s', 'ABC123', 'shell', 'ls'])
  })

  it('serial 含空格、中文、单引号、分号也原样透传（serial 走参数数组，不经 shell）', () => {
    const serial = "ABC 123 中文'; rm -rf /; echo '"
    const client = new AdbClient(serial)
    expect(client.serial).toBe(serial)
    expect(client.buildArgs(['shell', 'ls'])).toEqual(['-s', serial, 'shell', 'ls'])
  })

  it('run 返回退出码与 stdout', async () => {
    const client = new AdbClient('ABC123')
    const result = await client.run(echoArgs('hello'), { adbPath: SHELL })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('hello')
  })

  it('run 收集 stderr 与非零退出码', async () => {
    const client = new AdbClient('ABC123')
    const result = await client.run(stderrArgs(), { adbPath: SHELL })
    expect(result.code).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('run 通过 onStdout 流式回调', async () => {
    const chunks: string[] = []
    const client = new AdbClient('ABC123')
    const result = await client.run(echoArgs('streamed'), {
      adbPath: SHELL,
      onStdout: (chunk) => { chunks.push(chunk) },
    })
    expect(result.stdout.trim()).toBe('streamed')
    expect(chunks.join('').trim()).toBe('streamed')
  })

  // ---- Critical-1：多字节字符跨 chunk ----
  it('多字节字符被切成两个 chunk 时 stdout 仍完整（不出现 U+FFFD）', async () => {
    const dir = scriptDir()
    const script = path.join(dir, 'split.mjs')
    const original = '/sdcard/手机 照片/a.jpg'
    // 第 12 字节正好切在「机」的 3 字节中间
    writeFileSync(script, [
      `const s = Buffer.from(${JSON.stringify(original)}, 'utf8')`,
      'process.stdout.write(s.subarray(0, 12))',
      'setTimeout(() => { process.stdout.write(s.subarray(12)) }, 80)',
    ].join('\n'))

    const client = new AdbClient('ABC123')
    const result = await client.run(nodeAdbArgs(script), { adbPath: SHELL })
    expect(result.stdout).toBe(original)
    expect(result.stdout.includes('\uFFFD')).toBe(false)
  }, 15_000)

  // ---- Important-1：超时也走单一出口 ----
  it('超时后 reject E_TIMEOUT，且手头子进程登记被清理（单一出口 finish）', async () => {
    const marker = markerPath()
    try {
      const client = new AdbClient('ABC123')
      const startedAt = Date.now()
      await expect(
        client.run(hangThenWriteArgs(marker), { adbPath: SHELL, timeoutMs: 100 }),
      ).rejects.toThrow(E_TIMEOUT)
      /*
       * 【任务 8 审查 I 之后语义变了，断言随之调整（不是放宽，是换了度量对象）】
       *
       * 修前：killTree 是 fire-and-forget，settle 立刻发生，所以「<900ms」度量的是
       *       「finish() 不等子进程自然退出」。
       * 修后：按审查要求，reject 发生在 **killTree 的 Promise 完成之后** ——
       *       于是「调用方拿到 reject 时，进程树确实已经死透」成为确定性保证
       *       （这正是审查要的「取消后立刻查进程也不该存在」）。
       *       代价是 settle 时间多了 taskkill 的实际耗时（并行负载下约 1s）。
       *
       * 这条断言真正要守的性质没变：**绝不等子进程自然退出**。
       * 夹具挂起 5 秒（ping -n 6），所以只要 settle 明显早于 5 秒就成立。
       * 留 4.5s 上限：既远小于夹具的 5s，又给 taskkill 在重负载下留足余量。
       */
      expect(Date.now() - startedAt).toBeLessThan(4500)
      // finish 是唯一出口：超时路径必须完成清理，无需等 close
      expect(adbChildCount()).toBe(0)
      /*
       * 观察窗必须【长于】夹具的挂起时间，否则「标记没出现」只是还没到时候，
       * 用例会变成永远通过的假绿。夹具挂起约 5 秒（ping -n 6），这里等 6500ms。
       */
      await wait(6500)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(marker, { force: true })
    }
  }, 15_000)

  // ---- Important-2a：abort 监听器泄漏 ----
  it('正常结束后不残留 abort 监听器', async () => {
    const controller = new AbortController()
    const client = new AdbClient('ABC123')
    for (let i = 0; i < 13; i++) {
      await client.run(echoArgs('ok'), { adbPath: SHELL, signal: controller.signal })
    }
    expect(getEventListeners(controller.signal, 'abort').length).toBe(0)
  }, 30_000)

  // ---- Important-2b：pre-aborted 语义 ----
  // 夹具第一句就写标记：只要进程真的被 spawn 出来，标记几乎立刻落地。
  // 【为什么上一版是假通过】上一版把写标记推迟到 800ms，而 taskkill 是毫秒级完成，
  // 进程在标记落地前就被杀了 —— 于是「标记不存在」恒成立，用例看不出命令其实真跑了。
  it('signal 已 abort 时不得 spawn 进程，直接 reject E_ABORTED', async () => {
    const dir = scriptDir()
    const marker = path.join(dir, 'ran.txt')
    const script = path.join(dir, 'ran.mjs')
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs'",
      'writeFileSync(' + JSON.stringify(marker) + ", 'ran')",
    ].join('\n'))

    const controller = new AbortController()
    controller.abort()
    const client = new AdbClient('ABC123')

    await expect(
      client.run(nodeAdbArgs(script), { adbPath: SHELL, signal: controller.signal }),
    ).rejects.toThrow(E_ABORTED)
    // 给「真被 spawn 了」的实现足够时间暴露痕迹
    await wait(600)
    expect(existsSync(marker)).toBe(false)
    expect(adbChildCount()).toBe(0)
  }, 20_000)

  // ---- Important-3：孙进程 ----
  it('超时 kill 会连带终结孙进程（进程树）', async () => {
    const dir = scriptDir()
    const marker = path.join(dir, 'grandchild-alive.txt')
    const grandchild = path.join(dir, 'grandchild.mjs')
    const parent = path.join(dir, 'parent.mjs')
    writeFileSync(grandchild, [
      "import { writeFileSync } from 'node:fs'",
      'setInterval(() => {}, 1000)',
      'setTimeout(() => { writeFileSync(' + JSON.stringify(marker) + ", 'alive') }, 2500)",
    ].join('\n'))
    writeFileSync(parent, [
      "import { spawn } from 'node:child_process'",
      'spawn(process.execPath, [' + JSON.stringify(grandchild) + '], { stdio: "ignore" })',
      'setInterval(() => {}, 1000)',
    ].join('\n'))

    const client = new AdbClient('ABC123')
    await expect(
      client.run(nodeAdbArgs(parent), { adbPath: SHELL, timeoutMs: 300 }),
    ).rejects.toThrow(E_TIMEOUT)
    await wait(3500)
    expect(existsSync(marker)).toBe(false)
  }, 30_000)

  // ---- Important-4：全局回收 ----
  it('killAllAdbChildren 回收在手子进程并清空登记', async () => {
    const dir = scriptDir()
    const marker = path.join(dir, 'survivor.txt')
    const script = path.join(dir, 'long.mjs')
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs'",
      'setInterval(() => {}, 1000)',
      'setTimeout(() => { writeFileSync(' + JSON.stringify(marker) + ", 'alive') }, 2000)",
    ].join('\n'))

    const client = new AdbClient('ABC123')
    const pending = client.run(nodeAdbArgs(script), { adbPath: SHELL, timeoutMs: 20_000 })
    await wait(300)
    expect(adbChildCount()).toBeGreaterThan(0)

    killAllAdbChildren()
    expect(adbChildCount()).toBe(0)
    await expect(pending).resolves.toBeDefined()

    await wait(2600)
    expect(existsSync(marker)).toBe(false)
  }, 30_000)
})
