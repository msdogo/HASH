import { describe, it, expect } from 'vitest'
import { DeviceManager } from '../electron/devices/manager'
import { CH, INVOKE_CHANNELS } from '../electron/ipc/channels'
import { registerHandlers, type HandlerDeps, type IpcMainLike } from '../electron/ipc/handlers'
import type { ShellRunner } from '../electron/fs/remote'
import type { ListResult } from '../electron/fs/remote'
import type { AdbState } from '../src/shared/types'

/* ============ 假 ipcMain：捕获注册表，直接调用 handler ============ */

type Handler = (event: unknown, payload?: unknown) => unknown

function fakeIpc(): { ipc: IpcMainLike; channels: string[]; invoke: (ch: string, payload?: unknown) => Promise<unknown> } {
  const handlers = new Map<string, Handler>()
  const channels: string[] = []
  return {
    channels,
    ipc: {
      handle: (channel, fn) => {
        if (handlers.has(channel)) throw new Error('duplicate handler: ' + channel)
        handlers.set(channel, fn)
        channels.push(channel)
      },
    },
    invoke: async (channel, payload) => {
      const fn = handlers.get(channel)
      if (fn === undefined) throw new Error('no handler: ' + channel)
      return await fn({ sender: { id: 1 } }, payload)
    },
  }
}

const OK_ADB: AdbState = {
  state: 'ok',
  path: 'C:/platform-tools/adb.exe',
  version: '1.0.41',
  source: 'path',
}

const LIST_OK: ListResult = {
  entries: [
    {
      name: 'note.txt',
      isDir: false,
      isLink: false,
      size: 7,
      mtime: 1_700_000_000_000,
      mode: '-rw-------',
      owner: 'u0_a104',
      group: 'u0_a104',
    },
  ],
  degraded: false,
  unparsed: 0,
  usedFallback: false,
  exitCode: 0,
  tzOffsetMinutes: 480,
}

interface Harness {
  ipc: ReturnType<typeof fakeIpc>
  deps: HandlerDeps
  listCalls: Array<{ serial: string; dir: string }>
  clients: string[]
}

function harness(over: Partial<HandlerDeps> = {}): Harness {
  const mgr = new DeviceManager()
  mgr.applySnapshot([{ serial: '9N9CN2G0012A6F', status: 'device', model: 'DJI RC PLUS 2' }])
  const listCalls: Array<{ serial: string; dir: string }> = []
  const clients: string[] = []
  const deps: HandlerDeps = {
    devices: mgr,
    adbPath: () => 'C:/platform-tools/adb.exe',
    adbState: () => OK_ADB,
    clientFactory: (serial) => {
      clients.push(serial)
      return { serial } as ShellRunner
    },
    fs: {
      list: async (client, adbPath, dir) => {
        listCalls.push({ serial: client.serial ?? '', dir })
        expect(adbPath).toBe('C:/platform-tools/adb.exe')
        return LIST_OK
      },
    },
    ...over,
  }
  const ipc = fakeIpc()
  registerHandlers(deps, ipc.ipc)
  return { ipc, deps, listCalls, clients }
}

describe('IPC handler 注册（裁决 2：白名单）', () => {
  it('注册了全部 invoke 通道，且没有多注册', () => {
    const { ipc } = harness()
    expect([...ipc.channels].sort()).toEqual([...INVOKE_CHANNELS].sort())
    expect(ipc.channels).toContain(CH.DEVICES_LIST)
    expect(ipc.channels).toContain(CH.FS_LIST)
  })

  it('事件通道 devices:changed 不得注册成 handle（推送只能走 webContents.send）', () => {
    const { ipc } = harness()
    expect(ipc.channels).not.toContain(CH.DEVICES_CHANGED)
  })

  it('重复注册同一通道会抛错（防止两处 registerHandlers 互相覆盖）', () => {
    const h = harness()
    const second = fakeIpc()
    registerHandlers(h.deps, second.ipc)
    expect(() => registerHandlers(h.deps, second.ipc)).toThrow(/duplicate/)
  })
})

describe('devices:list', () => {
  it('返回 { ok:true, data:{ devices, adb } }', async () => {
    const { ipc } = harness()
    const result = await ipc.invoke(CH.DEVICES_LIST)
    expect(result).toMatchObject({ ok: true })
    const data = (result as { ok: true; data: { devices: Array<{ serial: string; model?: string }>; adb: AdbState } }).data
    expect(data.devices).toHaveLength(1)
    expect(data.devices[0].serial).toBe('9N9CN2G0012A6F')
    expect(data.devices[0].model).toBe('DJI RC PLUS 2')
    expect(data.adb).toEqual(OK_ADB)
  })

  it('adb 不可用时仍然返回设备表，只是 adb.state 为 error（设备栏据此显示「无法使用 adb」）', async () => {
    const { ipc } = harness({
      adbState: () => ({ state: 'error', code: 'E_ADB_NOT_FOUND', attempts: [] }),
    })
    const result = await ipc.invoke(CH.DEVICES_LIST)
    const data = (result as { ok: true; data: { adb: AdbState } }).data
    expect(data.adb.state).toBe('error')
  })

  it('忽略渲染层传来的多余载荷（不接受外部注入的设备表）', async () => {
    const { ipc } = harness()
    const result = await ipc.invoke(CH.DEVICES_LIST, { devices: [{ serial: 'EVIL' }] })
    const data = (result as { ok: true; data: { devices: Array<{ serial: string }> } }).data
    expect(data.devices.map((d) => d.serial)).toEqual(['9N9CN2G0012A6F'])
  })
})

describe('fs:list（裁决 7：接真实实现）', () => {
  it('合法入参：走 clientFactory(serial) + listDirDetailed，返回 degraded/exitCode', async () => {
    const { ipc, listCalls, clients } = harness()
    const result = await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/sdcard' })
    expect(result).toMatchObject({ ok: true })
    const data = (result as { ok: true; data: Record<string, unknown> }).data
    expect(clients).toEqual(['9N9CN2G0012A6F'])
    expect(listCalls).toEqual([{ serial: '9N9CN2G0012A6F', dir: '/sdcard' }])
    expect(data.entries).toHaveLength(1)
    // 任务 7 要用这两个字段显示「部分文件无法读取」
    expect(data.degraded).toBe(false)
    expect(data.exitCode).toBe(0)
    expect(data.tzOffsetMinutes).toBe(480)
    expect(data.dir).toBe('/sdcard')
  })

  it('目录路径被归一化后返回（消除尾斜杠与 ..，任务 7 直接拿来用）', async () => {
    const { ipc, listCalls } = harness()
    const result = await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/sdcard//DCIM/../DCIM/' })
    const data = (result as { ok: true; data: { dir: string } }).data
    expect(data.dir).toBe('/sdcard/DCIM')
    expect(listCalls[0].dir).toBe('/sdcard/DCIM')
  })

  it('degraded 结果如实透传（partial 不等于失败）', async () => {
    const { ipc } = harness({
      fs: { list: async () => ({ ...LIST_OK, degraded: true, usedFallback: true, unparsed: 3, exitCode: 1 }) },
    })
    const result = await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/proc/1' })
    const data = (result as { ok: true; data: Record<string, unknown> }).data
    expect(data.degraded).toBe(true)
    expect(data.exitCode).toBe(1)
    expect(data.unparsed).toBe(3)
  })

  it.each([
    ['缺 serial', { dir: '/sdcard' }],
    ['缺 dir', { serial: 'S' }],
    ['serial 空串', { serial: '', dir: '/sdcard' }],
    ['dir 空串', { serial: 'S', dir: '' }],
    ['serial 非字符串', { serial: 42, dir: '/sdcard' }],
    ['dir 非字符串', { serial: 'S', dir: ['/sdcard'] }],
    ['载荷是 null', null],
    ['载荷缺失', undefined],
    ['载荷是数组', []],
    ['载荷是字符串', 'serial=S'],
  ])('入参非法（%s）→ { ok:false, error:E_BAD_ARGS } 且不碰 adb', async (_label, payload) => {
    const { ipc, listCalls, clients } = harness()
    const result = await ipc.invoke(CH.FS_LIST, payload)
    expect(result).toEqual({ ok: false, error: 'E_BAD_ARGS' })
    expect(listCalls).toEqual([])
    expect(clients).toEqual([])
  })

  it('未登记的 serial → E_NO_SERIAL（不得凭渲染层给的 serial 就发命令）', async () => {
    const { ipc, listCalls } = harness()
    const result = await ipc.invoke(CH.FS_LIST, { serial: 'NOT-CONNECTED', dir: '/sdcard' })
    expect(result).toEqual({ ok: false, error: 'E_NO_SERIAL' })
    expect(listCalls).toEqual([])
  })

  it('listDirDetailed 抛出的错误码被翻译成统一错误结构，不冒泡异常', async () => {
    const { ipc } = harness({
      fs: { list: async () => { throw new Error('E_NOT_FOUND') } },
    })
    expect(await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/nope' }))
      .toEqual({ ok: false, error: 'E_NOT_FOUND' })
  })

  it('权限错误同样被翻译（E_NO_PERMISSION 原样传出）', async () => {
    const { ipc } = harness({
      fs: { list: async () => { throw new Error('E_NO_PERMISSION') } },
    })
    expect(await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/data' }))
      .toEqual({ ok: false, error: 'E_NO_PERMISSION' })
  })

  it('无法识别的异常 → E_UNKNOWN（渲染层永远能拿到一个错误码）', async () => {
    const { ipc } = harness({
      fs: { list: async () => { throw new Error('socket hang up') } },
    })
    expect(await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/sdcard' }))
      .toEqual({ ok: false, error: 'E_UNKNOWN' })
  })

  it('system 级非 Error 抛出（字符串）也被兜住', async () => {
    const { ipc } = harness({
      fs: { list: async () => { throw 'E_TIMEOUT' } },
    })
    expect(await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/sdcard' }))
      .toEqual({ ok: false, error: 'E_TIMEOUT' })
  })

  it('adb 未定位到（adbPath 为空）时不发命令，直接 E_ADB_NOT_FOUND', async () => {
    const { ipc, listCalls } = harness({ adbPath: () => '' })
    expect(await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/sdcard' }))
      .toEqual({ ok: false, error: 'E_ADB_NOT_FOUND' })
    expect(listCalls).toEqual([])
  })

  it('含换行的路径在校验层就被拒（E_INVALID_PATH），不发命令', async () => {
    const { ipc, listCalls } = harness()
    const result = await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/sdcard/a\nb' })
    expect(result).toEqual({ ok: false, error: 'E_INVALID_PATH' })
    expect(listCalls).toEqual([])
  })
})