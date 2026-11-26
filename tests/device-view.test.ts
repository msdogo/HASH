import { describe, it, expect } from 'vitest'
import type { DeviceSession } from '../src/shared/types'
import {
  DOT_CLASS,
  deviceFingerprint,
  deviceLabel,
  deviceLogTag,
  nextActiveSerial,
  serialTail,
  snapshotFingerprint,
  sortDevices,
  statusDot,
  summarize,
} from '../src/shared/device-view'

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

describe('状态点映射（裁决 8：纯逻辑抽到 shared）', () => {
  it('在线 USB 是绿点', () => {
    expect(statusDot({ status: 'device', transport: 'usb' })).toBe('online')
    expect(DOT_CLASS.online).toContain('emerald')
  })

  it('在线无线是蓝点（规格 9.2 蓝=无线）', () => {
    expect(statusDot({ status: 'device', transport: 'wireless' })).toBe('wireless')
    expect(DOT_CLASS.wireless).toContain('sky')
  })

  it('离线灰 / 未授权黄 / recovery 蓝', () => {
    expect(statusDot({ status: 'offline', transport: 'usb' })).toBe('offline')
    expect(statusDot({ status: 'unauthorized', transport: 'usb' })).toBe('unauthorized')
    expect(statusDot({ status: 'recovery', transport: 'usb' })).toBe('recovery')
    expect(DOT_CLASS.offline).toContain('neutral')
    expect(DOT_CLASS.unauthorized).toContain('amber')
  })

  it('忙碌优先于一切状态', () => {
    expect(statusDot({ status: 'device', transport: 'usb', busy: true })).toBe('busy')
    expect(statusDot({ status: 'offline', transport: 'usb', busy: true })).toBe('busy')
  })

  it('unknown 状态落到 unknown 点，且每种点都有 class', () => {
    expect(statusDot({ status: 'unknown', transport: 'usb' })).toBe('unknown')
    for (const kind of ['online', 'offline', 'unauthorized', 'wireless', 'recovery', 'busy', 'unknown'] as const) {
      expect(DOT_CLASS[kind], kind).toMatch(/^bg-/)
    }
  })
})

describe('型号与序列号显示（裁决 9）', () => {
  it('有型号就显示型号', () => {
    expect(deviceLabel({ serial: '9N9CN2G0012A6F', model: 'DJI RC PLUS 2' })).toBe('DJI RC PLUS 2')
  })

  it('型号为空 / 全空白 / 缺失时回退 serial 后 4 位', () => {
    expect(deviceLabel({ serial: '9N9CN2G0012A6F' })).toBe('2A6F')
    expect(deviceLabel({ serial: '9N9CN2G0012A6F', model: '' })).toBe('2A6F')
    expect(deviceLabel({ serial: '9N9CN2G0012A6F', model: '   ' })).toBe('2A6F')
  })

  it('型号首尾空白被裁掉', () => {
    expect(deviceLabel({ serial: 'X', model: '  Pixel 7  ' })).toBe('Pixel 7')
  })

  it('serialTail 处理短序列号不减半', () => {
    expect(serialTail('9N9CN2G0012A6F')).toBe('2A6F')
    expect(serialTail('A6F')).toBe('A6F')
    expect(serialTail('192.168.1.7:5555', 5)).toBe(':5555')
  })
})

describe('设备排序', () => {
  it('在线优先，其次未授权，最后离线/未知', () => {
    const list = [
      dev({ serial: 'C', status: 'offline' }),
      dev({ serial: 'B', status: 'unauthorized' }),
      dev({ serial: 'A', status: 'device', model: 'Pixel 7' }),
      dev({ serial: 'D', status: 'unknown' }),
    ]
    expect(sortDevices(list).map((d) => d.serial)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('同状态按显示名排序', () => {
    const list = [
      dev({ serial: 'S1', model: 'Xiaomi 13' }),
      dev({ serial: 'S2', model: 'DJI RC PLUS 2' }),
      dev({ serial: 'S3', model: 'Pixel 7' }),
    ]
    expect(sortDevices(list).map((d) => d.serial)).toEqual(['S2', 'S3', 'S1'])
  })

  it('空列表与单元素不改内容', () => {
    expect(sortDevices([])).toEqual([])
    expect(sortDevices([dev({ serial: 'A' })])).toHaveLength(1)
  })

  it('不改动入参数组', () => {
    const list = [dev({ serial: 'C', status: 'offline' }), dev({ serial: 'A' })]
    const before = list.map((d) => d.serial)
    sortDevices(list)
    expect(list.map((d) => d.serial)).toEqual(before)
  })
})

describe('设备栏统计', () => {
  it('统计总数 / 在线数 / 未授权数', () => {
    const list = [
      dev({ serial: 'A', status: 'device' }),
      dev({ serial: 'B', status: 'device', transport: 'wireless' }),
      dev({ serial: 'C', status: 'unauthorized' }),
      dev({ serial: 'D', status: 'offline' }),
    ]
    expect(summarize(list)).toEqual({ total: 4, online: 2, unauthorized: 1 })
  })

  it('空列表全 0', () => {
    expect(summarize([])).toEqual({ total: 0, online: 0, unauthorized: 0 })
  })
})

describe('活动设备保持', () => {
  it('原活动设备还在就保持', () => {
    expect(nextActiveSerial('B', [{ serial: 'A' }, { serial: 'B' }])).toBe('B')
  })

  it('原活动设备消失就选第一个', () => {
    expect(nextActiveSerial('Z', [{ serial: 'A' }, { serial: 'B' }])).toBe('A')
  })

  it('没有设备时为 null', () => {
    expect(nextActiveSerial('Z', [])).toBeNull()
    expect(nextActiveSerial(null, [])).toBeNull()
  })
})

describe('快照指纹（裁决 5：不变就不推送）', () => {
  it('同一设备同样字段生成同一指纹', () => {
    expect(deviceFingerprint(dev({ serial: 'A' }))).toBe(deviceFingerprint(dev({ serial: 'A' })))
  })

  it('lastSeenAt 变化不算变化（否则每轮轮询都会推一次）', () => {
    const a = dev({ serial: 'A', lastSeenAt: 1 })
    const b = dev({ serial: 'A', lastSeenAt: 999999 })
    expect(deviceFingerprint(a)).toBe(deviceFingerprint(b))
    expect(snapshotFingerprint({ devices: [a], adb: { state: 'ok', path: 'C:/adb.exe', version: '1.0.41', source: 'path' } })).toBe(
      snapshotFingerprint({ devices: [b], adb: { state: 'ok', path: 'C:/adb.exe', version: '1.0.41', source: 'path' } }),
    )
  })

  it('status / model / battery / 在线集合变化都会改变指纹', () => {
    const base = dev({ serial: 'A' })
    expect(deviceFingerprint(base)).not.toBe(deviceFingerprint({ ...base, status: 'offline' }))
    expect(deviceFingerprint(base)).not.toBe(deviceFingerprint({ ...base, model: 'Pixel 7' }))
    expect(deviceFingerprint(base)).not.toBe(deviceFingerprint({ ...base, battery: 42 }))
    expect(deviceFingerprint(base)).not.toBe(
      deviceFingerprint({ ...base, storage: { usedKb: 1, totalKb: 2 } }),
    )
  })

  it('设备顺序变化不改变指纹（排序在展示层做）', () => {
    const a = dev({ serial: 'A', model: 'B' })
    const b = dev({ serial: 'B', model: 'A' })
    expect(snapshotFingerprint({ devices: [a, b], adb: { state: 'ok', path: 'C:/adb.exe', version: '1.0.41', source: 'path' } })).toBe(
      snapshotFingerprint({ devices: [b, a], adb: { state: 'ok', path: 'C:/adb.exe', version: '1.0.41', source: 'path' } }),
    )
  })

  it('adb 状态变化改变指纹（路径/版本/来源/错误码任一变化都算）', () => {
    const devices = [dev({ serial: 'A' })]
    const okPath = snapshotFingerprint({
      devices,
      adb: { state: 'ok', path: 'C:/adb.exe', version: '1.0.41', source: 'path' },
    })
    const okOtherPath = snapshotFingerprint({
      devices,
      adb: { state: 'ok', path: 'D:/adb.exe', version: '1.0.41', source: 'custom' },
    })
    const okOtherVersion = snapshotFingerprint({
      devices,
      adb: { state: 'ok', path: 'C:/adb.exe', version: '35.0.2', source: 'path' },
    })
    const errNotFound = snapshotFingerprint({
      devices,
      adb: { state: 'error', code: 'E_ADB_NOT_FOUND', attempts: [] },
    })
    const errShim = snapshotFingerprint({
      devices,
      adb: { state: 'error', code: 'E_ADB_SHIM_UNSUPPORTED', attempts: [] },
    })
    expect(new Set([okPath, okOtherPath, okOtherVersion, errNotFound, errShim]).size).toBe(5)
  })

  it('同一 adb 状态生成同一指纹', () => {
    const ok = { state: 'ok' as const, path: 'C:/adb.exe', version: '1.0.41', source: 'path' as const }
    expect(snapshotFingerprint({ devices: [], adb: ok })).toBe(
      snapshotFingerprint({ devices: [], adb: { ...ok } }),
    )
  })
})

/*
 * 日志里的设备标识。
 *
 * 为什么不是只显示 serial 尾巴：用户对不上「A3P」是哪台机器；
 * 为什么不是只显示型号：两台同型号设备（例如两台一模一样的遥控器）
 * 在日志里会完全无法区分。
 */
describe('日志里的设备标识', () => {
  it('型号 + serial 后 4 位', () => {
    expect(deviceLogTag({ serial: '9N9CN2G0012A3P', model: 'DJI RC Plus 2' }, '9N9CN2G0012A3P'))
      .toBe('DJI RC Plus 2 · 2A3P')
  })

  it('没有型号时只显示尾巴（不出现「· A3P」这种残句）', () => {
    expect(deviceLogTag({ serial: '9N9CN2G0012A3P', model: '  ' }, '9N9CN2G0012A3P')).toBe('2A3P')
    expect(deviceLogTag(undefined, '9N9CN2G0012A3P')).toBe('2A3P')
  })

  it('型号恰好等于尾巴时只说一次（别写成「2A3P · 2A3P」）', () => {
    expect(deviceLogTag({ serial: '2A3P', model: '2A3P' }, '2A3P')).toBe('2A3P')
  })

  it('同型号的两台设备靠尾巴区分', () => {
    const a = deviceLogTag({ serial: 'SERIAL0001AAAA', model: 'DJI RC Plus 2' }, 'SERIAL0001AAAA')
    const b = deviceLogTag({ serial: 'SERIAL0001BBBB', model: 'DJI RC Plus 2' }, 'SERIAL0001BBBB')
    expect(a).not.toBe(b)
  })
})