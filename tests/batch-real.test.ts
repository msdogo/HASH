import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AdbClient } from '../electron/adb/client'
import { DeviceManager } from '../electron/devices/manager'
import { TransferService } from '../electron/transfer/service'
import { BatchService } from '../electron/batch/service'
import { SHOT_TEMP_DIR } from '../electron/batch/service'
import type { ShellRunner } from '../electron/fs/remote'
import type { TransferTask } from '../src/shared/transfer'
import { E_DEVICE_OFFLINE, E_TIMEOUT } from '../src/shared/errors'

/*
 * 真机批量动作（任务 10 / 简报「步骤 5」）。
 *
 * ===== 跳过必须说话 =====
 * 没有在线设备时在**模块顶层**打印原因并整组 skip。
 * 不能放 beforeAll —— 全员 skip 时 beforeAll 根本不执行，跳过原因永远不会出现，
 * 后面的人只会看到「一个都没跑」而不知道是没插手机还是代码坏了。
 *
 * ===== 设备号绝不硬编码 =====
 * 先读 ADB_TEST_SERIAL，否则从 adb devices 里取第一台 device 状态的设备。
 * 设备离线同样跳过（简报：离线时跳过真机用例并打印原因）。
 *
 * ===== 本机只有 1 台真机，怎么验证「失败隔离」 =====
 * 真机 + 两个注入的假 serial：
 *   - FAKE-OFFLINE：会话表里 status=offline → 服务层必须在发命令前跳过（R5）；
 *   - FAKE-BROKEN：会话表里 status=device，但 client 抛 E_TIMEOUT（模拟命令超时）。
 * 于是同一次批量里既有真成功、也有两种失败，且互不影响。
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
  console.log('[batch-real] 跳过真机用例：没有找到在线设备（ADB_TEST_SERIAL 未设置，adb devices 也没有 device 状态的设备）')
}

/** 设备上的测试目录（用例结束清理）。 */
const REMOTE_DIR = '/sdcard/Download/adbfm-batch-itest'

/** 假设备 serial：离线（服务层必须零命令跳过）。 */
const FAKE_OFFLINE = 'FAKE-OFFLINE-BATCH'

describe.skipIf(skip)('真机批量动作（任务 10 / 规格 §9.3 的四个动作）', () => {
  /** 本地根目录（批量截图落盘的位置，也是本地访问闸门的范围）。 */
  let root = ''
  let transfer: TransferService
  let service: BatchService
  let devices: DeviceManager
  /** 等待传输进终态的登记表（对应 main.ts 的 onTaskSettled）。 */
  const pending = new Map<string, () => void>()
  /** 假 serial 上被记录下来的命令（应当为空）。 */
  const fakeCommands: Array<{ serial: string; args: string[] }> = []

  function shell(command: string): string {
    return execFileSync(ADB, ['-s', SERIAL as string, 'shell', command], {
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
    })
  }

  /** 设备上是否存在某个路径（test -e）。 */
  function remoteExists(target: string): boolean {
    try {
      return shell('test -e ' + quote(target) + ' && echo yes').includes('yes')
    } catch {
      return false
    }
  }

  function quote(value: string): string {
    return "'" + value.split("'").join("'\\''") + "'"
  }

  /** 等到传输任务进入终态（done / failed / canceled），超时抛错。 */
  async function waitTerminal(taskId: string, timeoutMs = 60_000): Promise<TransferTask> {
    const start = Date.now()
    for (;;) {
      const task = transfer.controller.get(taskId)
      if (task !== undefined && (task.status === 'done' || task.status === 'failed' || task.status === 'canceled')) {
        return task
      }
      if (Date.now() - start > timeoutMs) throw new Error('传输没有在 ' + timeoutMs + 'ms 内结束：' + taskId)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  /** 执行所有挂起的清理回调（模拟 main.ts 在终态时的动作），并等它们发出 rm。 */
  async function runPendingCleanup(): Promise<void> {
    const callbacks = [...pending.values()]
    pending.clear()
    for (const callback of callbacks) callback()
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  beforeAll(() => {
    /*
     * 用 realpath 的**长名**作为本地根。
     *
     * Windows 的 temp 目录会给成 8.3 短名（C:\\Users\\ADMINI~1\\...），
     * 而传输服务在 pull 时用 realpath 结果拼目标路径，再拿它跟**原样传入**的根比 ——
     * 短名根 vs 长名目标，isInsideRoot 判定为「根外」（E_OUTSIDE_ROOT）。
     * 那是任务 8/9 已有的边界（生产里根目录来自 homedir()，通常是长名），
     * 本任务不在这里改它，只让测试用与生产一致的形态。
     */
    root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'adbfm-batch-real-')))
    devices = new DeviceManager()
    devices.applySnapshot([
      { serial: SERIAL as string, status: 'device', transport: 'usb' },
      { serial: FAKE_OFFLINE, status: 'offline' },
      { serial: 'FAKE-DEV-BATCH', status: 'device' },
    ])

    transfer = new TransferService({
      adbPath: () => ADB,
      clientFor: (serial) => new AdbClient(serial),
      localRoot: () => root,
      emit: () => { /* 本文件不需要推送 */ },
    })

    service = new BatchService({
      devices,
      clientFor: (serial): ShellRunner => {
        if (serial === SERIAL) return new AdbClient(serial)
        // 假设备：记录命令后抛超时，用来验证「一台失败不影响其余」
        return {
          serial,
          run: async (args: string[]) => {
            fakeCommands.push({ serial, args })
            throw new Error(E_TIMEOUT)
          },
        }
      },
      transfer: transfer.controller,
      localRoot: () => root,
      adbPath: () => ADB,
      pickDirectory: async () => root,
      pickApk: async () => '',
      onTaskSettled: (taskId, callback) => { pending.set(taskId, callback) },
    })

    // 清掉上次崩溃可能留下的残留（设备侧 + 本地）
    try { shell('rm -rf -- ' + quote(REMOTE_DIR)) } catch { /* 不存在是常态 */ }
    try { shell('rm -f ' + SHOT_TEMP_DIR + '/adbfm-shot-*.png') } catch { /* 同上 */ }
    shell('mkdir -p ' + quote(REMOTE_DIR))
  }, 120_000)

  afterAll(async () => {
    // 无论成败都清干净（项目硬要求：不留垃圾）
    try { await runPendingCleanup() } catch { /* 忽略 */ }
    try { shell('rm -rf -- ' + quote(REMOTE_DIR)) } catch { /* 忽略 */ }
    try { shell('rm -f ' + SHOT_TEMP_DIR + '/adbfm-shot-*.png') } catch { /* 忽略 */ }
    transfer.dispose()
    if (root !== '') rmSync(root, { recursive: true, force: true })
  }, 120_000)

  it('批量截图：本地生成真 PNG（魔数校验），设备临时文件已删除', async () => {
    const data = await service.screenshot({ serials: [SERIAL as string] })
    expect(data.results).toHaveLength(1)
    expect(data.results[0]).toMatchObject({ serial: SERIAL, ok: true })
    const taskId = data.results[0].detail
    expect(taskId).toBeTruthy()

    const task = await waitTerminal(taskId as string)
    expect(task.status).toBe('done')

    // 本地确实落了一张 png，且文件头是 PNG 魔数 89 50 4E 47
    const localName = task.dst.split(/[\\/]/).pop() as string
    const localPath = path.join(root, localName)
    expect(existsSync(localPath)).toBe(true)
    const head = readFileSync(localPath).subarray(0, 4)
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47])
    // 一张真实截图不会是空文件
    expect(readFileSync(localPath).length).toBeGreaterThan(1024)

    // 清理后设备上的临时文件必须消失（不能留垃圾）
    await runPendingCleanup()
    const leftovers = shell('ls ' + SHOT_TEMP_DIR + '/adbfm-shot-*.png 2>/dev/null || true').trim()
    expect(leftovers).toBe('')
  }, 180_000)

  it('批量执行命令：真机回显 stdout；离线与超时设备互不影响（失败隔离）', async () => {
    fakeCommands.length = 0
    const data = await service.shell(
      { serials: [SERIAL as string, FAKE_OFFLINE, 'FAKE-DEV-BATCH'] },
      'echo adbfm-ok',
    )

    // R4：结果顺序与入参一致
    expect(data.results.map((item) => item.serial)).toEqual([SERIAL, FAKE_OFFLINE, 'FAKE-DEV-BATCH'])
    // 真机成功并回显 stdout
    expect(data.results[0]).toMatchObject({ ok: true })
    expect(data.results[0].detail).toContain('adbfm-ok')
    // R5：离线设备零命令
    expect(data.results[1]).toMatchObject({ ok: false, code: E_DEVICE_OFFLINE })
    // 假设备抛超时 → 只影响它自己
    expect(data.results[2]).toMatchObject({ ok: false, code: E_TIMEOUT })
    // 离线设备一条命令都没发；假设备恰好收到一条（它确实被尝试了）
    expect(fakeCommands.filter((item) => item.serial === FAKE_OFFLINE)).toEqual([])
    expect(fakeCommands.filter((item) => item.serial === 'FAKE-DEV-BATCH')).toHaveLength(1)
  }, 120_000)

  it('批量推送：1 个文件真推到设备，任务完成后设备上文件存在且大小一致', async () => {
    const name = 'batch 推送 测试.txt'
    const localPath = path.join(root, name)
    const content = 'adbfm batch push ' + 'x'.repeat(1024)
    writeFileSync(localPath, content)

    const data = await service.push({
      serials: [SERIAL as string, FAKE_OFFLINE],
      files: [localPath],
      dstDir: REMOTE_DIR,
    })
    expect(data.results[0]).toMatchObject({ ok: true, detail: '1' })
    expect(data.results[1]).toMatchObject({ ok: false, code: E_DEVICE_OFFLINE })

    // 等这条 push 真正跑完（批量层只负责入队，R2）
    // 只找本次的 push（截图用例留下的 pull 任务还在快照里）
    const queued = transfer.controller
      .snapshot()
      .tasks
      .filter((task) => task.serial === SERIAL && task.direction === 'push')
    expect(queued).toHaveLength(1)
    const task = await waitTerminal(queued[0].id)
    expect(task.status).toBe('done')

    const remotePath = REMOTE_DIR + '/' + name
    expect(remoteExists(remotePath)).toBe(true)
    const remoteSize = Number(shell('stat -c %s ' + quote(remotePath)).trim())
    expect(remoteSize).toBe(Buffer.byteLength(content, 'utf8'))
  }, 180_000)
})
