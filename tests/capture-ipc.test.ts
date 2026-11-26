import { stubMirrorDeps } from './helpers/mirror-stubs'
import { describe, it, expect } from 'vitest'
import { fakeWindow } from './fake-window'
import { CH } from '../electron/ipc/channels'
import { registerHandlers, type HandlerDeps, type IpcMainLike } from '../electron/ipc/handlers'
import { DeviceManager } from '../electron/devices/manager'
import { E_ADB_NOT_FOUND, E_BAD_ARGS, E_NO_SERIAL, E_NOT_RECORDING, E_RECORD_ACTIVE } from '../src/shared/errors'
import { fakeLocalController } from './fake-local'
import { fakeSettings } from './fake-settings'
import { fakeCapture } from './fake-capture'
import { fakeApps } from './fake-apps'
import { fakeBatch } from './fake-batch'
import { fakeDrag } from './fake-drag'

/*
 * P1 第一批：截图 / 录屏的 IPC 层。
 *
 * 只测 IPC 层该负责的事：zod 校验、会话检查、错误码收敛。
 * 命令编排与清理时机在 tests/capture-service.test.ts（假 client 逐条断言）。
 */

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  return {
    handlers,
    ipc: {
      handle: (channel: string, listener: (event: unknown, payload?: unknown) => unknown): void => {
        handlers.set(channel, listener)
      },
    } as IpcMainLike,
    invoke: async (channel: string, payload?: unknown): Promise<unknown> => {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error('no handler: ' + channel)
      return handler(undefined, payload)
    },
  }
}

function harness(options: { adbPath?: string; hasDevice?: boolean; capture?: ReturnType<typeof fakeCapture> } = {}) {
  const mgr = new DeviceManager()
  if (options.hasDevice !== false) {
    mgr.applySnapshot([{ serial: 'S1', status: 'device', transport: 'usb' }])
  }
  const capture = options.capture ?? fakeCapture()
  const deps: HandlerDeps = {
    devices: mgr,
    adbPath: () => options.adbPath ?? 'C:/adb.exe',
    adbState: () => ({ state: 'ok', path: 'C:/adb.exe', version: '1.0.41', source: 'path' }),
    clientFactory: (serial) => ({ serial }) as never,
    fs: { list: async () => ({ entries: [], degraded: false, unparsed: 0, usedFallback: false, exitCode: 0, tzOffsetMinutes: 0 }) },
    pickFiles: async () => [],
    ops: {
      mkdir: async () => ({ ok: true }),
      rename: async () => ({ ok: true }),
      removeFacts: async () => ({ count: 0, names: [], truncated: false, hasNonEmptyDir: false, blocked: [] }),
      remove: async () => ({ results: [] }),
      copy: async () => ({ results: [] }),
      move: async () => ({ results: [] }),
    },
    local: fakeLocalController('C:/Users/me'),
    pickRoot: async () => '',
    settings: fakeSettings(),
    pickDownloadDir: async () => '',
    transfer: {
      enqueue: async () => { throw new Error('not used') },
      cancel: () => false,
      retry: () => false,
      get: () => undefined,
      snapshot: () => ({ tasks: [], running: 0, queued: 0 }),
      clearFinished: () => 0,
    },
    batch: fakeBatch(),
    capture,
    // P1 第二批：本文件不测应用管理，空壳只为满足 HandlerDeps
    apps: fakeApps(),
    pickApk: async () => '',
    windowOf: () => fakeWindow(),
    closeWindowOf: () => undefined,
    openSettings: () => undefined,
    // 本文件不测投屏/按键：空壳只为满足 HandlerDeps（见 tests/mirror-*.test.ts）
    ...stubMirrorDeps(),
    emitInstallProgress: () => undefined,
    drag: fakeDrag(),
  }
  const ipc = fakeIpc()
  registerHandlers(deps, ipc.ipc)
  return { invoke: ipc.invoke, capture }
}

describe('截图通道', () => {
  it('三个通道都注册了（漏一个就是渲染层点了没反应）', () => {
    const { invoke } = harness()
    for (const channel of [CH.CAPTURE_SCREENSHOT, CH.CAPTURE_RECORD_START, CH.CAPTURE_RECORD_STOP]) {
      expect(channel).toMatch(/^capture:/)
    }
    expect(invoke).toBeTypeOf('function')
  })

  it('转发 serial 与 dstDir 给服务层（IPC 层不做业务判断）', async () => {
    const { invoke, capture } = harness()
    const result = await invoke(CH.CAPTURE_SCREENSHOT, { serial: 'S1', dstDir: 'C:/shots' })
    expect(result).toMatchObject({ ok: true })
    expect(capture.calls).toContainEqual({ method: 'screenshot', args: ['S1', 'C:/shots'] })
  })

  it('dstDir 允许空串（= 用设置里的默认下载路径）', async () => {
    const { invoke, capture } = harness()
    await invoke(CH.CAPTURE_SCREENSHOT, { serial: 'S1', dstDir: '' })
    expect(capture.calls).toContainEqual({ method: 'screenshot', args: ['S1', ''] })
  })

  it('载荷不合法 → E_BAD_ARGS（校验失败绝不抛异常穿过 ipcMain.handle）', async () => {
    const { invoke } = harness()
    expect(await invoke(CH.CAPTURE_SCREENSHOT, { serial: '', dstDir: '' })).toEqual({ ok: false, error: E_BAD_ARGS })
    expect(await invoke(CH.CAPTURE_SCREENSHOT, { serial: 'S1' })).toEqual({ ok: false, error: E_BAD_ARGS })
    expect(await invoke(CH.CAPTURE_SCREENSHOT, null)).toEqual({ ok: false, error: E_BAD_ARGS })
  })

  it('serial 不是已建立的会话 → E_NO_SERIAL（渲染层不能凭字符串命令任意设备）', async () => {
    const { invoke } = harness()
    expect(await invoke(CH.CAPTURE_SCREENSHOT, { serial: 'NOPE', dstDir: '' })).toEqual({ ok: false, error: E_NO_SERIAL })
  })

  it('adb 还没定位到 → E_ADB_NOT_FOUND，不发任何命令', async () => {
    const { invoke, capture } = harness({ adbPath: '' })
    expect(await invoke(CH.CAPTURE_SCREENSHOT, { serial: 'S1', dstDir: '' })).toEqual({ ok: false, error: E_ADB_NOT_FOUND })
    expect(capture.calls).toHaveLength(0)
  })
})

describe('录屏通道', () => {
  it('开始录屏转发 serial + dstDir', async () => {
    const { invoke, capture } = harness()
    const result = await invoke(CH.CAPTURE_RECORD_START, { serial: 'S1', dstDir: '' })
    expect(result).toMatchObject({ ok: true })
    expect(capture.calls).toContainEqual({ method: 'startRecord', args: ['S1', ''] })
  })

  it('停止录屏只需 serial', async () => {
    const { invoke, capture } = harness()
    await invoke(CH.CAPTURE_RECORD_STOP, { serial: 'S1' })
    expect(capture.calls).toContainEqual({ method: 'stopRecord', args: ['S1'] })
  })

  it('服务层的 E_RECORD_ACTIVE / E_NOT_RECORDING 原样透传（不被吞成 E_UNKNOWN）', async () => {
    const capture = fakeCapture()
    const { invoke } = harness({
      capture: {
        ...capture,
        startRecord: async () => { throw new Error(E_RECORD_ACTIVE) },
        stopRecord: async () => { throw new Error(E_NOT_RECORDING) },
      },
    })
    expect(await invoke(CH.CAPTURE_RECORD_START, { serial: 'S1', dstDir: '' })).toEqual({ ok: false, error: E_RECORD_ACTIVE })
    expect(await invoke(CH.CAPTURE_RECORD_STOP, { serial: 'S1' })).toEqual({ ok: false, error: E_NOT_RECORDING })
  })

  it('停止录屏的载荷不合法 → E_BAD_ARGS', async () => {
    const { invoke } = harness()
    expect(await invoke(CH.CAPTURE_RECORD_STOP, {})).toEqual({ ok: false, error: E_BAD_ARGS })
  })
})
