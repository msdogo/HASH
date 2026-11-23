import { describe, it, expect } from 'vitest'
import { DeviceManager } from '../electron/devices/manager'
import { AdbTracking } from '../electron/app/sessions'
import { createDeviceChangeHub } from '../electron/ipc/throttle'
import type { AdbState, DevicesChangedBatch } from '../src/shared/types'

function silentChild(): unknown {
  return {
    pid: undefined,
    stdout: { on: () => {}, resume: () => {} },
    stderr: { resume: () => {} },
    on: () => {},
    kill: () => {},
  }
}

/*
 * 现场发现（2026-11-18，CDP 抓真实渲染层）：
 * 渲染层启动时先调一次 devices:list 拿首屏，此时 adb 自检（4~8s）往往还没结束，
 * 于是它拿到 adb = { state:'checking' } 并【永远停在 checking】——
 * 后续的 devices:changed 推送里根本没有 adb 字段，界面上「无法使用 adb」的提示
 * 因此永远不会出现。adb 状态必须跟推送一起走。
 */

const CHECKING: AdbState = { state: 'checking' }
const OK: AdbState = { state: 'ok', path: 'C:/adb.exe', version: '1.0.41', source: 'path' }
const NOT_FOUND: AdbState = { state: 'error', code: 'E_ADB_NOT_FOUND', attempts: [] }

function makeTracking(adb: () => AdbState): AdbTracking {
  return new AdbTracking({
    adbPath: 'C:/adb.exe',
    spawnTrack: () => silentChild() as never,
    adbState: adb,
  })
}

describe('推送批次必须携带 adb 状态（否则界面永远停在「正在查找 adb…」）', () => {
  it('设备变更的批次里带当前 adb 状态', () => {
    const t = makeTracking(() => OK)
    const batches: DevicesChangedBatch[] = []
    t.onDevicesChanged((b) => { batches.push(b) })
    t.mgr.upsert({ serial: 'A', status: 'device' })
    t.flushChanges()
    expect(batches).toHaveLength(1)
    expect(batches[0].adb).toEqual(OK)
    t.stop()
  })

  it('adb 自检状态变化本身也能推出去（设备表没变时也要推）', () => {
    let state: AdbState = CHECKING
    const t = makeTracking(() => state)
    const batches: DevicesChangedBatch[] = []
    t.onDevicesChanged((b) => { batches.push(b) })
    t.mgr.upsert({ serial: 'A', status: 'device' })
    t.flushChanges()
    expect(batches.map((b) => b.adb?.state)).toEqual(['checking'])

    // 自检失败 → 状态从 checking 变 error，设备表一个字没变
    state = NOT_FOUND
    t.notifyAdbState()
    t.flushChanges()
    expect(batches).toHaveLength(2)
    expect(batches[1].adb).toEqual(NOT_FOUND)
    // 没有设备变化，只有 adb 状态变化
    expect(batches[1].changed).toEqual([])
    expect(batches[1].removed).toEqual([])
    t.stop()
  })

  it('adb 状态没变时不会因为 notifyAdbState 反复推（保持去重语义）', () => {
    const t = makeTracking(() => OK)
    const batches: DevicesChangedBatch[] = []
    t.onDevicesChanged((b) => { batches.push(b) })
    t.mgr.upsert({ serial: 'A', status: 'device' })
    t.flushChanges()
    expect(batches).toHaveLength(1)
    t.notifyAdbState()
    t.notifyAdbState()
    t.flushChanges()
    expect(batches).toHaveLength(1)
    t.stop()
  })

  it('stop 之后 notifyAdbState 不再推', () => {
    const t = makeTracking(() => OK)
    let count = 0
    t.onDevicesChanged(() => { count += 1 })
    t.stop()
    t.notifyAdbState()
    t.flushChanges()
    expect(count).toBe(0)
  })
})
/* ================= I8 / I9（审查轮 1） ================= */

describe('I8 adb 在推送批次里是必填（把 bug 2 的教训固化进类型）', () => {
  it('hub 派发的批次一定带 adb 字段', () => {
    const hub = createDeviceChangeHub(50)
    const batches: DevicesChangedBatch[] = []
    hub.onPush((b) => { batches.push(b) })
    hub.push({
      changed: [{ serial: 'A', status: 'device', transport: 'usb', lastSeenAt: 1 }],
      removed: [],
      adb: OK,
    })
    hub.flush()
    expect(batches).toHaveLength(1)
    expect(batches[0].adb).toBeDefined()
    expect(batches[0].adb).toEqual(OK)
  })

  it('tracker 派发的批次一定带 adb 字段（即使只有设备变化）', async () => {
    const { DeviceChangeTracker } = await import('../electron/app/device-changed')
    const { DeviceManager } = await import('../electron/devices/manager')
    const mgr = new DeviceManager()
    const tracker = new DeviceChangeTracker(mgr, () => {}, () => OK)
    const batches: DevicesChangedBatch[] = []
    tracker.onPush((b) => { batches.push(b) })
    mgr.upsert({ serial: 'A', status: 'device' })
    tracker.flush()
    expect(batches.length).toBeGreaterThan(0)
    for (const batch of batches) expect(batch.adb).toEqual(OK)
    tracker.dispose()
  })
})

describe('I9 渲染层可主动拉取 adb 状态（不依赖广播时机）', () => {
  it('devices:list 的返回里带 adb 状态（迟到的订阅者也能自愈）', async () => {
    const { DeviceManager } = await import('../electron/devices/manager')
    const { registerHandlers } = await import('../electron/ipc/handlers')
    const registered = new Map<string, (e: unknown, p?: unknown) => unknown>()
    const mgr = new DeviceManager()
    mgr.applySnapshot([{ serial: 'A', status: 'device', transport: 'usb' }])
    registerHandlers(
      {
        devices: mgr,
        adbPath: () => 'C:/adb.exe',
        adbState: () => NOT_FOUND,
        clientFactory: (serial) => ({ serial, run: async () => ({ code: 0, stdout: '', stderr: '' }) }),
        fs: { list: async () => ({ entries: [], degraded: false, unparsed: 0, usedFallback: false, exitCode: 0, tzOffsetMinutes: 0 }) },
        pickFiles: async () => [],
        // 文件操作与本地栏同理：空壳只满足 HandlerDeps（各自有专门的测试）
        ops: {
          mkdir: async () => ({ ok: true }),
          rename: async () => ({ ok: true }),
          removeFacts: async () => ({ count: 0, names: [], truncated: false, hasNonEmptyDir: false, blocked: [] }),
          remove: async () => ({ results: [] }),
          copy: async () => ({ results: [] }),
          move: async () => ({ results: [] }),
        },
        local: { list: async () => ({ cwd: 'C:/Users/me', parent: null, items: [], startDir: 'C:/Users/me' }) },
        pickRoot: async () => '',
        // R2-2：设置给空壳，只为满足 HandlerDeps（设置有专门的 tests/settings-*.test.ts）
        settings: {
          getDownloadDir: () => 'C:/Users/me/Downloads',
          getDefaultDownloadDir: () => 'C:/Users/me/Downloads',
          setDownloadDir: (dir: string) => dir,
          resetDownloadDir: () => 'C:/Users/me/Downloads',
          // R7：本文件不测版本，空壳只为满足 SettingsController
          getAppVersion: () => '0.0.0-stub',
        },
        pickDownloadDir: async () => '',
        // 本文件不测批量：空壳只为满足 HandlerDeps（批量有 tests/batch-*.test.ts）
        batch: {
          screenshot: async () => ({ results: [] }),
          install: async () => ({ results: [] }),
          push: async () => ({ results: [] }),
          shell: async () => ({ results: [] }),
          pickScreenshotDir: async () => '',
          pickApk: async () => '',
        },
        // 本文件不测拖拽：空壳只为满足 HandlerDeps（拖拽有 tests/drag-*.test.ts）
        drag: { dragOut: async () => ({ ok: true }) },
        // 本文件不测传输：给一个空壳，只为满足 HandlerDeps（传输有专门的 tests/transfer-*.test.ts）
        transfer: {
          enqueue: () => { throw new Error('not used') },
          cancel: () => false,
          retry: () => false,
          get: () => undefined,
          snapshot: () => ({ tasks: [], running: 0, queued: 0 }),
          clearFinished: () => 0,
        },
      },
      { handle: (ch, fn) => { registered.set(ch, fn) } },
    )
    const result = await registered.get('devices:list')?.({}) as { ok: boolean; data: { adb: AdbState } }
    expect(result.ok).toBe(true)
    // 迟到的渲染层只要调一次 list 就能拿到当前 adb 状态，不必等下一次广播
    expect(result.data.adb).toEqual(NOT_FOUND)
  })
})
