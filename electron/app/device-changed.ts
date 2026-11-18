import type { DeviceManager } from '../devices/manager'
import type { AdbState, DeviceSession, DevicesChangedBatch } from '../../src/shared/types'
import { deviceFingerprint, snapshotFingerprint } from '../../src/shared/device-view'
import { DeviceChangeHub, DEFAULT_COALESCE_MS } from '../ipc/throttle'

/**
 * 设备变更去重 + 合并（裁决 5）。
 *
 * 三层，缺一不可：
 * 1. 【逐字段比对】DeviceManager 的 applySnapshot 对每个 item 无条件 emit，
 *    每 3 秒一轮轮询、10 台设备就是每秒十几次事件。这里把当前会话表与上一次快照比对，
 *    只有真正变化的设备才进入候选。
 * 2. 【时间窗合并】同一批内的多条变化（例如多台设备同时掉线）合并成一个批次推给渲染层，
 *    窗口默认 50ms（规格 8）。
 * 3. 【adb 状态同行】adb 自检是异步的（4~8s），比窗口晚结束是常态。渲染层首屏拿到的
 *    是 checking，若推送里不带 adb，界面就会永远停在「正在查找 adb…」——
 *    「无法使用 adb」永远不会出现。所以 adb 状态也纳入同一套指纹去重。
 *
 * 指纹不包含 lastSeenAt（每次轮询都会刷新），否则等于每轮都推一次。
 */

/** 纯函数：比对上一次快照与当前列表，给出变化与移除。 */
export function collectChangedDevices(
  previous: ReadonlyMap<string, DeviceSession>,
  current: readonly DeviceSession[],
): { changed: DeviceSession[]; removed: string[]; next: Map<string, DeviceSession> } {
  const next = new Map<string, DeviceSession>()
  const changed: DeviceSession[] = []
  for (const device of current) {
    next.set(device.serial, device)
    const before = previous.get(device.serial)
    if (before === undefined || deviceFingerprint(before) !== deviceFingerprint(device)) {
      changed.push(device)
    }
  }
  const removed: string[] = []
  for (const serial of previous.keys()) {
    if (!next.has(serial)) removed.push(serial)
  }
  return { changed, removed, next }
}

/** 需要在设备掉线/重连时清缓存的外部副作用（本任务：设备时区）。 */
export interface InvalidateListener {
  (serial: string): void
}

/**
 * 把 DeviceManager 的原始 changed 事件收敛成「去重 + 合并」的推送批次。
 *
 * 生命周期与跟踪器绑定：stop() 之后不再派发任何事件，
 * 避免窗口已经销毁还去 webContents.send。
 */
export class DeviceChangeTracker {
  private previous = new Map<string, DeviceSession>()
  private readonly hub: DeviceChangeHub
  private readonly invalidateListeners: InvalidateListener[] = []
  /** 上一次看到的每台设备状态：用于判断「掉线 / 重连」两个需要清缓存的时刻。 */
  private lastStatus = new Map<string, DeviceSession['status']>()
  /** 上一次推出去的整体指纹（设备表 + adb 状态）。 */
  private lastFingerprint: string | undefined
  private disposed = false
  private readonly onManagerChanged: () => void
  private readonly onManagerRemoved: (serial: string) => void

  constructor(
    private readonly manager: DeviceManager,
    private readonly clearTz: (serial: string) => void,
    /** 取当前 adb 自检状态。缺省视为「未自检」（checking），只在测试里才会省略。 */
    private readonly adbState: () => AdbState = () => ({ state: 'checking' }),
    coalesceMs = DEFAULT_COALESCE_MS,
  ) {
    this.hub = new DeviceChangeHub(coalesceMs)
    this.onManagerChanged = () => { this.scan() }
    this.onManagerRemoved = (serial: string) => {
      this.lastStatus.delete(serial)
      this.notifyInvalidate(serial)
      this.scan()
    }
    this.manager.on('changed', this.onManagerChanged)
    this.manager.on('removed', this.onManagerRemoved)
  }

  /** 订阅合并后的推送批次；返回退订函数。 */
  onPush(listener: (batch: DevicesChangedBatch) => void): () => void {
    return this.hub.onPush(listener)
  }

  /**
   * 通知「adb 自检状态可能变了」，让界面能脱离 checking。
   * 状态没变就不推 —— 与设备变更共用同一套指纹去重。
   */
  notifyAdbState(): void {
    this.scan()
  }

  /** 订阅「该清设备级缓存了」的事件（掉线 / 重连时触发）。 */
  onInvalidate(listener: InvalidateListener): () => void {
    this.invalidateListeners.push(listener)
    return () => {
      const index = this.invalidateListeners.indexOf(listener)
      if (index >= 0) this.invalidateListeners.splice(index, 1)
    }
  }

  /** 当前去重后的会话表（devices:list 的首屏数据）。 */
  snapshot(): DeviceSession[] {
    return [...this.previous.values()]
  }

  /** 立即派发挂起批次（退出前收尾；测试用以免依赖真实定时器）。 */
  flush(): void {
    if (this.disposed) return
    this.hub.flush()
  }

  /** 解绑全部监听并丢弃挂起批次。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.manager.off('changed', this.onManagerChanged)
    this.manager.off('removed', this.onManagerRemoved)
    this.hub.dispose()
  }

  /**
   * 重扫一遍会话表，只在【整体指纹】变化时推进一个批次。
   *
   * 指纹 = 设备表（逐字段，不含 lastSeenAt）+ adb 状态。
   * 用「整体指纹」而不是「changed/removed 非空」做门禁，是为了覆盖
   * 「设备表一个字没变、只有 adb 自检状态从 checking 变成 error」这种必须推送的情况。
   */
  private scan(): void {
    if (this.disposed) return
    const current = this.manager.list()
    const result = collectChangedDevices(this.previous, current)
    this.previous = result.next

    // 掉线 / 重连：设备时区可能已经被改过，缓存必须失效（裁决 6）
    for (const device of current) {
      const before = this.lastStatus.get(device.serial)
      if (before !== undefined && before !== device.status && isBoundary(before, device.status)) {
        this.notifyInvalidate(device.serial)
      }
      this.lastStatus.set(device.serial, device.status)
    }

    const adb = this.adbState()
    const fingerprint = snapshotFingerprint({ devices: current, adb })
    if (fingerprint === this.lastFingerprint) return
    this.lastFingerprint = fingerprint
    this.hub.push({ changed: result.changed, removed: result.removed, adb })
  }

  private notifyInvalidate(serial: string): void {
    for (const listener of this.invalidateListeners) listener(serial)
    // 兜底：即使没人订阅清缓存，也走一次默认清理，避免「忘了订阅 = 缓存永不失效」
    this.clearTz(serial)
  }
}

/** 状态跨越「在线 ↔ 不在线」的边界时，设备时区缓存要作废。 */
function isBoundary(before: DeviceSession['status'], after: DeviceSession['status']): boolean {
  const online = (status: DeviceSession['status']): boolean => status === 'device'
  return online(before) !== online(after)
}