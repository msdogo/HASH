import type { AdbState, DeviceSession, DevicesChangedBatch } from '../../src/shared/types'

/**
 * 事件合并（规格 8：事件合并 ≥ 50ms 一次）。
 *
 * 为什么必须有：track-devices 在多设备时会一帧多行、设备状态抖动时可能连续重发全量列表；
 * 每来一条就 webContents.send 一次，渲染层就要重渲染 N 次。
 * 合并窗口从「首个 push」起算而不是每次 push 都重置 —— 后者在持续变化下会永不派发。
 */

/** 规格要求的最小合并窗口：50ms。 */
export const DEFAULT_COALESCE_MS = 50

/**
 * 单批次合并器。泛型便于单测；设备变更用 DeviceChangeHub 包一层。
 *
 * 语义：窗口内多次 push 只派发一次，payload 取最后一次（后到的状态更新）。
 */
export class Throttle<T> {
  readonly waitMs: number
  private timer: ReturnType<typeof setTimeout> | undefined
  private hasPending = false
  private pendingValue: T | undefined
  private readonly emit: (value: T) => void

  constructor(waitMs: number = DEFAULT_COALESCE_MS, emit: (value: T) => void = () => {}) {
    this.waitMs = waitMs
    this.emit = emit
  }

  /** 是否还有未派发的批次。 */
  get pending(): boolean {
    return this.hasPending
  }

  push(value: T): void {
    this.pendingValue = value
    // 已有挂起批次：只更新值，不重置窗口（从首次 push 起算）
    if (this.hasPending) return
    this.hasPending = true
    this.timer = setTimeout(() => { this.flush() }, this.waitMs)
    // 定时器不得阻塞 Electron 退出：before-quit 之后事件循环必须能空
    this.timer.unref?.()
  }

  /** 立即派发挂起批次。 */
  flush(): void {
    if (!this.hasPending) return
    const value = this.pendingValue as T
    this.clear()
    this.emit(value)
  }

  /** 丢弃挂起批次（退出时用，避免窗口已销毁还去 send）。 */
  cancel(): void {
    this.clear()
  }

  private clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.hasPending = false
    this.pendingValue = undefined
  }
}

/** 设备变更批次对外结构（与 shared/types 的 DevicesChangedBatch 一致）。 */
export interface DeviceChangeListener {
  (batch: DevicesChangedBatch): void
}

/**
 * 设备变更合并器：窗口内同一 serial 的多次变化只保留最后一条，
 * removed 与 changed 合并进同一个批次一起推。
 */
export class DeviceChangeHub {
  /**
   * 当前窗口的累积表。窗口派发后清空。
   * 注意：这里刻意【复用同一张表】并把它的引用交给 Throttle ——
   * 窗口内的多次 push 都在往同一张表里覆盖，派发时读到的就是最终状态。
   * 若每次 push 都新建一张表，Throttle 只保留最后一张，先到的变化就丢了。
   */
  private accumulator: Map<string, DeviceSession | null> | undefined
  /** 本窗口内最新一次 adb 状态；与设备变化合并成同一个批次。 */
  private pendingAdb: AdbState | undefined
  private readonly throttle: Throttle<Map<string, DeviceSession | null>>
  private listeners: DeviceChangeListener[] = []

  constructor(waitMs = DEFAULT_COALESCE_MS) {
    this.throttle = new Throttle<Map<string, DeviceSession | null>>(waitMs, (batch) => {
      this.emit(batch)
    })
  }

  onPush(listener: DeviceChangeListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  /**
   * 记录一批变化。
   * null 表示该 serial 被移除（会话过期）。同一窗口内「先移除再回来」时，
   * 后到的 changed 会覆盖掉 null，语义正确。
   */
  push(input: { changed: readonly DeviceSession[]; removed: readonly string[]; adb?: AdbState }): void {
    if (input.changed.length === 0 && input.removed.length === 0 && input.adb === undefined) return
    if (input.adb !== undefined) this.pendingAdb = input.adb
    const batch = this.accumulator ?? new Map<string, DeviceSession | null>()
    this.accumulator = batch
    for (const device of input.changed) batch.set(device.serial, device)
    for (const serial of input.removed) batch.set(serial, null)
    this.throttle.push(batch)
  }

  /** 立即派发（退出前或测试用）。 */
  flush(): void {
    this.throttle.flush()
  }

  /** 丢弃挂起批次并清空监听器。 */
  dispose(): void {
    this.throttle.cancel()
    this.accumulator = undefined
    this.pendingAdb = undefined
    this.listeners = []
  }

  private emit(batch: Map<string, DeviceSession | null>): void {
    this.accumulator = undefined
    const changed: DeviceSession[] = []
    const removed: string[] = []
    for (const [serial, device] of batch) {
      if (device === null) removed.push(serial)
      else changed.push(device)
    }
    const adb = this.pendingAdb
    this.pendingAdb = undefined
    if (changed.length === 0 && removed.length === 0 && adb === undefined) return
    for (const listener of this.listeners) listener({ changed, removed, adb })
  }
}

/** 建一个新的合并器（默认 50ms）。 */
export function createDeviceChangeHub(waitMs = DEFAULT_COALESCE_MS): DeviceChangeHub {
  return new DeviceChangeHub(waitMs)
}