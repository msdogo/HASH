import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TransferRunner } from '../electron/transfer/runner'
import { createTransferRunner } from '../electron/transfer/runner'

/*
 * 裁决 9：真机集成用例（1 条 push + 1 条 pull，文件名含中文与空格）。
 *
 * 跳过必须说话：模块顶层打印原因（不能放 beforeAll —— 全员 skip 时 beforeAll 不执行）。
 * 设备号绝不硬编码：先是 ADB_TEST_SERIAL，否则从 adb devices 自动取第一台在线设备。
 */

const ADB = process.env.ADB_PATH ?? 'adb'

function resolveSerial(): string | null {
  const fromEnv = process.env.ADB_TEST_SERIAL
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  try {
    const out = execFileSync(ADB, ['devices'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    for (const line of out.split(/\r?\n/)) {
      const match = /^(\S+)\s+device\b/.exec(line.trim())
      if (match !== null) return match[1]
    }
  } catch {
    return null
  }
  return null
}

const SERIAL = resolveSerial()
const skip = SERIAL === null
if (skip) {
  console.log('[transfer-real] 跳过真机集成用例：没有找到在线设备（ADB_TEST_SERIAL 未设置，adb devices 也没有 device 状态的设备）')
}

/** 设备侧临时目录（用例结束清理）。 */
const REMOTE_DIR = '/sdcard/Download/adb-fm-itest'

describe.skipIf(skip)('真机传输（裁决 9）', () => {
  let dir = ''
  let adb = ''
  let runner: TransferRunner

  function shell(command: string): string {
    return execFileSync(ADB, ['-s', SERIAL as string, 'shell', command], {
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
    })
  }

  beforeAll(() => {
    // 本地测试目录：走 mkdtemp 而不是项目里，避免污染仓库
    dir = mkdtempSync(path.join(tmpdir(), 'adb-fm-itest-'))
    adb = ADB
    runner = createTransferRunner({ adbPath: adb })
    try { shell('rm -rf ' + REMOTE_DIR) } catch { /* 目录不存在是常态 */ }
    shell('mkdir -p ' + REMOTE_DIR)
  }, 60_000)

  afterAll(() => {
    try { shell('rm -rf ' + REMOTE_DIR) } catch { /* 忽略清理失败 */ }
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
  })

  it('push：文件名含中文与空格，进度单调递增，完成后大小与内容一致', async () => {
    const name = '中文 文件名 测试.bin'
    const localPath = path.join(dir, name)
    // 8MB 可压缩内容，足够跑出多次轮询；不必 50MB 以免拖慢常规测试
    const payload = Buffer.alloc(8 * 1024 * 1024)
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251
    writeFileSync(localPath, payload)

    const remotePath = REMOTE_DIR + '/' + name
    const task = runner.createPush('itest-push', SERIAL as string, localPath, remotePath, payload.length)
    const progressSamples: Array<{ doneBytes: number; totalBytes: number | null }> = []
    const controller = new AbortController()
    const result = await runner.run(task, {
      signal: controller.signal,
      onProgress: (doneBytes, totalBytes) => { progressSamples.push({ doneBytes, totalBytes }) },
    })

    expect(result.ok).toBe(true)
    // 反向校验设备侧大小与内容（push 成功不代表内容对）
    const remoteSize = Number(shell('stat -c %s ' + JSON.stringify(remotePath)).trim())
    expect(remoteSize).toBe(payload.length)
    // 设备上取回校验和
    const remoteSum = shell('md5sum ' + JSON.stringify(remotePath)).trim().split(/\s+/)[0]
    const localSum = execFileSync('md5sum', [localPath], { encoding: 'utf8', windowsHide: true })
      .trim().split(/\s+/)[0]
    expect(remoteSum).toBe(localSum)
    // 进度必须单调递增（允许相等）
    for (let i = 1; i < progressSamples.length; i++) {
      expect(progressSamples[i].doneBytes).toBeGreaterThanOrEqual(progressSamples[i - 1].doneBytes)
    }
  }, 180_000)

  it('pull：文件名含中文与空格，拉回后大小与内容一致', async () => {
    const name = '下载 中文 文件.bin'
    const remotePath = REMOTE_DIR + '/' + name
    const source = Buffer.alloc(6 * 1024 * 1024)
    for (let i = 0; i < source.length; i++) source[i] = (i * 7) % 251
    const sourceLocal = path.join(dir, 'source-' + name)
    writeFileSync(sourceLocal, source)
    // 先用 adb 放上去（直接用 adb，不依赖被测代码）
    execFileSync(ADB, ['-s', SERIAL as string, 'push', sourceLocal, remotePath], {
      windowsHide: true, timeout: 120_000, stdio: 'ignore',
    })

    const localOut = path.join(dir, 'pulled-' + name)
    const task = runner.createPull('itest-pull', SERIAL as string, remotePath, localOut, source.length)
    const progressSamples: number[] = []
    const controller = new AbortController()
    const result = await runner.run(task, {
      signal: controller.signal,
      onProgress: (doneBytes) => { progressSamples.push(doneBytes) },
    })

    expect(result.ok).toBe(true)
    expect(existsSync(localOut)).toBe(true)
    expect(statSync(localOut).size).toBe(source.length)
    expect(readFileSync(localOut).equals(source)).toBe(true)
    for (let i = 1; i < progressSamples.length; i++) {
      expect(progressSamples[i]).toBeGreaterThanOrEqual(progressSamples[i - 1])
    }
  }, 180_000)

  /*
   * 审查 I2：取消一个「覆盖已有文件」的传输，**旧文件必须原样还在**。
   *
   * 这是复审实测抓到的数据丢失级缺陷：adb 会先截断目标再写，
   * 所以修前取消 = 既没传完、又把原有文件毁了。
   * 现在走临时名 + 原子改名，目标在成功前完全不被碰。
   */
  it('I2：覆盖传输中途取消后，设备上的旧文件内容与大小完全不变，且无 .adbfm-part 残留', async () => {
    const name = '覆盖 旧文件 测试.bin'
    const remotePath = REMOTE_DIR + '/' + name

    // 1) 在设备上造一个「宝贵旧文件」
    const oldLocal = path.join(dir, 'old-' + name)
    writeFileSync(oldLocal, 'PRECIOUS-OLD-' + 'A'.repeat(4096))
    execFileSync(ADB, ['-s', SERIAL as string, 'push', oldLocal, remotePath], {
      windowsHide: true, timeout: 120_000, stdio: 'ignore',
    })
    const beforeMd5 = shell('md5sum ' + JSON.stringify(remotePath)).trim().split(/\s+/)[0]
    const beforeSize = Number(shell('stat -c %s ' + JSON.stringify(remotePath)).trim())
    expect(beforeSize).toBeGreaterThan(0)

    // 2) 传一个不可压缩的大文件到同一目标，中途取消
    const bigLocal = path.join(dir, 'big-overwrite.bin')
    const big = Buffer.alloc(120 * 1024 * 1024)
    // 伪随机，避免被 adb 压缩掉而瞬间传完
    let seed = 12345
    for (let i = 0; i < big.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      big[i] = seed & 0xff
    }
    writeFileSync(bigLocal, big)

    const controller = new AbortController()
    const task = runner.createPush('itest-overwrite', SERIAL as string, bigLocal, remotePath, big.length)
    const running = runner.run(task, {
      signal: controller.signal,
      onProgress: (done) => {
        // 传到 25MB 以上再取消：确保确实写了一部分
        if (done > 25 * 1024 * 1024 && !controller.signal.aborted) controller.abort()
      },
    })
    const result = await running
    expect(result.ok).toBe(false)

    // 3) 给清理一点时间（rm 是另一条 adb 命令）
    await new Promise((r) => setTimeout(r, 1500))

    // 核心断言：旧文件逐字节未变
    const afterMd5 = shell('md5sum ' + JSON.stringify(remotePath)).trim().split(/\s+/)[0]
    const afterSize = Number(shell('stat -c %s ' + JSON.stringify(remotePath)).trim())
    expect(afterSize).toBe(beforeSize)
    expect(afterMd5).toBe(beforeMd5)

    // 不得残留临时文件
    const listing = shell('ls -1 ' + JSON.stringify(REMOTE_DIR)).trim()
    expect(listing).not.toContain('.adbfm-part')
  }, 240_000)
})
