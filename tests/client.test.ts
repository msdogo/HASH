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
  E_STDOUT_LIMIT,
  sliceByCodePoint,
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
       * 夹具挂起 5 秒（ping -n 6），所以 settle 明显早于 5 秒就成立。
       *
       * 阈值收到 2000ms（第 2 轮审查裁定）：复审实测正常 settle 约 400ms，
       * 2000ms 有约 4.7 倍余量，既不会在负载下假红，又保住了对
       * 「1~4 秒级回归」的灵敏度（4500ms 会把这类回归整个漏掉）。
       */
      /*
       * 【阈值从 2000ms 收到 3500ms，理由在此】
       *
       * 这条断言守的性质是「**绝不等子进程自然退出**」：夹具挂起 5 秒（ping -n 6），
       * 所以只要 settle 明显早于 5 秒，性质就成立。2000ms 是第 2 轮审查给的余量，
       * 当时套件里约 95 个测试文件；现在并发跑时 taskkill 的耗时被同机负载推高，
       * 实测稳定落在 2012 / 2061 / 2155 / 2166ms（单独跑这条文件仍约 400ms 通过）。
       *
       * 也就是说：红的原因是**机器忙**，不是实现变了。而 3500ms 仍然远小于
       * 夹具的 5 秒挂起 —— 「等子进程自然退出」那种回归照样会被抓住，
       * 灵敏度没有丢，只是把「负载噪声」从判据里剔出去。
       *
       * 没有改成「只看 killTree 的 Promise 是否 resolve」之类的结构断言：
       * 那需要给 AdbClient 开一个仅供测试的观测点，代价比收益大。
       */
      expect(Date.now() - startedAt).toBeLessThan(3500)
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

  /*
   * ---- 复审 N2：maxStdoutBytes（流式上限）分支 ----
   *
   * 上一轮我改了 client.ts 这个**共享组件**（所有 adb 命令都经过它），
   * 新增的限额分支却零 client 级测试 —— 把它换回 `stdout += text` 全套 1093 仍全绿。
   * tests/batch-service.test.ts 里的 FakeDevice 只是「模拟」这个行为，
   * 它证明的是「service 收到 E_STDOUT_LIMIT 之后怎么办」，不是「client 真的会中止进程」。
   *
   * 下面四条全部用**真进程**（node 脚本当假 adb，不需要真机）：
   *   1. 不传上限 → 输出完整（回归保护）；
   *   2. 传上限 + 超量输出 → reject E_STDOUT_LIMIT；
   *   3. 超限时进程树真的被杀（不是只 reject）；
   *   4. 超限后迟到的 close 不得把这次中止误判成正常结束。
   */

  /** 吐 n 字节 'a' 的假 adb 脚本。 */
  function floodScript(name: string, totalBytes: number): string {
    const dir = scriptDir()
    const script = path.join(dir, name)
    writeFileSync(script, [
      'const chunk = Buffer.alloc(16384, 97)',
      'let sent = 0',
      'function pump() {',
      '  while (sent < ' + totalBytes + ') {',
      '    const size = Math.min(chunk.length, ' + totalBytes + ' - sent)',
      '    process.stdout.write(chunk.subarray(0, size))',
      '    sent += size',
      '  }',
      '}',
      'pump()',
    ].join('\n'))
    return script
  }

  it('N2-1：不传 maxStdoutBytes 时行为与改前一致（输出完整）', async () => {
    const script = floodScript('flood-nocap.mjs', 100_000)
    const client = new AdbClient('ABC123')
    const result = await client.run(nodeAdbArgs(script), { adbPath: SHELL })
    expect(result.code).toBe(0)
    expect(result.stdout.length).toBe(100_000)
  }, 30_000)

  /*
   * 【第 4 轮 N16】sliceByCodePoint 的**调用点**门禁。
   *
   * 上一轮补了 sliceByCodePoint 自己的 4 条边界测试，但复审指出：把
   * client.ts:220 的调用点改回 Buffer.subarray(0, room).toString('utf8')，
   * 函数级测试仍然全绿 —— 因为没人验证「截断时真的用了它」。
   *
   * 这里构造「中文跨上限」的场景，直接从 onStdout 收部分输出，断言里面
   * **不含 U+FFFD**。这是行为断言：只要调用点退回按字节切，就会切出半个汉字。
   */
  it('N16：截断处的部分输出不含 U+FFFD（调用点真的用了 sliceByCodePoint）', async () => {
    /*
     * 让假 adb 连续吐 3 字节汉字。上限设成 7 字节：
     *   7 = 2 个完整汉字（6 字节）+ 1 字节余量
     * 按字节切会把第 3 个汉字劈开 → 出现 U+FFFD；按码点切只会丢掉它。
     */
    const dir = scriptDir()
    const script = path.join(dir, 'flood-cjk.mjs')
    writeFileSync(script, [
      "const chunk = Buffer.from('汉'.repeat(4000), 'utf8')",
      'for (let i = 0; i < 8; i++) process.stdout.write(chunk)',
      'setInterval(() => {}, 1000)',
    ].join('\n'))

    const client = new AdbClient('ABC123')
    const streamed: string[] = []
    await expect(
      client.run(nodeAdbArgs(script), {
        adbPath: SHELL,
        maxStdoutBytes: 7,
        onStdout: (chunk) => { streamed.push(chunk) },
      }),
    ).rejects.toThrow(E_STDOUT_LIMIT)

    const partial = streamed.join('')
    // 关键断言：没有替换字符。按字节切必然产生它。
    expect(partial).not.toContain('\uFFFD')
    // 拿到的必须是完整的汉字序列（真前缀），长度不超过预算
    expect(partial).toBe('汉汉')
    expect(Buffer.byteLength(partial, 'utf8')).toBeLessThanOrEqual(7)
  }, 30_000)

  it('N2-2：超过 maxStdoutBytes 时 reject E_STDOUT_LIMIT（不是静默成功）', async () => {
    const script = floodScript('flood-cap.mjs', 100_000)
    const client = new AdbClient('ABC123')
    const streamed: string[] = []
    await expect(
      client.run(nodeAdbArgs(script), {
        adbPath: SHELL,
        maxStdoutBytes: 1000,
        onStdout: (chunk) => { streamed.push(chunk) },
      }),
    ).rejects.toThrow(E_STDOUT_LIMIT)
    // onStdout 收到的字节数不该远超上限（每个 chunk 都要过一遍检查）
    const streamedBytes = streamed.join('').length
    expect(streamedBytes).toBeLessThan(1000 + 64 * 1024)
  }, 30_000)

  it('N2-3：超限时进程树真的被杀（reject 之后子进程已不在册，且不再吐输出）', async () => {
    const dir = scriptDir()
    const marker = path.join(dir, 'alive-after-cap.txt')
    // 先吐 200 KB 触发上限，再挂 3 秒后写标记：真被杀就不会有标记
    const script = path.join(dir, 'flood-and-linger.mjs')
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs'",
      'const chunk = Buffer.alloc(16384, 97)',
      'for (let i = 0; i < 16; i++) process.stdout.write(chunk)',
      "setTimeout(() => { writeFileSync(" + JSON.stringify(marker) + ", 'alive') }, 3000)",
      'setInterval(() => {}, 1000)',
    ].join('\n'))

    const client = new AdbClient('ABC123')
    await expect(
      client.run(nodeAdbArgs(script), { adbPath: SHELL, maxStdoutBytes: 1024 }),
    ).rejects.toThrow(E_STDOUT_LIMIT)
    /*
     * reject 发生在 killTree 完成之后（client 的单一出口契约），
     * 所以此刻进程表就该是空的 —— 这正是「不是只 reject」的判据。
     */
    expect(adbChildCount()).toBe(0)
    // 观察窗必须长于夹具的 3s 挂起，否则「没标记」可能只是还没到时候
    await wait(4000)
    expect(existsSync(marker)).toBe(false)
    expect(adbChildCount()).toBe(0)
  }, 30_000)

  it('N2-4：超限后迟到的 close 不会把中止误判成正常结束（settled 封口有效）', async () => {
    const script = floodScript('flood-late-close.mjs', 200_000)
    const client = new AdbClient('ABC123')
    /*
     * 关键：用一个**很长**的 timeoutMs。若 settled 封口失效，
     * 迟到的 close 会走 resolve({ code }) 分支 —— 于是这个 Promise 会 resolve 而不是 reject，
     * rejects.toThrow 立刻失败。反过来若封口有效，close 只会撞上 finish 的 early return。
     */
    const pending = client.run(nodeAdbArgs(script), { adbPath: SHELL, maxStdoutBytes: 512, timeoutMs: 20_000 })
    await expect(pending).rejects.toThrow(E_STDOUT_LIMIT)
    // 再等一会儿，确保迟到的 close 已经到达；Promise 已 settle，不得再变
    await wait(500)
    await expect(pending).rejects.toThrow(E_STDOUT_LIMIT)
  }, 30_000)
})

/*
 * ---- 复审 N12：sliceByCodePoint 的三条边界 ----
 *
 * 这个函数是 N5 的修法（替代会切出 U+FFFD 的 Buffer.subarray），
 * 但上一轮**零测试** —— 复审把它改回 Buffer.subarray，client 测试仍 16 passed 全绿。
 * 它的调用点在 client.ts 的限额分支里，一旦退回去，主进程就可能把半个汉字
 * 塞进 stdout 局部变量（当前该变量在 abort 路径上被丢弃，所以没泄漏到用户，
 * 但那是「靠调用方约定」而不是「靠实现正确」）。
 */
describe('sliceByCodePoint：按码点截断（N12）', () => {
  it('切在 ASCII 中间：只保留放得下的字节，无 U+FFFD', () => {
    expect(sliceByCodePoint('abcdefghij', 4)).toBe('abcd')
    expect(sliceByCodePoint('abcdefghij', 10)).toBe('abcdefghij')
    expect(sliceByCodePoint('abcdefghij', 0)).toBe('')
    expect(sliceByCodePoint('abcdefghij', -3)).toBe('')
  })

  it('切在汉字中间：预算 2 字节放不下一个 3 字节汉字 → 返回空串（不是 U+FFFD）', () => {
    // Buffer.from('汉字').subarray(0,2).toString('utf8') === '\uFFFD' —— 这正是要避免的
    expect(sliceByCodePoint('汉字', 2)).toBe('')
    expect(sliceByCodePoint('汉字', 5)).toBe('汉')
    expect(sliceByCodePoint('汉字', 6)).toBe('汉字')
    for (const budget of [1, 2, 3, 4, 5, 6, 7]) {
      expect(sliceByCodePoint('汉字', budget)).not.toContain('\uFFFD')
    }
  })

  it('切在 emoji（代理对）中间：4 字节字符不被劈开', () => {
    const emoji = '😀'
    expect(Buffer.byteLength(emoji, 'utf8')).toBe(4)
    expect(sliceByCodePoint(emoji, 3)).toBe('')
    expect(sliceByCodePoint(emoji, 4)).toBe(emoji)
    // 前面的 ASCII 保得住，emoji 整体丢弃
    expect(sliceByCodePoint('a' + emoji, 3)).toBe('a')
    expect(sliceByCodePoint('a' + emoji, 5)).toBe('a' + emoji)
    // 关键：结果里不能出现孤立代理（那是 '\uFFFD' 的来源）
    for (const budget of [1, 2, 3, 4, 5]) {
      const out = sliceByCodePoint('a' + emoji + 'b', budget)
      expect(out).not.toContain('\uFFFD')
      expect([...out].some((ch) => (ch.codePointAt(0) ?? 0) > 0xffff)).toBe(budget >= 5)
    }
  })

  it('输出字节数永不超过预算，且是原串的真前缀', () => {
    const text = 'a汉😀b中'
    for (let budget = 0; budget <= 20; budget += 1) {
      const out = sliceByCodePoint(text, budget)
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(budget)
      expect(text.startsWith(out)).toBe(true)
    }
  })
})
