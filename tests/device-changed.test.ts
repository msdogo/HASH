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

/* ================= C1：设备掉线必须推送（审查轮 1） ================= */

describe('C1 设备掉线必须推送 offline（不是靠 30 分钟后 gc 才知道）', () => {
  it('applySnapshot([A]) → applySnapshot([]) 时第二批必须推 A:offline', async () => {
    const { DeviceChangeTracker } = await import('../electron/app/device-changed')
    const mgr = new DeviceManager()
    const tracker = new DeviceChangeTracker(mgr, () => {}, () => ({ state: 'checking' }))
    const batches: Array<{ changed: string[]; removed: string[] }> = []
    tracker.onPush((b) => {
      batches.push({ changed: b.changed.map((d) => d.serial + ':' + d.status), removed: b.removed })
    })

    // 第一批：设备在线
    mgr.applySnapshot([{ serial: 'SER1', status: 'device', transport: 'usb' }])
    tracker.flush()

    // 第二批：设备消失（这是掉线最高频的真实路径）
    mgr.applySnapshot([])
    tracker.flush()

    expect(batches).toEqual([
      { changed: ['SER1:device'], removed: [] },
      { changed: ['SER1:offline'], removed: [] },
    ])
    // 管理器里确实是 offline
    expect(mgr.get('SER1')?.status).toBe('offline')
    tracker.dispose()
  })

  it('markLost 路径同样要推 offline', async () => {
    const { DeviceChangeTracker } = await import('../electron/app/device-changed')
    const mgr = new DeviceManager()
    const tracker = new DeviceChangeTracker(mgr, () => {}, () => ({ state: 'checking' }))
    const batches: string[][] = []
    tracker.onPush((b) => { batches.push(b.changed.map((d) => d.serial + ':' + d.status)) })

    mgr.upsert({ serial: 'SER1', status: 'device' })
    tracker.flush()
    mgr.markLost('SER1')
    tracker.flush()

    expect(batches).toEqual([['SER1:device'], ['SER1:offline']])
    tracker.dispose()
  })

  it('设备重新插回要推 device（离线↔在线两个方向都不能丢）', async () => {
    const { DeviceChangeTracker } = await import('../electron/app/device-changed')
    const mgr = new DeviceManager()
    const tracker = new DeviceChangeTracker(mgr, () => {}, () => ({ state: 'checking' }))
    const batches: string[][] = []
    tracker.onPush((b) => { batches.push(b.changed.map((d) => d.serial + ':' + d.status)) })

    mgr.applySnapshot([{ serial: 'SER1', status: 'device', transport: 'usb' }])
    tracker.flush()
    mgr.applySnapshot([])
    tracker.flush()
    mgr.applySnapshot([{ serial: 'SER1', status: 'device', transport: 'usb' }])
    tracker.flush()

    expect(batches).toEqual([['SER1:device'], ['SER1:offline'], ['SER1:device']])
    tracker.dispose()
  })

  it('连续多轮空快照不会反复推 offline（去重仍然生效）', async () => {
    const { DeviceChangeTracker } = await import('../electron/app/device-changed')
    const mgr = new DeviceManager()
    const tracker = new DeviceChangeTracker(mgr, () => {}, () => ({ state: 'checking' }))
    const batches: string[][] = []
    tracker.onPush((b) => { batches.push(b.changed.map((d) => d.serial + ':' + d.status)) })

    mgr.applySnapshot([{ serial: 'SER1', status: 'device', transport: 'usb' }])
    tracker.flush()
    mgr.applySnapshot([])
    tracker.flush()
    mgr.applySnapshot([])
    tracker.flush()
    mgr.applySnapshot([])
    tracker.flush()

    expect(batches).toEqual([['SER1:device'], ['SER1:offline']])
    tracker.dispose()
  })
})

describe('C1 根因：DeviceManager 的 offline 分支必须新建对象（不可变更新）', () => {
  it('applySnapshot 让设备掉线时，会话对象引用必须变化', () => {
    const mgr = new DeviceManager()
    mgr.applySnapshot([{ serial: 'SER1', status: 'device', transport: 'usb' }])
    const before = mgr.get('SER1')
    mgr.applySnapshot([])
    const after = mgr.get('SER1')
    expect(after?.status).toBe('offline')
    // 关键：如果原地改，before === after，任何「拿旧引用比对新引用」的去重都会失效
    expect(after).not.toBe(before)
    // 旧引用不能被偷偷改掉（否则 external 持有者看到的是一份被篡改的快照）
    expect(before?.status).toBe('device')
  })

  it('markLost 同样必须新建对象', () => {
    const mgr = new DeviceManager()
    mgr.upsert({ serial: 'SER1', status: 'device' })
    const before = mgr.get('SER1')
    mgr.markLost('SER1')
    const after = mgr.get('SER1')
    expect(after?.status).toBe('offline')
    expect(after).not.toBe(before)
    expect(before?.status).toBe('device')
  })
})
