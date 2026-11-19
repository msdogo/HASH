import type { DeviceSession } from '../../src/shared/types'

/**
 * 设备上下线到传输队列的接线（审查 I1）。
 *
 * 为什么需要这个文件：首版实现里 TransferManager/TransferService 都提供了
 * setDeviceOnline，但全仓没有任何生产调用方 —— 只有测试手工驱动。
 * 后果是设备拔掉后在跑的任务会一直挂到 TRANSFER_TIMEOUT_MS（6 小时）才失败，
 * 排队任务也不会被暂停，裁决 4 的「掉线设备暂停」在真实应用里只是纸面满足。
 *
 * 这里把前后两份设备快照的比对抽成纯函数，main.ts 只需在每次设备推送时
 * 把新旧快照交给它，再按结果调用 transfer。纯函数才有办法测。
 */

/** 一台设备是否处于可以执行 adb 传输的状态。 */
export function isTransmittable(status: DeviceSession['status']): boolean {
  // 只有 device 能传。unauthorized / recovery / unknown 下一 push 就失败，
  // offline 更不用说。这些状态都必须暂停队列，而不是让任务去撞超时。
  return status === 'device'
}

/** 一次快照比对的结果。 */
export interface OnlineDiff {
  /** 从可传输变为不可传输（或整台消失）的 serial。 */
  wentOffline: string[]
  /** 从不可传输变为可传输（或新出现且可传输）的 serial。 */
  cameOnline: string[]
}

/**
 * 比对前后两份设备快照，算出现在该暂停谁、该恢复谁。
 *
 * 三条规则（都有单测）：
 * 1. 设备整台消失算掉线（拔线时 adb 有时直接不再列出它，而不是标 offline）；
 * 2. unauthorized / recovery / unknown 也算掉线，这些状态下传输一样跑不了；
 * 3. 状态没变的设备不产生事件（设备表每次轮询全量重发，不过滤就会反复暂停恢复）。
 */
export function diffOnlineSerials(
  before: readonly DeviceSession[],
  after: readonly DeviceSession[],
): OnlineDiff {
  const beforeMap = new Map(before.map((d) => [d.serial, isTransmittable(d.status)] as const))
  const afterMap = new Map(after.map((d) => [d.serial, isTransmittable(d.status)] as const))

  const wentOffline: string[] = []
  const cameOnline: string[] = []

  for (const [serial, wasOnline] of beforeMap) {
    if (!wasOnline) continue
    const isOnline = afterMap.get(serial) ?? false
    if (!isOnline) wentOffline.push(serial)
  }

  for (const [serial, isOnline] of afterMap) {
    if (!isOnline) continue
    const wasOnline = beforeMap.get(serial) ?? false
    if (!wasOnline) cameOnline.push(serial)
  }

  return { wentOffline, cameOnline }
}

/** 把差分结果推给传输服务（main.ts 的生产接线调它）。 */
export function applyOnlineDiff(
  diff: OnlineDiff,
  target: { setDeviceOnline: (serial: string, online: boolean) => void },
): void {
  for (const serial of diff.wentOffline) target.setDeviceOnline(serial, false)
  for (const serial of diff.cameOnline) target.setDeviceOnline(serial, true)
}
