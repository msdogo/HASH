import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TransferService } from '../electron/transfer/service'
import { AdbClient } from '../electron/adb/client'

/*
 * 审查 C1 的端到端用例：不注入 runner、不注入 client，
 * 走 TransferService -> TransferRunner -> AdbClient -> 真实 spawn 的完整装配路径。
 * 这是复审点名的「单测全绿、真实应用必挂」那类缺陷的唯一有效防线。
 *
 * 假 adb 为什么必须是真 .exe（两种更省事的办法都实测失败）：
 *   1. adbPath 指向 .cmd：Node 的 child_process.spawn 在 Windows 上不走 cmd.exe，EINVAL/ENOENT。
 *   2. adbPath 指向 node.exe + NODE_OPTIONS shim：AdbClient 永远传 -s <serial>，
 *      而 node.exe 把 -s 当成自己的选项，报 bad option: -s 直接退出（EXIT=126）。
 * 所以用 csc 编译一个真 .exe（源码 .fakeadbfiles/FakeAdb.cs），它能接受任意 argv。
 */

const SOH = String.fromCharCode(1)
const FAKE_DIR = path.resolve(import.meta.dirname, '..', '.fakeadbfiles')
const FAKE_EXE = path.join(FAKE_DIR, 'fake-adb.exe')
const FAKE_SRC = path.join(FAKE_DIR, 'FakeAdb.cs')

/**
 * 假 adb 的编译产物不入库（5KB 二进制进 git 不划算），
 * 所以这里**自举**：缺 exe 就用 Windows 自带的 csc 现场编译源码。
 *
 * 为什么要自举而不是「缺了就跳过」：一条永远跳过、永远绿色的安全网，
 * 比没有安全网更危险 —— 后续任务会以为 C1 有端到端防护。
 * 找不到 csc 时（非 Windows / 精简系统）才跳过，并**大声说明**原因。
 */
function ensureFakeAdb(): { ok: boolean; reason?: string } {
  if (existsSync(FAKE_EXE)) return { ok: true }
  if (process.platform !== 'win32') return { ok: false, reason: '非 Windows，未提供假 adb 可执行文件' }
  const csc = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  if (!existsSync(csc)) return { ok: false, reason: '找不到 csc.exe，无法编译假 adb' }
  const result = spawnSync(csc, ['/nologo', '/out:' + FAKE_EXE, FAKE_SRC], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  })
  if (!existsSync(FAKE_EXE)) {
    return { ok: false, reason: 'csc 编译假 adb 失败：' + (result.stderr ?? '').slice(0, 200) }
  }
  return { ok: true }
}

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'task8-c1e2e-'))
  dirs.push(dir)
  return dir
}

function readCalls(logPath: string): string[][] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split(String.fromCharCode(10))
    .filter((line) => line !== '')
    .map((line) => line.split(SOH))
}

const fakeStatus = ensureFakeAdb()
const hasFake = fakeStatus.ok
if (!hasFake) {
  // 跳过必须说话（项目约定）：原因打在模块顶层，而不是藏在 beforeAll 里
  console.log('[c1-e2e] 跳过 C1 端到端用例：' + (fakeStatus.reason ?? '未知原因'))
}

describe.skipIf(!hasFake)('C1 端到端：真实装配路径能真正 spawn 到 adb', () => {
  it('构造时 adb 路径为空、之后就绪 -> 传输成功，且 spawn 用的是就绪后的路径', async () => {
    const dir = tmpDir()
    const logPath = path.join(dir, 'argv.log')
    process.env.FAKE_ADB_LOG = logPath
    try {
      const local = path.join(dir, 'upload.bin')
      writeFileSync(local, Buffer.alloc(1024))

      let adbPath = ''
      const svc = new TransferService({
        adbPath: () => adbPath,
        clientFor: (serial) => new AdbClient(serial),
        emit: () => {},
      })
      adbPath = FAKE_EXE

      const task = await svc.enqueue({ serial: 'FAKE123', direction: 'push', src: local, dstDir: '/sdcard/Download' })
      const deadline = Date.now() + 30000
      while (Date.now() < deadline && svc.manager.get(task.id)?.status === 'running') {
        await new Promise((r) => setTimeout(r, 20))
      }
      await new Promise((r) => setTimeout(r, 200))

      const final = svc.manager.get(task.id)
      expect(final?.error).toBeUndefined()
      expect(final?.status).toBe('done')

      const calls = readCalls(logPath)
      const pushCall = calls.find((args) => args.includes('push'))
      expect(pushCall, '假 adb 从未被调用（说明路径没传到 spawn）').toBeDefined()
      expect(pushCall).toContain('-s')
      expect(pushCall).toContain('FAKE123')
      expect(pushCall?.join(' ')).toContain('.adbfm-part')
    } finally {
      delete process.env.FAKE_ADB_LOG
    }
  }, 60_000)

  it('adb 始终未就绪 -> 明确 E_ADB_NOT_FOUND，且从未 spawn', async () => {
    const dir = tmpDir()
    const logPath = path.join(dir, 'argv.log')
    process.env.FAKE_ADB_LOG = logPath
    try {
      const local = path.join(dir, 'upload.bin')
      writeFileSync(local, Buffer.alloc(64))
      const svc = new TransferService({
        adbPath: () => '',
        clientFor: (serial) => new AdbClient(serial),
        emit: () => {},
      })
      const task = await svc.enqueue({ serial: 'FAKE123', direction: 'push', src: local, dstDir: '/sdcard/Download' })
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && svc.manager.get(task.id)?.status === 'running') {
        await new Promise((r) => setTimeout(r, 20))
      }
      await new Promise((r) => setTimeout(r, 50))

      const final = svc.manager.get(task.id)
      expect(final?.status).toBe('failed')
      expect(final?.error).toBe('E_ADB_NOT_FOUND')
      expect(readCalls(logPath)).toEqual([])
    } finally {
      delete process.env.FAKE_ADB_LOG
    }
  }, 15_000)
})
