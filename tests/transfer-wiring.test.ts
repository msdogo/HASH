import { describe, it, expect } from 'vitest'
import { diffOnlineSerials } from '../electron/app/transfer-wiring'
import type { DeviceSession } from '../src/shared/types'

/*
 * 审查 I1：`setDeviceOnline` 全仓没有生产调用方，裁决 4「掉线设备暂停」只是纸面满足。
 *
 * 设备拔掉后，在跑的任务会一直挂到 6 小时超时才失败；排队任务也不会被暂停，
 * 进度条上「设备离线，等待重连」永远不会出现。
 *
 * 这里把「前后快照比对」抽成纯函数，便于单测；main.ts 只负责把它接到 tracker 事件上。
 */

function device(serial: string, status: DeviceSession['status']): DeviceSession {
  return { serial, status, transport: 'usb', lastSeenAt: 0 }
}

describe('设备上下线差分', () => {
  it('设备从在线变为掉线 → 报告为 offline', () => {
    const before = [device('A', 'device')]
    const after = [device('A', 'offline')]
    expect(diffOnlineSerials(before, after)).toEqual({ wentOffline: ['A'], cameOnline: [] })
  })

  it('设备从掉线恢复在线 → 报告为 online', () => {
    const before = [device('A', 'offline')]
    const after = [device('A', 'device')]
    expect(diffOnlineSerials(before, after)).toEqual({ wentOffline: [], cameOnline: ['A'] })
  })

  it('设备整台消失（拔线）也算掉线 —— 否则在跑任务会挂到超时', () => {
    const before = [device('A', 'device'), device('B', 'device')]
    const after = [device('B', 'device')]
    expect(diffOnlineSerials(before, after)).toEqual({ wentOffline: ['A'], cameOnline: [] })
  })

  it('设备新出现算上线', () => {
    expect(diffOnlineSerials([], [device('A', 'device')]))
      .toEqual({ wentOffline: [], cameOnline: ['A'] })
  })

  it('一直在线 / 一直离线都不产生事件（避免抖动）', () => {
    expect(diffOnlineSerials([device('A', 'device')], [device('A', 'device')]))
      .toEqual({ wentOffline: [], cameOnline: [] })
    expect(diffOnlineSerials([device('A', 'offline')], [device('A', 'offline')]))
      .toEqual({ wentOffline: [], cameOnline: [] })
  })

  it('unauthorized / recovery / unknown 都按「不可传输」处理', () => {
    // 这些状态下 adb push 一样不能用，必须暂停队列
    for (const status of ['unauthorized', 'recovery', 'unknown'] as const) {
      expect(diffOnlineSerials([device('A', 'device')], [device('A', status)]).wentOffline)
        .toEqual(['A'])
      expect(diffOnlineSerials([device('A', status)], [device('A', 'device')]).cameOnline)
        .toEqual(['A'])
    }
  })

  it('同一次快照里既掉线又上线，两类都报', () => {
    const before = [device('A', 'device'), device('B', 'offline')]
    const after = [device('A', 'offline'), device('B', 'device')]
    expect(diffOnlineSerials(before, after)).toEqual({ wentOffline: ['A'], cameOnline: ['B'] })
  })
})
