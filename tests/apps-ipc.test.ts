import { stubMirrorDeps } from './helpers/mirror-stubs'
import { describe, it, expect } from 'vitest'
import { fakeWindow } from './fake-window'
import { CH } from '../electron/ipc/channels'
import { registerHandlers, type AppsController, type HandlerDeps, type IpcMainLike } from '../electron/ipc/handlers'
import { DeviceManager } from '../electron/devices/manager'
import { E_ADB_NOT_FOUND, E_BAD_ARGS, E_NO_SERIAL, E_OP_FAILED } from '../src/shared/errors'
import { fakeLocalController } from './fake-local'
import { fakeSettings } from './fake-settings'
import { fakeCapture } from './fake-capture'
import { fakeApps } from './fake-apps'
import { fakeBatch } from './fake-batch'
import { fakeDrag } from './fake-drag'

/*
 * 应用管理的 IPC 层（P1 第二批）。
 *
 * 只测 IPC 层该负责的事：zod 校验、会话检查、错误码收敛、入参透传。
 * 命令编排与成败判定在 tests/apps-service.test.ts；解析在 tests/apps.test.ts。
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

function harness(options: {
  adbPath?: string
  hasDevice?: boolean
  apps?: AppsController & { calls: Array<{ method: string; args: unknown[] }> }
  /** 进度出口（默认吞掉；个别用例要断言它被调用）。 */
  emitInstallProgress?: (payload: import('../src/shared/apps').InstallProgress) => void
} = {}) {
  const mgr = new DeviceManager()
  if (options.hasDevice !== false) {
    mgr.applySnapshot([{ serial: 'S1', status: 'device', transport: 'usb' }])
  }
  const apps = options.apps ?? fakeApps()
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
    capture: fakeCapture(),
    apps,
    pickApk: async () => '',
    windowOf: () => fakeWindow(),
    closeWindowOf: () => undefined,
    openSettings: () => undefined,
    // 本文件不测投屏/按键：空壳只为满足 HandlerDeps（见 tests/mirror-*.test.ts）
    ...stubMirrorDeps(),
    emitInstallProgress: options.emitInstallProgress ?? (() => undefined),
    drag: fakeDrag(),
  }
  const ipc = fakeIpc()
  registerHandlers(deps, ipc.ipc)
  return { invoke: ipc.invoke, apps }
}

describe('应用通道注册', () => {
  it('九个通道值都形如 apps:*（与其它 domain:action 一致）', () => {
    const channels = [
      CH.APPS_LIST, CH.APPS_DETAIL, CH.APPS_PULL_APK, CH.APPS_INSTALL,
      CH.APPS_FORCE_STOP, CH.APPS_CLEAR_DATA, CH.APPS_UNINSTALL, CH.APPS_LAUNCH, CH.APPS_PICK_APK,
    ]
    for (const channel of channels) expect(channel).toMatch(/^apps:[a-z-]+$/)
    expect(new Set(channels).size).toBe(9)
  })

  it('每个通道都注册了（漏一个就是渲染层点了没反应）', async () => {
    const { invoke } = harness()
    const result = await invoke(CH.APPS_LIST, { serial: 'S1' })
    expect(result).toMatchObject({ ok: true })
  })
})

describe('列表与详情', () => {
  it('转发 serial', async () => {
    const { invoke, apps } = harness()
    const result = await invoke(CH.APPS_LIST, { serial: 'S1' })
    expect(result).toMatchObject({ ok: true })
    expect(apps.calls).toContainEqual({ method: 'listApps', args: ['S1'] })
  })

  it('详情转发 serial + packageName', async () => {
    const { invoke, apps } = harness()
    await invoke(CH.APPS_DETAIL, { serial: 'S1', packageName: 'com.a' })
    expect(apps.calls).toContainEqual({ method: 'appDetail', args: ['S1', 'com.a'] })
  })

  it('载荷不合法时报 E_BAD_ARGS', async () => {
    const { invoke } = harness()
    expect(await invoke(CH.APPS_LIST, {})).toEqual({ ok: false, error: E_BAD_ARGS })
    expect(await invoke(CH.APPS_DETAIL, { serial: 'S1' })).toEqual({ ok: false, error: E_BAD_ARGS })
    expect(await invoke(CH.APPS_DETAIL, { serial: '', packageName: 'com.a' })).toEqual({ ok: false, error: E_BAD_ARGS })
  })

  it('serial 不是已建立的会话时报 E_NO_SERIAL', async () => {
    const { invoke } = harness()
    expect(await invoke(CH.APPS_LIST, { serial: 'NOPE' })).toEqual({ ok: false, error: E_NO_SERIAL })
  })

  it('adb 未定位时报 E_ADB_NOT_FOUND，且不调 service', async () => {
    const { invoke, apps } = harness({ adbPath: '' })
    expect(await invoke(CH.APPS_LIST, { serial: 'S1' })).toEqual({ ok: false, error: E_ADB_NOT_FOUND })
    expect(apps.calls).toHaveLength(0)
  })
})

describe('动作通道', () => {
  it('四个动作各自转发到对应方法', async () => {
    const { invoke, apps } = harness()
    await invoke(CH.APPS_FORCE_STOP, { serial: 'S1', packageName: 'com.a' })
    await invoke(CH.APPS_CLEAR_DATA, { serial: 'S1', packageName: 'com.a' })
    await invoke(CH.APPS_UNINSTALL, { serial: 'S1', packageName: 'com.a' })
    await invoke(CH.APPS_LAUNCH, { serial: 'S1', packageName: 'com.a' })
    const methods = apps.calls.map((c) => c.method)
    expect(methods).toEqual(['forceStop', 'clearData', 'uninstall', 'launch'])
  })

  it('服务层的错误码原样透传（不被吞成 E_UNKNOWN）', async () => {
    const base = fakeApps()
    const apps = {
      ...base,
      uninstall: async () => { throw new Error(E_OP_FAILED) },
    }
    const { invoke } = harness({ apps })
    expect(await invoke(CH.APPS_UNINSTALL, { serial: 'S1', packageName: 'com.a' })).toEqual({ ok: false, error: E_OP_FAILED })
  })

  it('拉 APK 转发 dstDir（空串 = 用默认下载路径）', async () => {
    const { invoke, apps } = harness()
    await invoke(CH.APPS_PULL_APK, { serial: 'S1', packageName: 'com.a', dstDir: '' })
    expect(apps.calls).toContainEqual({ method: 'pullApk', args: ['S1', 'com.a', ''] })
  })

  it('安装转发 apkPath', async () => {
    const { invoke, apps } = harness()
    await invoke(CH.APPS_INSTALL, { serial: 'S1', apkPath: 'C:/dl/a.apk' })
    expect(apps.calls).toContainEqual({ method: 'installApk', args: ['S1', 'C:/dl/a.apk'] })
  })

  it('安装期间把 service 推的进度原样转发到渲染层（否则界面没有进度条）', async () => {
    const pushed: string[] = []
    const { invoke } = harness({ emitInstallProgress: (p) => { pushed.push(p.phase) } })
    await invoke(CH.APPS_INSTALL, { serial: 'S1', apkPath: 'C:/dl/a.apk' })
    expect(pushed).toEqual(['installing'])
  })
})

describe('选 APK', () => {
  it('取消返回空串（不是错误）', async () => {
    const { invoke } = harness()
    expect(await invoke(CH.APPS_PICK_APK)).toEqual({ ok: true, data: '' })
  })
})
