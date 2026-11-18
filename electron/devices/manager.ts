import { EventEmitter } from 'node:events'
import type { DeviceSession } from '../../src/shared/types'

/** 断线会话保留时长：30 分钟。 */
export const RETAIN_MS = 30 * 60 * 1000

/** 默认 gc 周期：5 分钟。保留 30 分钟，5 分钟一扫足以，又不会太频繁。 */
export const DEFAULT_GC_INTERVAL_MS = 5 * 60 * 1000

/** 设备表快照里的一项：serial + status 必填，其余元数据可选。 */
export type DeviceSnapshotItem = Partial<DeviceSession> & {
  serial: string
  status: DeviceSession['status']
}

/**
 * 多设备会话表。
 *
 * 状态机：
 *   - 设备出现在快照里 → 写入/复用会话，status 取快照值，清掉 lostAt
 *   - 设备从快照里消失 → status 置 offline，记录 lostAt，会话保留
 *   - offline 超过 RETAIN_MS → 清理，发 'removed'
 *
 * 为什么保留而不是立刻删：USB 松动、无线断连都会让设备短暂消失。
 * 立刻删会把「当前浏览的路径、选中的文件」全部丢掉，用户回到同一台设备时得从头点。
 */
export class DeviceManager extends EventEmitter {
  private sessions = new Map<string, DeviceSession>()
  private lostAt = new Map<string, number>()
  private gcTimer: ReturnType<typeof setInterval> | undefined

  /** 会话表里是否有这台设备。 */
  get(serial: string): DeviceSession | undefined {
    return this.sessions.get(serial)
  }

  /** 新增或更新一台设备的会话；同一 serial 会复用旧会话的元数据（model/android/battery...）。 */
  upsert(input: Partial<DeviceSession> & { serial: string; status: DeviceSession['status'] }): void {
    const prev = this.sessions.get(input.serial)
    const next: DeviceSession = {
      ...prev,
      ...input,
      status: input.status,
      transport: input.transport ?? prev?.transport ?? 'usb',
      lastSeenAt: Date.now(),
    }
    this.sessions.set(next.serial, next)
    this.lostAt.delete(next.serial)
    this.emit('changed', next)
  }

  /**
   * 用一份完整设备表快照覆盖状态：快照里有的刷新，快照里没有的转 offline。
   * track-devices 每帧都是全量列表，所以必须用快照语义 —— 逐条 upsert 永远不会发现设备消失。
   */
  applySnapshot(items: DeviceSnapshotItem[], now = Date.now()): void {
    const seen = new Set<string>()
    for (const item of items) {
      seen.add(item.serial)
      const prev = this.sessions.get(item.serial)
      const next: DeviceSession = {
        ...prev,
        ...item,
        status: item.status,
        transport: item.transport ?? prev?.transport ?? 'usb',
        lastSeenAt: now,
      }
      this.sessions.set(item.serial, next)
      this.lostAt.delete(item.serial)
      this.emit('changed', next)
    }
    for (const serial of [...this.sessions.keys()]) {
      if (seen.has(serial)) continue
      // 已经在 offline 且已记账的，不重复发事件、也不重置 lostAt ——
      // 否则每轮轮询都会把丢失时间往后推，会话永远清理不掉。
      if (this.lostAt.has(serial)) continue
      const session = this.sessions.get(serial) as DeviceSession
      session.status = 'offline'
      this.lostAt.set(serial, now)
      this.emit('changed', session)
    }
  }

  /** 标记一台设备掉线（保留会话，等 reconnect 或 gc）。 */
  markLost(serial: string, now = Date.now()): void {
    const session = this.sessions.get(serial)
    if (session === undefined) return
    session.status = 'offline'
    this.lostAt.set(serial, now)
    this.emit('changed', session)
  }

  /** 清理超过保留期的掉线会话。 */
  gc(now = Date.now()): void {
    for (const [serial, at] of [...this.lostAt]) {
      if (now - at <= RETAIN_MS) continue
      this.sessions.delete(serial)
      this.lostAt.delete(serial)
      this.emit('removed', serial)
    }
  }

  /** 启动周期性 gc。重复调用不会叠加定时器。 */
  startGc(intervalMs = DEFAULT_GC_INTERVAL_MS): void {
    this.stopGc()
    this.gcTimer = setInterval(() => { this.gc() }, intervalMs)
    // Electron 主进程里 unref 让定时器不阻塞事件循环退出 —— 与 stopGc 是双保险。
    this.gcTimer.unref?.()
  }

  /** 停止周期性 gc。必须可停止，否则退出时事件循环不空、进程挂住。 */
  stopGc(): void {
    if (this.gcTimer === undefined) return
    clearInterval(this.gcTimer)
    this.gcTimer = undefined
  }

  get gcRunning(): boolean {
    return this.gcTimer !== undefined
  }

  list(): DeviceSession[] {
    return [...this.sessions.values()]
  }
}
