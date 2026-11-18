import { describe, it, expect } from 'vitest'
import { DeviceManager } from '../electron/devices/manager'
import { collectChangedDevices } from '../electron/app/device-changed'
import type { DeviceSession } from '../src/shared/types'

function dev(over: Partial<DeviceSession> & { serial: string }): DeviceSession {
  return {
    serial: over.serial,
    status: over.status ?? 'device',
    transport: over.transport ?? 'usb',
    model: over.model,
    android: over.android,
    battery: over.battery,
    storage: over.storage,
    lastSeenAt: over.lastSeenAt ?? 1,
  }
}

/*
 * 裁决 5 的核心：applySnapshot 对每个 item 无条件 emit，每 3 秒轮询一次设备栏就会收到 N 次 changed。
 * collectChangedDevices 负责「与上一次快照逐字段比对」，只在真变化时收集。
 */

describe('设备快照去重（裁决 5：不变就不推）', () => {
  it('首次快照：每台设备都算变化', () => {
    const first = collectChangedDevices(new Map(), [dev({ serial: 'A' }), dev({ serial: 'B' })])
    expect(first.changed.map((d) => d.serial).sort()).toEqual(['A', 'B'])
    expect(first.next.size).toBe(2)
  })

  it('同一份快照重复来两次，第二次一条都不变（核心断言）', () => {
    const one = collectChangedDevices(new Map(), [dev({ serial: 'A' }), dev({ serial: 'B' })])
    const two = collectChangedDevices(one.next, [dev({ serial: 'A' }), dev({ serial: 'B' })])
    expect(two.changed).toEqual([])
    expect(two.removed).toEqual([])
  })

  it('lastSeenAt 变化不算变化（每轮轮询都会刷新它）', () => {
    const one = collectChangedDevices(new Map(), [dev({ serial: 'A', lastSeenAt: 1 })])
    const two = collectChangedDevices(one.next, [dev({ serial: 'A', lastSeenAt: 9_999_999 })])
    expect(two.changed).toEqual([])
  })

  it('status 变化只推那一台', () => {
    const one = collectChangedDevices(new Map(), [dev({ serial: 'A' }), dev({ serial: 'B' })])
    const two = collectChangedDevices(one.next, [
      dev({ serial: 'A' }),
      dev({ serial: 'B', status: 'offline' }),
    ])
    expect(two.changed.map((d) => d.serial)).toEqual(['B'])
    expect(two.changed[0].status).toBe('offline')
  })

  it('型号 / 电量 / 存储 / 传输方式变化都算变化', () => {
    let prev = collectChangedDevices(new Map(), [dev({ serial: 'A' })]).next
    for (const next of [
      dev({ serial: 'A', model: 'Pixel 7' }),
      dev({ serial: 'A', model: 'Pixel 7', battery: 80 }),
      dev({ serial: 'A', model: 'Pixel 7', battery: 80, storage: { usedKb: 1, totalKb: 2 } }),
      dev({ serial: 'A', model: 'Pixel 7', battery: 80, storage: { usedKb: 1, totalKb: 2 }, transport: 'wireless' }),
    ]) {
      const result = collectChangedDevices(prev, [next])
      expect(result.changed, JSON.stringify(next)).toHaveLength(1)
      prev = result.next
    }
  })

  it('设备消失会报 removed，重新出现会报 changed', () => {
    const one = collectChangedDevices(new Map(), [dev({ serial: 'A' }), dev({ serial: 'B' })])
    const two = collectChangedDevices(one.next, [dev({ serial: 'A' })])
    expect(two.removed).toEqual(['B'])
    expect(two.changed).toEqual([])
    const three = collectChangedDevices(two.next, [dev({ serial: 'A' }), dev({ serial: 'B' })])
    expect(three.changed.map((d) => d.serial)).toEqual(['B'])
    expect(three.removed).toEqual([])
  })

  it('与 DeviceManager 配合：3 轮相同轮询只产生首批变化', () => {
    const mgr = new DeviceManager()
    let prev = new Map<string, DeviceSession>()
    const batches: string[][] = []
    mgr.on('changed', () => {
      const result = collectChangedDevices(prev, mgr.list())
      prev = result.next
      const pushed = [...result.changed.map((d) => d.serial), ...result.removed.map((s) => '-' + s)]
      if (pushed.length > 0) batches.push(pushed)
    })
    mgr.applySnapshot([{ serial: 'A', status: 'device' }, { serial: 'B', status: 'device' }])
    // 首次快照：A 入表时推 A，B 入表时推 B —— 两台都必须让渲染层知道
    expect(batches).toEqual([['A'], ['B']])
    mgr.applySnapshot([{ serial: 'A', status: 'device' }, { serial: 'B', status: 'device' }])
    mgr.applySnapshot([{ serial: 'A', status: 'device' }, { serial: 'B', status: 'device' }])
    // 后两轮一模一样 —— 一条都不推
    expect(batches).toEqual([['A'], ['B']])
    mgr.applySnapshot([{ serial: 'A', status: 'device' }, { serial: 'B', status: 'offline' }])
    expect(batches).toEqual([['A'], ['B'], ['B']])
  })
})