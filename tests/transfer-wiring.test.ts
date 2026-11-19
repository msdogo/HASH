import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DeviceManager } from '../electron/devices/manager'
import { DeviceChangeTracker } from '../electron/app/device-changed'
import {
  TransferOnlineTracker,
  isTransmittable,
  wireBatchToTransfer,
} from '../electron/app/transfer-wiring'
import type { AdbState } from '../src/shared/types'

/*
 * 审查 I1（第 2 轮）：接线必须**行为级**验证，纯函数 + 静态断言都守不住「空转」。
 *
 * 第 1 轮的接线是：
 *   const before = devices.list(); ...; const after = devices.list()
 *   applyOnlineDiff(diffOnlineSerials(before, after), transfer)
 * 它通过了 7 条纯函数用例，也通过了静态 grep 断言（main.ts 里确实有那两行），
 * 但**真实接线永远空转**：DeviceManager 先改状态再 emit，事件还要过 50ms 合并窗，
 * 回调执行时两次 list() 读到的是同一份已改完的表。
 *
 * 所以这里刻意搭**完整链路**：
 *   DeviceManager.applySnapshot → changed 事件 → DeviceChangeTracker 去重合并
 *   → onPush 批次 → wireBatchToTransfer → setDeviceOnline(serial, online)
 * 并断言 setDeviceOnline 的真实调用参数。
 */

const ADB_OK: AdbState = { state: 'ok', path: 'C:/adb.exe', version: '1.0.41', source: 'path' }

interface Recorder {
  calls: Array<{ serial: string; online: boolean }>
}

function recorder(): { calls: Array<{ serial: string; online: boolean }>; setDeviceOnline: (serial: string, online: boolean) => void } {
  const calls: Array<{ serial: string; online: boolean }> = []
  return { calls, setDeviceOnline: (serial, online) => { calls.push({ serial, online }) } }
}

/** 搭一套真实的 设备表 → 跟踪器 → 接线 的链路。 */
function createChain() {
  const mgr = new DeviceManager()
  const tracker = new DeviceChangeTracker(mgr, () => {}, () => ADB_OK, 0)
  const onlineTracker = new TransferOnlineTracker()
  const target = recorder()
  const batches: Array<{ changed: string[]; removed: string[] }> = []
  tracker.onPush((batch) => {
    batches.push({ changed: batch.changed.map((d) => d.serial), removed: batch.removed })
    wireBatchToTransfer(onlineTracker, batch, target)
  })
  return { mgr, tracker, onlineTracker, target, batches }
}

describe('I1 行为级：设备状态变化真的会驱动 setDeviceOnline', () => {
  it('设备掉线 → 以 online=false 调用 setDeviceOnline（第 1 轮这里是空转）', () => {
    const chain = createChain()
    // 先上线
    chain.mgr.applySnapshot([{ serial: 'A', status: 'device' }])
    chain.tracker.flush()
    // 再掉线
    chain.mgr.applySnapshot([])
    chain.tracker.flush()

    // 必须有一次 online=false 的调用 —— 这正是第 1 轮永远不发生的
    expect(chain.target.calls).toContainEqual({ serial: 'A', online: false })
  })

  it('设备恢复在线 → 以 online=true 调用', () => {
    const chain = createChain()
    chain.mgr.applySnapshot([{ serial: 'A', status: 'device' }])
    chain.tracker.flush()
    chain.mgr.applySnapshot([{ serial: 'A', status: 'offline' }])
    chain.tracker.flush()
    chain.mgr.applySnapshot([{ serial: 'A', status: 'device' }])
    chain.tracker.flush()

    expect(chain.target.calls).toContainEqual({ serial: 'A', online: false })
    expect(chain.target.calls).toContainEqual({ serial: 'A', online: true })
  })

  it('三次翻转 → 每次都识别（复审探针里的三次翻转场景）', () => {
    const chain = createChain()
    const steps: Array<{ status: 'device' | 'offline' | 'unauthorized' }> = [
      { status: 'device' },
      { status: 'offline' },
      { status: 'device' },
      { status: 'unauthorized' },
    ]
    for (const step of steps) {
      chain.mgr.applySnapshot([{ serial: 'A', status: step.status }])
      chain.tracker.flush()
    }
    expect(chain.target.calls).toEqual([
      { serial: 'A', online: true },   // 首次接入 device
      { serial: 'A', online: false },  // offline
      { serial: 'A', online: true },   // 恢复
      { serial: 'A', online: false },  // unauthorized 也不能传
    ])
  })

  /*
   * 【裁决 8 / 任务 9】用例名改准：本条实际走的是 markLost 产生的 offline changed 分支，
   * 而不是 removed 分支（复审变异实证：删掉 removed 分支的 push，本条仍绿）。
   * 真正的 removed 分支由下面那条「直接构造批次」的用例压住。
   * 保留本条是因为它覆盖的是**真实生产路径**（gc 之前设备已先掉线）。
   */
  it('设备掉线后整台从会话表移除（gc）→ 掉线判定仍然成立', () => {
    const chain = createChain()
    chain.mgr.applySnapshot([{ serial: 'A', status: 'device' }])
    chain.tracker.flush()
    // 模拟 gc 移除（retain 过期）
    chain.mgr.markLost('A', Date.now())
    chain.tracker.flush()
    chain.mgr.gc(Date.now() + 31 * 60 * 1000)
    chain.tracker.flush()

    expect(chain.target.calls).toContainEqual({ serial: 'A', online: false })
  })

  it('状态没变的重复快照不重复调用（避免多次白 pump）', () => {
    const chain = createChain()
    chain.mgr.applySnapshot([{ serial: 'A', status: 'device' }])
    chain.tracker.flush()
    const afterFirst = chain.target.calls.length
    // 同一状态再推三轮
    for (let i = 0; i < 3; i++) {
      chain.mgr.applySnapshot([{ serial: 'A', status: 'device' }])
      chain.tracker.flush()
    }
    expect(chain.target.calls.length).toBe(afterFirst)
  })

  it('多设备各自独立：A 掉线不影响 B', () => {
    const chain = createChain()
    chain.mgr.applySnapshot([{ serial: 'A', status: 'device' }, { serial: 'B', status: 'device' }])
    chain.tracker.flush()
    chain.target.calls.length = 0
    chain.mgr.applySnapshot([{ serial: 'B', status: 'device' }])
    chain.tracker.flush()

    expect(chain.target.calls).toEqual([{ serial: 'A', online: false }])
  })
})

describe('裁决 8：removed 分支本身（直接构造批次，绕过 changed）', () => {
  /*
   * 生产路径上 removed 分支基本不可达（gc 只删 lostAt，而 lostAt 只在发过 offline
   * changed 之后才设置）。它是防御性代码，正因为如此更需要一条能压住它的用例：
   * 用「只在 removed 里出现的 serial」直接构造批次 —— 这时若删掉 removed 分支的 push，
   * 本用例必红（复审已用变异验证过）。
   */
  it('批次里只有 removed、没有对应 changed 时，以 online=false 推送', () => {
    const tracker = new TransferOnlineTracker()
    const target = recorder()
    // 先让它上线，模拟「上一次批次里它是可传输的」
    const first = tracker.apply({ changed: [{ serial: 'A', status: 'device', transport: 'usb', lastSeenAt: 0 }], removed: [] })
    expect(first).toEqual({ wentOffline: [], cameOnline: ['A'] })
    expect(target.calls).toEqual([])
    wireBatchToTransfer(tracker, { changed: [], removed: ['A'] }, target)

    expect(target.calls).toEqual([{ serial: 'A', online: false }])
    // 也确认 known 被清掉：再收到同 serial 的 device 会重新算 cameOnline
    const after = tracker.apply({ changed: [{ serial: 'A', status: 'device', transport: 'usb', lastSeenAt: 0 }], removed: [] })
    expect(after).toEqual({ wentOffline: [], cameOnline: ['A'] })
  })

  it('removed 里是未知 serial 时不产生任何调用（不误报掉线）', () => {
    const tracker = new TransferOnlineTracker()
    const target = recorder()
    wireBatchToTransfer(tracker, { changed: [], removed: ['NEVER-SEEN'] }, target)
    expect(target.calls).toEqual([])
  })
})

describe('isTransmittable', () => {
  it('只有 device 可传输', () => {
    expect(isTransmittable('device')).toBe(true)
    for (const status of ['offline', 'unauthorized', 'recovery', 'unknown'] as const) {
      expect(isTransmittable(status)).toBe(false)
    }
  })
})
