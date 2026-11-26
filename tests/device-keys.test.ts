import { describe, it, expect } from 'vitest'
import { createKeyService } from '../electron/device/keys'
import type { DeviceSession } from '../src/shared/types'
import { E_ADB_NOT_FOUND, E_BAD_ARGS, E_DEVICE_OFFLINE, E_NO_SERIAL } from '../src/shared/errors'

/** 假 client：记录调用参数，返回预设结果。 */
function fakeClient(result: { code: number | null; stdout: string; stderr: string }) {
  const calls: string[][] = []
  return {
    calls,
    run: async (args: string[]) => {
      calls.push(args)
      return result
    },
  }
}

const online = (serial: string): DeviceSession => ({
  serial,
  status: 'device',
  transport: 'usb',
  lastSeenAt: 0,
})

const makeDevices = (map: Record<string, DeviceSession | undefined>) => ({
  get: (serial: string) => map[serial],
})

describe('createKeyService', () => {
  it('back → shell input keyevent 4', async () => {
    const client = fakeClient({ code: 0, stdout: '', stderr: '' })
    const svc = createKeyService({
      devices: makeDevices({ S1: online('S1') }),
      clientFor: () => client,
      adbPath: () => 'C:\\pt\\adb.exe',
    })
    await svc.press('S1', 'back')
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]).toEqual(['shell', 'input', 'keyevent', '4'])
  })

  it('home → 3，recents → 187（三键都要对上）', async () => {
    const client = fakeClient({ code: 0, stdout: '', stderr: '' })
    const svc = createKeyService({
      devices: makeDevices({ S1: online('S1') }),
      clientFor: () => client,
      adbPath: () => 'adb.exe',
    })
    await svc.press('S1', 'home')
    await svc.press('S1', 'recents')
    expect(client.calls[0]).toEqual(['shell', 'input', 'keyevent', '3'])
    expect(client.calls[1]).toEqual(['shell', 'input', 'keyevent', '187'])
  })

  it('音量与电源也走同一条命令形态', async () => {
    const client = fakeClient({ code: 0, stdout: '', stderr: '' })
    const svc = createKeyService({
      devices: makeDevices({ S1: online('S1') }),
      clientFor: () => client,
      adbPath: () => 'adb.exe',
    })
    await svc.press('S1', 'volumeUp')
    await svc.press('S1', 'volumeDown')
    await svc.press('S1', 'power')
    expect(client.calls.map((c) => c[3])).toEqual(['24', '25', '26'])
  })

  it('未知按键被拒绝，且一条命令都不发', async () => {
    const client = fakeClient({ code: 0, stdout: '', stderr: '' })
    const svc = createKeyService({
      devices: makeDevices({ S1: online('S1') }),
      clientFor: () => client,
      adbPath: () => 'adb.exe',
    })
    await expect(svc.press('S1', 'nope' as never)).rejects.toThrow(E_BAD_ARGS)
    expect(client.calls).toHaveLength(0)
  })

  it('注入尝试（命令片段当键名）被拒绝，且不发命令', async () => {
    const client = fakeClient({ code: 0, stdout: '', stderr: '' })
    const svc = createKeyService({
      devices: makeDevices({ S1: online('S1') }),
      clientFor: () => client,
      adbPath: () => 'adb.exe',
    })
    await expect(svc.press('S1', '4; rm -rf /sdcard' as never)).rejects.toThrow(E_BAD_ARGS)
    expect(client.calls).toHaveLength(0)
  })

  it('设备不在会话表 → E_NO_SERIAL', async () => {
    const client = fakeClient({ code: 0, stdout: '', stderr: '' })
    const svc = createKeyService({
      devices: makeDevices({}),
      clientFor: () => client,
      adbPath: () => 'adb.exe',
    })
    await expect(svc.press('S1', 'home')).rejects.toThrow(E_NO_SERIAL)
    expect(client.calls).toHaveLength(0)
  })

  it('设备离线 → E_DEVICE_OFFLINE，不发命令', async () => {
    const client = fakeClient({ code: 0, stdout: '', stderr: '' })
    const svc = createKeyService({
      devices: makeDevices({ S1: { serial: 'S1', status: 'offline', transport: 'usb', lastSeenAt: 0 } }),
      clientFor: () => client,
      adbPath: () => 'adb.exe',
    })
    await expect(svc.press('S1', 'home')).rejects.toThrow(E_DEVICE_OFFLINE)
    expect(client.calls).toHaveLength(0)
  })

  it('adb 未定位 → E_ADB_NOT_FOUND（先于会话检查）', async () => {
    const client = fakeClient({ code: 0, stdout: '', stderr: '' })
    const svc = createKeyService({
      devices: makeDevices({}),
      clientFor: () => client,
      adbPath: () => '',
    })
    await expect(svc.press('S1', 'home')).rejects.toThrow(E_ADB_NOT_FOUND)
    expect(client.calls).toHaveLength(0)
  })

  it('adb 命令非 0 退出 → E_DEVICE_OFFLINE', async () => {
    const client = fakeClient({ code: 1, stdout: '', stderr: 'error: device offline' })
    const svc = createKeyService({
      devices: makeDevices({ S1: online('S1') }),
      clientFor: () => client,
      adbPath: () => 'adb.exe',
    })
    await expect(svc.press('S1', 'back')).rejects.toThrow(E_DEVICE_OFFLINE)
  })

  it('adbPath 每次现取（自检晚于构造完成）', async () => {
    let adb = ''
    const client = fakeClient({ code: 0, stdout: '', stderr: '' })
    const svc = createKeyService({
      devices: makeDevices({ S1: online('S1') }),
      clientFor: () => client,
      adbPath: () => adb,
    })
    await expect(svc.press('S1', 'back')).rejects.toThrow(E_ADB_NOT_FOUND)
    adb = 'adb.exe'
    await svc.press('S1', 'back')
    expect(client.calls).toHaveLength(1)
  })
})
