import type { DeviceSession } from '../../src/shared/types'

/**
 * 设备上下线 → 传输队列的接线（审查 I1，第 2 轮重写）。
 *
 * ===== 第 1 轮的实现为什么是空转（必须记住这个教训）=====
 * 第 1 轮在 onDevicesChanged 回调里写了：
 *   const before = devices.list()
 *   broadcast(batch)
 *   const after = devices.list()
 *   applyOnlineDiff(diffOnlineSerials(before, after), transfer)
 * 看起来合理，实际恒为空转：
 *   - DeviceManager 是「先改状态再 emit」（applySnapshot 里 set 完就 emit）；
 *   - 事件还要经过 DeviceChangeTracker 的去重 + 50ms 合并窗才推给 main；
 *   所以回调执行时两次 list() 读到的是同一份已经改完的表，
 *   diffOnlineSerials 恒返回空 —— 复审探针实证 setDeviceOnline 调用次数为 0。
 *
 * 教训：不要自己 diff 两次全局快照，那样永远看不到变化。
 * 事件批次里的 batch.changed / batch.removed 才是真实的状态变化来源。
 */

/** 一台设备是否处于可以执行 adb 传输的状态。 */
export function isTransmittable(status: DeviceSession['status']): boolean {
  // 只有 device 能传。unauthorized / recovery / unknown 下一 push 就失败，
  // offline 更不用说。这些状态都必须暂停队列，而不是让任务去撞超时。
  return status === 'device'
}

/** 一轮批次算出的上下线结果。 */
export interface OnlineDiff {
  /** 从可传输变为不可传输（或整台消失）的 serial。 */
  wentOffline: string[]
  /** 从不可传输变为可传输（或新出现且可传输）的 serial。 */
  cameOnline: string[]
}

/** 事件批次里本模块需要的部分（与 DevicesChangedBatch 结构兼容）。 */
export interface BatchLike {
  changed: readonly DeviceSession[]
  removed: readonly string[]
}

/**
 * 把设备事件批次翻译成「谁该暂停、谁该恢复」。
 *
 * 为什么要有状态：批次里只带新状态、不带旧状态。
 * 不记住上一次的结论，就无法区分「device 到 device 的元数据变化」与
 * 「offline 到 device 的真恢复」：前者会被误报成 cameOnline，
 * 导致每轮轮询都白 pump 一次队列。
 *
 * 这是纯内存状态，不读任何全局快照 —— 数据源只有一个：事件批次。
 */
export class TransferOnlineTracker {
  /** serial → 上一次判定的可传输性。 */
  private readonly known = new Map<string, boolean>()

  /** 消费一个批次，返回该暂停 / 恢复的设备。 */
  apply(batch: BatchLike): OnlineDiff {
    const wentOffline: string[] = []
    const cameOnline: string[] = []

    for (const device of batch.changed) {
      const wasOnline = this.known.get(device.serial)
      const isOnline = isTransmittable(device.status)
      this.known.set(device.serial, isOnline)
      // 首次见到时 wasOnline 为 undefined：按「原本不在线」处理，
      // 于是新接入的可用设备会触发一次 cameOnline（让队列立刻可以跑）。
      if (isOnline && wasOnline !== true) cameOnline.push(device.serial)
      else if (!isOnline && wasOnline === true) wentOffline.push(device.serial)
    }

    /*
     * 整台设备从会话表消失（30 分钟 gc 之后，或主动移除）。
     * 这同样意味着「不能传了」，必须暂停 —— 否则该设备的在跑任务会挂到超时。
     */
    for (const serial of batch.removed) {
      if (this.known.get(serial) === true) wentOffline.push(serial)
      this.known.delete(serial)
    }

    return { wentOffline, cameOnline }
  }

  /** 当前记忆的可传输设备（诊断 / 测试用）。 */
  onlineSerials(): string[] {
    const out: string[] = []
    for (const [serial, online] of this.known) if (online) out.push(serial)
    return out
  }
}

/** 把差分结果推给传输服务（main.ts 的生产接线调它）。 */
export function applyOnlineDiff(
  diff: OnlineDiff,
  target: { setDeviceOnline: (serial: string, online: boolean) => void },
): void {
  for (const serial of diff.wentOffline) target.setDeviceOnline(serial, false)
  for (const serial of diff.cameOnline) target.setDeviceOnline(serial, true)
}

/**
 * 一条完整的接线：批次进来 → 算出上下线 → 推给传输服务。
 *
 * 单独封成函数是为了让行为级用例能精确复现 main.ts 的那几行，
 * 而不必启动 Electron（main.ts 一 import electron 就跑不了）。
 */
export function wireBatchToTransfer(
  tracker: TransferOnlineTracker,
  batch: BatchLike,
  target: { setDeviceOnline: (serial: string, online: boolean) => void },
): OnlineDiff {
  const diff = tracker.apply(batch)
  applyOnlineDiff(diff, target)
  return diff
}
