import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AdbClient } from '../electron/adb/client'
import { DeviceManager } from '../electron/devices/manager'
import { TransferService } from '../electron/transfer/service'
import {
  BatchService,
  SHOT_FALLBACK_DIR,
  SHOT_PREFIX,
  SHOT_TEMP_DIR,
  deviceShotDir,
} from '../electron/batch/service'
import type { ShellRunner } from '../electron/fs/remote'
import type { TransferTask } from '../src/shared/transfer'
import { E_DEVICE_OFFLINE, E_TIMEOUT } from '../src/shared/errors'
import { acquireDeviceLock, deviceSkipMessage, resolveSerial } from './device-lock'

/*
 * 真机批量动作（任务 10 / 简报「步骤 5」）。
 *
 * ===== 跳过必须说话 =====
 * 没有在线设备时在**模块顶层**打印原因并整组 skip。
 * 不能放 beforeAll —— 全员 skip 时 beforeAll 根本不执行，跳过原因永远不会出现。
 *
 * ===== 设备号绝不硬编码 =====
 * 先读 ADB_TEST_SERIAL，否则从 adb devices 里取第一台 device 状态的设备。
 *
 * ===== 本机只有 1 台真机，怎么验证「失败隔离」 =====
 * 真机 + 两个注入的假 serial（离线 / 抛超时），一次批量里同时有真成功与两种失败。
 *
 * ===== 复审 I1 / I2 的真机验证 =====
 * I1：dispose() 之后设备上**残留数必须为 0**（任务不结算的出口）；
 * I2：截图落到 /sdcard/.adbfm（隐藏目录），成功后该文件已删。
 */

const ADB = process.env.ADB_PATH ?? 'adb'

/*
 * 设备锁（N17）：batch / drag / ops / transfer 四个真机文件共用同一把
 * `adbfm-device-<serial>.lock`，默认并行的 `npx vitest run` 里它们互斥，
 * 不再互相删对方的临时文件（N14 的根因）。
 *
 * 锁的实现、陈旧判定、跳过措辞都在 tests/device-lock.ts：
 * 文件名只允许有一处定义 —— N17 的病根正是「文件名只对 batch-real 成立」。
 *
 * 必须在**模块顶层**抢（与 SERIAL 解析同级）：放在 beforeAll 里就晚了 ——
 * 那时临时目录、TransferService、BatchService 都已经建好。
 */
const SERIAL = resolveSerial()
const lockRelease = SERIAL === null ? null : acquireDeviceLock(SERIAL, 'batch-real')
const skip = SERIAL === null || lockRelease === null
if (skip) {
  // 三种原因（无设备 / serial 不在线 / 撞锁）必须能区分；模块顶层打印，
  // 不能放 beforeAll —— 全员 skip 时 beforeAll 根本不执行。
  console.log(deviceSkipMessage('batch-real', SERIAL, lockRelease))
}

/** 设备上的测试目录（用例结束清理）。 */
const REMOTE_DIR = '/sdcard/Download/adbfm-batch-itest'
/** 假设备 serial：离线（服务层必须零命令跳过）。 */
const FAKE_OFFLINE = 'FAKE-OFFLINE-BATCH'

describe.skipIf(skip)('真机批量动作（任务 10 / 规格 §9.3 的四个动作）', () => {
  let root = ''
  let transfer: TransferService
  let service: BatchService
  let devices: DeviceManager
  /** 等待传输进终态的登记表（对应 main.ts 的 onTaskSettled 接线）。 */
  const pending = new Map<string, () => void>()
  const fakeCommands: Array<{ serial: string; args: string[] }> = []

  function shell(command: string): string {
    return execFileSync(ADB, ['-s', SERIAL as string, 'shell', command], {
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
    })
  }

  function quote(value: string): string {
    return "'" + value.split("'").join("'\\''") + "'"
  }

  /** 设备上是否存在某个路径。 */
  function remoteExists(target: string): boolean {
    try {
      return shell('test -e ' + quote(target) + ' && echo yes').includes('yes')
    } catch {
      return false
    }
  }

  /**
   * 临时截图目录下的残留数（I1 的「残留数」判据）。
   *
   * 【N3】现在每台设备一个子目录，所以要递归数：find 找不到目录时也会正常返回，
   * 用 wc -l 而不是 grep -c（后者在 0 条时不输出）。
   */
  function leftoverShots(dir: string): number {
    const out = shell(
      'find ' + quote(dir) + ' -name ' + quote(SHOT_PREFIX + '*.png') + ' 2>/dev/null | wc -l',
    ).trim()
    return Number(out === '' ? '0' : out)
  }

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

  /**
   * 轮询等条件成立（【N14】）。
   *
   * 为什么不能用固定 sleep：真机上 rm 是 fire-and-forget 的子进程，
   * 落到设备上要多久取决于机器负载。固定 1500ms 在本机空闲时够用，
   * 但复审把「真机用例」与「全量测试」并跑时两边各红一条（负载竞态）。
   *
   * 轮询把「等多久」交给事实本身：条件满足立刻返回，最坏等满 timeout。
   * 断言强度没降（超时仍判失败），只是不再赌固定的那 1.5 秒。
   */
  async function waitUntil(
    check: () => boolean | Promise<boolean>,
    what: string,
    timeoutMs = 15_000,
    intervalMs = 100,
  ): Promise<void> {
    const start = Date.now()
    for (;;) {
      if (await check()) return
      if (Date.now() - start > timeoutMs) {
        throw new Error('等 ' + what + ' 超时（' + timeoutMs + 'ms）')
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  /**
   * 执行所有挂起的清理回调（模拟传输终态事件），并等 rm 真正落到设备上。
   *
   * 【N14】原来固定等 600ms。rm 是 fire-and-forget 的子进程，600ms 在空闲时够、
   * 在并发跑测试时不够 —— 复审复现到的假红就是这一类。现在先等挂起的回调放完，
   * 再由调用方按事实轮询（下面的用例里用 waitUntil 等残留归零）。
   */
  async function settleAll(): Promise<void> {
    const callbacks = [...pending.values()]
    pending.clear()
    for (const callback of callbacks) callback()
    // 给已发出的 rm 一个很短的起步窗口（之后由 waitUntil 按事实收敛）
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  beforeAll(() => {
    /*
     * 用 realpath 的**长名**作为本地根：Windows 的 temp 会给 8.3 短名
     * （C:\Users\ADMINI~1\...），而传输服务用 realpath 结果拼目标路径，
     * 再与原样传入的根比较 —— 短名根 vs 长名目标会被判成根外（E_OUTSIDE_ROOT）。
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
    try { shell('rm -rf -- ' + quote(SHOT_TEMP_DIR)) } catch { /* 同上 */ }
    try { shell('rm -rf -- ' + quote(SHOT_FALLBACK_DIR + '/' + SERIAL)) } catch { /* 同上 */ }
    shell('mkdir -p ' + quote(REMOTE_DIR))
  }, 120_000)

  afterAll(async () => {
    try { await settleAll() } catch { /* 忽略 */ }
    service.dispose()
    try { shell('rm -rf -- ' + quote(REMOTE_DIR)) } catch { /* 忽略 */ }
    try { shell('rm -rf -- ' + quote(SHOT_TEMP_DIR)) } catch { /* 忽略 */ }
    try { shell('rm -rf -- ' + quote(SHOT_FALLBACK_DIR + '/' + SERIAL)) } catch { /* 忽略 */ }
    transfer.dispose()
    if (root !== '') rmSync(root, { recursive: true, force: true })
    // 释放设备锁（最后一个动作：确保设备侧清理已经跑完）
    if (lockRelease !== null) lockRelease()
  }, 120_000)

  it('I2：批量截图落到隐藏目录 /sdcard/.adbfm，本地是真 PNG，设备临时文件已删', async () => {
    expect(SHOT_TEMP_DIR).toBe('/sdcard/.adbfm')
    // 截图前设备上不该有本应用的临时文件
    expect(leftoverShots(SHOT_TEMP_DIR)).toBe(0)

    const data = await service.screenshot({ serials: [SERIAL as string] }, root)
    expect(data.results).toHaveLength(1)
    expect(data.results[0]).toMatchObject({ serial: SERIAL, ok: true })
    const taskId = data.results[0].detail
    expect(taskId).toBeTruthy()

    // 入队的源路径就在隐藏目录里（I2 的直接证据）
    const task = await waitTerminal(taskId as string)
    expect(task.status).toBe('done')
    expect(task.src.startsWith(deviceShotDir(SERIAL as string) + '/' + SHOT_PREFIX)).toBe(true)

    // 本地确实落了一张 png，文件头是 PNG 魔数 89 50 4E 47
    const localName = task.dst.split(/[\\/]/).pop() as string
    const localPath = path.join(root, localName)
    expect(existsSync(localPath)).toBe(true)
    const head = readFileSync(localPath).subarray(0, 4)
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(readFileSync(localPath).length).toBeGreaterThan(1024)

    // 终态结算后：设备上的临时文件必须消失（I1/I2：隐藏目录里残留数 = 0）
    await settleAll()
    await waitUntil(() => leftoverShots(SHOT_TEMP_DIR) === 0, '本机子目录残留归零')
    expect(leftoverShots(SHOT_TEMP_DIR)).toBe(0)
    // 用户可见的下载目录里一个都不许有
    await waitUntil(() => leftoverShots(SHOT_FALLBACK_DIR) === 0, '回退目录残留归零')
    expect(leftoverShots(SHOT_FALLBACK_DIR)).toBe(0)
  }, 180_000)

  it('I1：任务不结算（模拟退出/排空）时 dispose() 后设备上残留数 = 0', async () => {
    // 先确保干净
    await settleAll()
    try { shell('rm -rf -- ' + quote(SHOT_TEMP_DIR)) } catch { /* 忽略 */ }
    expect(leftoverShots(SHOT_TEMP_DIR)).toBe(0)

    // 造一个「截图成功但传输任务永远不结算」的局面：不调用 settleAll
    const data = await service.screenshot({ serials: [SERIAL as string] }, root)
    expect(data.results[0]).toMatchObject({ ok: true })

    // 此时设备上确实还留着临时文件（这就是审查复现的 LEFTOVER_AFTER_QUIT=1 场景）
    const leftoversBefore = leftoverShots(SHOT_TEMP_DIR)
    expect(leftoversBefore).toBeGreaterThan(0)

    /*
     * dispose()（main.ts 的 before-quit 会调用它）必须把未结算的清理全部执行掉。
     * 注意：dispose 里的 rm 是 fire-and-forget，这里等一小会儿让它真的落地。
     */
    service.dispose()
    // 【N14】按事实轮询：满足即返回，最坏 15s 才判失败（不是赌一个固定秒数）
    await waitUntil(() => leftoverShots(SHOT_TEMP_DIR) === 0, 'dispose 后设备残留归零')
    expect(leftoverShots(SHOT_TEMP_DIR)).toBe(0)
  }, 180_000)

  it('批量执行命令：真机回显 stdout；离线与超时设备互不影响（失败隔离）', async () => {
    fakeCommands.length = 0
    const data = await service.shell(
      { serials: [SERIAL as string, FAKE_OFFLINE, 'FAKE-DEV-BATCH'] },
      'echo adbfm-ok',
    )

    // R4：结果顺序与入参一致
    expect(data.results.map((item) => item.serial)).toEqual([SERIAL, FAKE_OFFLINE, 'FAKE-DEV-BATCH'])
    expect(data.results[0]).toMatchObject({ ok: true })
    expect(data.results[0].detail).toContain('adbfm-ok')
    // R5：离线设备零命令
    expect(data.results[1]).toMatchObject({ ok: false, code: E_DEVICE_OFFLINE })
    // 假设备抛超时 → 只影响它自己
    expect(data.results[2]).toMatchObject({ ok: false, code: E_TIMEOUT })
    expect(fakeCommands.filter((item) => item.serial === FAKE_OFFLINE)).toEqual([])
    expect(fakeCommands.filter((item) => item.serial === 'FAKE-DEV-BATCH')).toHaveLength(1)
  }, 120_000)

  it('I3：真机上跑一条产生 ~10 MB 输出的命令，结果被截断且进程被中止', async () => {
    /*
     * 用 head -c 10MB /dev/urandom | base64 生成确定的大输出：
     * 修前这条命令会把 13.6 MB 全收进主进程内存（审查实测 heap +25.1 MB）。
     * 现在 AdbClient 在收流到 8 KB 时就中止进程树，service 返回「截断的成功结果」。
     */
    const started = Date.now()
    const data = await service.shell(
      { serials: [SERIAL as string] },
      'head -c 10000000 /dev/urandom | base64',
    )
    const elapsed = Date.now() - started

    expect(data.results).toHaveLength(1)
    const item = data.results[0]
    // 截断不是失败：用户要的是「已跑过、输出太长」
    expect(item.ok).toBe(true)
    expect(item.truncated).toBe(true)
    // detail 是 512 字节摘要（R8 第二层）
    expect((item.detail ?? '').length).toBe(512)
    // 中止必须很快发生（不是等命令把 10 MB 跑完）—— 给足余量避免慢机器误判
    expect(elapsed).toBeLessThan(25_000)
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
