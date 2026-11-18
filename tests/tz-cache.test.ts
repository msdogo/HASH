import { describe, it, expect, afterEach } from 'vitest'
import { DeviceManager } from '../electron/devices/manager'
import {
  clearDeviceSerialTzCache,
  clearDeviceTzCache,
  listDirDetailed,
  parseTzOffset,
  resolveDeviceTz,
  type ShellRunner,
} from '../electron/fs/remote'

interface FakeClient extends ShellRunner {
  commands: string[]
}

/** 假 adb：date +%z 返回指定时区；ls 返回一行合法条目。 */
function fakeClient(tz: string, serial: string): FakeClient {
  const client: FakeClient = {
    serial,
    commands: [],
    run: async (args) => {
      client.commands.push(args[1])
      if (/^date \+%z$/.test(args[1])) return { code: 0, stdout: tz + '\r\n', stderr: '' }
      return {
        code: 0,
        stdout:
          'total 1\n' +
          '-rw------- 1 u0_a104 u0_a104 7 2026-11-18 16:54 note.txt\r\n',
        stderr: '',
      }
    },
  }
  return client
}

const tzQueries = (client: FakeClient): number =>
  client.commands.filter((c) => c === 'date +%z').length

afterEach(() => { clearDeviceTzCache() })

describe('时区缓存失效路径（裁决 6 / 任务 5 N1）', () => {
  it('同一 serial 只查一次设备时区（缓存命中）', async () => {
    const client = fakeClient('+0800', 'DEV-CACHE')
    await resolveDeviceTz(client, 'C:/adb.exe')
    await resolveDeviceTz(client, 'C:/adb.exe')
    await resolveDeviceTz(client, 'C:/adb.exe')
    expect(tzQueries(client)).toBe(1)
  })

  it('设备重连清掉该 serial 的缓存后会重新查询（时区可能已变）', async () => {
    const before = fakeClient('+0800', 'DEV-RECONNECT')
    expect(await resolveDeviceTz(before, 'C:/adb.exe')).toBe(480)

    // 用户把设备时区改成 -0500 再重连
    clearDeviceSerialTzCache('DEV-RECONNECT')
    const after = fakeClient('-0500', 'DEV-RECONNECT')
    expect(await resolveDeviceTz(after, 'C:/adb.exe')).toBe(-300)
    expect(tzQueries(after)).toBe(1)
  })

  it('清缓存只清指定 serial，不牵连其它设备与别的 adb 路径', async () => {
    const a = fakeClient('+0800', 'DEV-A')
    const b = fakeClient('+0530', 'DEV-B')
    await resolveDeviceTz(a, 'C:/adb.exe')
    await resolveDeviceTz(b, 'C:/adb.exe')
    clearDeviceSerialTzCache('DEV-A')
    await resolveDeviceTz(b, 'C:/adb.exe')
    expect(tzQueries(a)).toBe(1)
    expect(tzQueries(b)).toBe(1)
    expect(await resolveDeviceTz(a, 'C:/adb.exe')).toBe(480)
  })

  it('清一个不存在的 serial 不抛错', () => {
    expect(() => clearDeviceSerialTzCache('NOPE')).not.toThrow()
  })

  it('旧的全清接口仍然可用（测试用）', async () => {
    const client = fakeClient('+0800', 'DEV-CLEAR')
    await resolveDeviceTz(client, 'C:/adb.exe')
    clearDeviceTzCache()
    await resolveDeviceTz(client, 'C:/adb.exe')
    expect(tzQueries(client)).toBe(2)
  })

  it('listDirDetailed 用的就是缓存后的偏移，时间按设备时区换算', async () => {
    const client = fakeClient('+0800', 'DEV-LIST')
    const first = await listDirDetailed(client, 'C:/adb.exe', '/sdcard')
    expect(first.tzOffsetMinutes).toBe(480)
    expect(first.entries[0].mtime).toBe(Date.UTC(2026, 10, 18, 8, 54, 0))
    // 第二次列目录不应再查时区
    await listDirDetailed(client, 'C:/adb.exe', '/sdcard')
    expect(tzQueries(client)).toBe(1)
  })

  it('parseTzOffset 解析 +0800 / -0500 / +0530', () => {
    expect(parseTzOffset('+0800')).toBe(480)
    expect(parseTzOffset('-0500')).toBe(-300)
    expect(parseTzOffset('+05:30')).toBe(330)
    expect(parseTzOffset('')).toBeUndefined()
  })
})
describe('设备掉线/重连时清时区缓存（裁决 6 的接线，不只是函数存在）', () => {
  it('设备从在线变离线、再变回在线，各清一次该 serial 的缓存', async () => {
    const { DeviceChangeTracker } = await import('../electron/app/device-changed')
    const mgr = new DeviceManager()
    const cleared: string[] = []
    const tracker = new DeviceChangeTracker(mgr, (serial) => { cleared.push(serial) })
    // 让 tracker 先把「A 在线」记进基线
    mgr.applySnapshot([{ serial: 'A', status: 'device' }])
    expect(cleared).toEqual([])
    // 掉线
    mgr.markLost('A')
    expect(cleared).toEqual(['A'])
    // 重连
    mgr.applySnapshot([{ serial: 'A', status: 'device' }])
    expect(cleared).toEqual(['A', 'A'])
    tracker.dispose()
  })

  it('状态在「非在线」之间来回（unauthorized ↔ offline）不算边界，不清缓存', async () => {
    const { DeviceChangeTracker } = await import('../electron/app/device-changed')
    const mgr = new DeviceManager()
    const cleared: string[] = []
    const tracker = new DeviceChangeTracker(mgr, (serial) => { cleared.push(serial) })
    mgr.applySnapshot([{ serial: 'A', status: 'unauthorized' }])
    mgr.applySnapshot([{ serial: 'A', status: 'offline' }])
    expect(cleared).toEqual([])
    tracker.dispose()
  })

  it('dispose 之后不再清缓存（退出后不做无用功）', async () => {
    const { DeviceChangeTracker } = await import('../electron/app/device-changed')
    const mgr = new DeviceManager()
    const cleared: string[] = []
    const tracker = new DeviceChangeTracker(mgr, (serial) => { cleared.push(serial) })
    mgr.applySnapshot([{ serial: 'A', status: 'device' }])
    tracker.dispose()
    mgr.markLost('A')
    expect(cleared).toEqual([])
  })
})
