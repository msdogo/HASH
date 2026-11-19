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
})
