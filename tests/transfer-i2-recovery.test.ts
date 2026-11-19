import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TransferRunner } from '../electron/transfer/runner'
import { PART_SUFFIX } from '../electron/transfer/atomic'
import { E_ABORTED } from '../src/shared/errors'

/*
 * 审查 I2（数据丢失级）：取消/中断会毁掉已存在的目标文件。
 *
 * 复审系统级实测：中断 push 后设备留 155903007 字节同名截断文件；
 * pull 后本地留 183609456/314572800。覆盖场景下 adb 会先截断目标，
 * 所以「取消一个覆盖传输」= 既没传完、又把原有文件毁了。
 *
 * 修法：先写 目标.adbfm-part，成功后再原子改名。这里用假 client 精确控制
 * 「传到一半就被取消」这个瞬间，断言旧文件逐字节未被破坏。
 */

const dirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'task8-i2-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function md5(file: string): string {
  return createHash('md5').update(readFileSync(file)).digest('hex')
}

describe('I2：pull 取消不得破坏已存在的本地目标文件', () => {
  it('取消后目标文件逐字节不变，且没有 .adbfm-part 残留', async () => {
    const dir = tmpDir()
    const target = path.join(dir, 'existing.bin')
    // 用户已有的宝贵文件
    writeFileSync(target, 'PRECIOUS-OLD-CONTENT-' + 'x'.repeat(500))
    const before = md5(target)

    // 假 adb：pull 时先写一半到 part 文件，然后一直挂着等取消
    const client = {
      serial: 'S1',
      run: async (args: string[], opts: { signal?: AbortSignal; timeoutMs?: number }) => {
        if (args[0] === 'shell' && args[1].startsWith('stat')) {
          return { code: 0, stdout: '0', stderr: '' }
        }
        if (args[0] === 'pull') {
          // 模拟「已经写了一部分」的临时文件
          const part = args[2]
          writeFileSync(part, 'HALF-WRITTEN')
          // 挂住直到被 abort
          await new Promise<void>((resolve) => {
            if (opts.signal?.aborted === true) { resolve(); return }
            opts.signal?.addEventListener('abort', () => { resolve() })
          })
          throw new Error(E_ABORTED)
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }

    const runner = new TransferRunner({
      adbPath: () => 'C:/adb.exe',
      clientFor: () => client as never,
      pollMs: 5,
      sleep: async () => { await new Promise((r) => setTimeout(r, 1)) },
    })

    const controller = new AbortController()
    const run = runner.createPull('t1', 'S1', '/sdcard/x.bin', target, 1000)
    const pending = runner.run(run, { signal: controller.signal, onProgress: () => {} })
    // 等临时文件出现（说明传输已经开始）
    const part = target + PART_SUFFIX
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && !existsSync(part)) {
      await new Promise((r) => setTimeout(r, 10))
    }
    controller.abort()
    const result = await pending

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(E_ABORTED)
    // 核心断言：原文件逐字节未变
    expect(existsSync(target)).toBe(true)
    expect(md5(target)).toBe(before)
    // 临时文件必须清理掉
    expect(existsSync(part)).toBe(false)
  })

  it('成功时目标文件被新内容替换，临时文件不残留', async () => {
    const dir = tmpDir()
    const target = path.join(dir, 'existing.bin')
    writeFileSync(target, 'OLD')

    const client = {
      serial: 'S1',
      run: async (args: string[]) => {
        if (args[0] === 'shell' && args[1].startsWith('stat')) {
          return { code: 0, stdout: '0', stderr: '' }
        }
        if (args[0] === 'pull') {
          writeFileSync(args[2], 'NEW-CONTENT')
          return { code: 0, stdout: '', stderr: '/sdcard/x.bin: 1 file pulled, 0 skipped. 1.0 MB/s (11 bytes in 0.001s)\r\n' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }

    const runner = new TransferRunner({
      adbPath: () => 'C:/adb.exe',
      clientFor: () => client as never,
      pollMs: 5,
      sleep: async () => { await new Promise((r) => setTimeout(r, 1)) },
    })
    const controller = new AbortController()
    const run = runner.createPull('t2', 'S1', '/sdcard/x.bin', target, 11)
    const result = await runner.run(run, { signal: controller.signal, onProgress: () => {} })

    expect(result.ok).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('NEW-CONTENT')
    expect(existsSync(target + PART_SUFFIX)).toBe(false)
  })
})

describe('I2：push 走临时名 + mv 改名', () => {
  it('push 的命令目标是 .adbfm-part，成功后执行 mv 到目标名', async () => {
    const dir = tmpDir()
    const local = path.join(dir, 'src.bin')
    writeFileSync(local, 'data')
    const calls: string[][] = []

    const client = {
      serial: 'S1',
      run: async (args: string[]) => {
        calls.push(args)
        if (args[0] === 'shell' && args[1].startsWith('stat')) {
          return { code: 0, stdout: '0', stderr: '' }
        }
        if (args[0] === 'push') {
          return { code: 0, stdout: '', stderr: 'src.bin: 1 file pushed, 0 skipped. 1.0 MB/s (4 bytes in 0.001s)\r\n' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }

    const runner = new TransferRunner({
      adbPath: () => 'C:/adb.exe',
      clientFor: () => client as never,
      pollMs: 5,
      sleep: async () => { await new Promise((r) => setTimeout(r, 1)) },
    })
    const controller = new AbortController()
    const run = runner.createPush('t3', 'S1', local, '/sdcard/Download/dst.bin', 4)
    const result = await runner.run(run, { signal: controller.signal, onProgress: () => {} })

    expect(result.ok).toBe(true)
    // push 的落点必须是临时名
    const pushCall = calls.find((c) => c[0] === 'push')
    expect(pushCall?.[2]).toBe('/sdcard/Download/dst.bin' + PART_SUFFIX)
    // 之后必须有一次 mv 把临时名改成正式名
    const mvCall = calls.find((c) => c[0] === 'shell' && c[1].includes('mv -f'))
    expect(mvCall).toBeDefined()
    expect(mvCall?.[1]).toContain('/sdcard/Download/dst.bin' + PART_SUFFIX)
  })

  it('push 被取消时执行 rm 清理临时文件（不碰目标名）', async () => {
    const dir = tmpDir()
    const local = path.join(dir, 'src.bin')
    writeFileSync(local, 'data')
    const calls: string[][] = []

    const client = {
      serial: 'S1',
      run: async (args: string[], opts: { signal?: AbortSignal }) => {
        calls.push(args)
        if (args[0] === 'shell' && args[1].startsWith('stat')) {
          return { code: 0, stdout: '0', stderr: '' }
        }
        if (args[0] === 'push') {
          await new Promise<void>((resolve) => {
            if (opts.signal?.aborted === true) { resolve(); return }
            opts.signal?.addEventListener('abort', () => { resolve() })
          })
          throw new Error(E_ABORTED)
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const runner = new TransferRunner({
      adbPath: () => 'C:/adb.exe',
      clientFor: () => client as never,
      pollMs: 5,
      sleep: async () => { await new Promise((r) => setTimeout(r, 1)) },
    })
    const controller = new AbortController()
    const run = runner.createPush('t4', 'S1', local, '/sdcard/Download/dst.bin', 4)
    const pending = runner.run(run, { signal: controller.signal, onProgress: () => {} })
    await new Promise((r) => setTimeout(r, 30))
    controller.abort()
    const result = await pending

    expect(result.ok).toBe(false)
    const rmCall = calls.find((c) => c[0] === 'shell' && c[1].includes('rm -f'))
    expect(rmCall).toBeDefined()
    // 清理的是临时名，不是目标名
    expect(rmCall?.[1]).toContain('/sdcard/Download/dst.bin' + PART_SUFFIX)
  })
})
