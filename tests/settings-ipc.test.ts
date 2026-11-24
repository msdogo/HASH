import { describe, it, expect } from 'vitest'
import { CH } from '../electron/ipc/channels'
import { registerHandlers, type HandlerDeps, type IpcMainLike } from '../electron/ipc/handlers'
import { DeviceManager } from '../electron/devices/manager'
import { E_ADB_NOT_FOUND, E_BAD_ARGS, E_NOT_FOUND } from '../src/shared/errors'
import { fakeBatch } from './fake-batch'
import { fakeDrag } from './fake-drag'
import { fakeLocalController } from './fake-local'
import { fakeSettings } from './fake-settings'
import type { SettingsData } from '../src/shared/settings'

/*
 * R2-2：设置通道的 IPC 层行为。
 *
 * 断言的全是**行为**（返回值 / 会话调用 / 入参透传），没有一条源码文本匹配：
 *   - settings:get 返回的那份快照，字段必须来自注入的 SettingsController 与 adb 状态；
 *   - settings:set-download-dir 的入参必须逐字透传给控制器；控制器抛错时收敛成错误码；
 *   - pick 通道不落盘（只把路径交回渲染层），取消返回空串不是错误；
 *   - reset 走的是控制器的 reset，而不是渲染层自己拼一个默认路径。
 */

interface Harness {
  invoke: (ch: string, payload?: unknown) => Promise<unknown>
  settings: ReturnType<typeof fakeSettings>
  picked: string[]
  channels: string[]
}

function harness(over: Partial<HandlerDeps> = {}, options: {
  settings?: ReturnType<typeof fakeSettings>
  pickResult?: string
  pickThrows?: boolean
} = {}): Harness {
  const mgr = new DeviceManager()
  mgr.applySnapshot([{ serial: 'S1', status: 'device', transport: 'usb' }])
  const settings = options.settings ?? fakeSettings()
  const picked: string[] = []
  const deps: HandlerDeps = {
    devices: mgr,
    adbPath: () => 'C:/adb.exe',
    adbState: () => ({ state: 'ok', path: 'C:/platform-tools/adb.exe', version: '1.0.41', source: 'bundled' }),
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
    settings,
    pickDownloadDir: async () => {
      if (options.pickThrows === true) throw new Error(E_NOT_FOUND)
      picked.push(options.pickResult ?? 'D:/picked/downloads')
      return options.pickResult ?? 'D:/picked/downloads'
    },
    batch: fakeBatch(),
    drag: fakeDrag(),
    transfer: {
      enqueue: async () => { throw new Error('not used') },
      cancel: () => false,
      retry: () => false,
      get: () => undefined,
      snapshot: () => ({ tasks: [], running: 0, queued: 0 }),
      clearFinished: () => 0,
    },
    ...over,
  }
  const channels: string[] = []
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  const ipc: IpcMainLike = {
    handle: (channel, listener) => { channels.push(channel); handlers.set(channel, listener) },
  }
  registerHandlers(deps, ipc)
  return {
    channels,
    settings,
    picked,
    invoke: async (ch, payload) => handlers.get(ch)?.({}, payload),
  }
}

describe('R2-2 设置通道登记', () => {
  it('四个通道值逐字一致，且都注册成 handle', () => {
    expect(CH.SETTINGS_GET).toBe('settings:get')
    expect(CH.SETTINGS_SET_DOWNLOAD_DIR).toBe('settings:set-download-dir')
    expect(CH.SETTINGS_PICK_DOWNLOAD_DIR).toBe('settings:pick-download-dir')
    expect(CH.SETTINGS_RESET_DOWNLOAD_DIR).toBe('settings:reset-download-dir')
    const h = harness()
    for (const channel of [CH.SETTINGS_GET, CH.SETTINGS_SET_DOWNLOAD_DIR, CH.SETTINGS_PICK_DOWNLOAD_DIR, CH.SETTINGS_RESET_DOWNLOAD_DIR]) {
      expect(h.channels).toContain(channel)
    }
  })
})

describe('R2-2 settings:get 返回一份完整快照', () => {
  it('downloadDir 来自控制器，adb 来自 adbState（含来源 / 路径 / 版本）', async () => {
    const h = harness({}, { settings: fakeSettings({ downloadDir: 'D:/Downloads', defaultDownloadDir: 'C:/Users/me/Downloads' }) })
    const result = await h.invoke(CH.SETTINGS_GET, null) as { ok: true; data: SettingsData }
    expect(result.ok).toBe(true)
    expect(result.data.downloadDir).toBe('D:/Downloads')
    expect(result.data.defaultDownloadDir).toBe('C:/Users/me/Downloads')
    expect(result.data.adb).toEqual({ state: 'ok', source: 'bundled', path: 'C:/platform-tools/adb.exe', version: '1.0.41' })
  })

  it('adb 还在自检时返回 checking（界面据此显示「正在查找 adb…」而不是「无」）', async () => {
    const h = harness({ adbState: () => ({ state: 'checking' }) })
    const result = await h.invoke(CH.SETTINGS_GET, null) as { ok: true; data: SettingsData }
    expect(result.data.adb).toEqual({ state: 'checking' })
  })

  it('adb 自检失败时带错误码（界面翻成中文人话）', async () => {
    const h = harness({ adbState: () => ({ state: 'error', code: E_ADB_NOT_FOUND, attempts: [] }) })
    const result = await h.invoke(CH.SETTINGS_GET, null) as { ok: true; data: SettingsData }
    expect(result.data.adb).toEqual({ state: 'error', code: E_ADB_NOT_FOUND })
  })

  it('控制器读设置抛异常时收敛成错误码，不把异常穿过 IPC', async () => {
    const broken = fakeSettings()
    const h = harness({
      settings: { ...broken, getDownloadDir: () => { throw new Error(E_NOT_FOUND) } },
    })
    const result = await h.invoke(CH.SETTINGS_GET, null) as { ok: false; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe(E_NOT_FOUND)
  })
})

describe('R7 版本号：settingsSnapshot 的 appVersion 来自控制器的 getAppVersion', () => {
  /*
   * 这一组证明的是**行为**：版本号是「控制器的返回值」透传出来的，而不是 IPC 层
   * 自己写了一个常量。所以每个用例都换不同的版本值 —— 若实现里写死 '0.1.0'
   * （package.json 的真实版本），第一条就会红。
   */
  it('settings:get 返回的 appVersion 逐字等于控制器给的值', async () => {
    const h = harness({}, { settings: fakeSettings({ appVersion: '9.9.9' }) })
    const result = await h.invoke(CH.SETTINGS_GET, null) as { ok: true; data: SettingsData }
    expect(result.ok).toBe(true)
    expect(result.data.appVersion).toBe('9.9.9')
    // 反向：真实版本号不得凭空出现在快照里（说明取的是注入值，不是 package.json）
    expect(result.data.appVersion).not.toBe('0.1.0')
  })

  it('换一个版本值，快照跟着变（不是写死的常量）', async () => {
    for (const version of ['0.1.0', '2.3.4-beta.7', '10.0.0']) {
      const h = harness({}, { settings: fakeSettings({ appVersion: version }) })
      const result = await h.invoke(CH.SETTINGS_GET, null) as { ok: true; data: SettingsData }
      expect(result.data.appVersion, version).toBe(version)
    }
  })

  it('set / reset 之后返回的快照同样带版本号（界面上不会突然少一行）', async () => {
    const h = harness({}, { settings: fakeSettings({ appVersion: '9.9.9' }) })
    const set = await h.invoke(CH.SETTINGS_SET_DOWNLOAD_DIR, { downloadDir: 'D:/new/downloads' }) as { ok: true; data: SettingsData }
    expect(set.data.appVersion).toBe('9.9.9')
    const reset = await h.invoke(CH.SETTINGS_RESET_DOWNLOAD_DIR, null) as { ok: true; data: SettingsData }
    expect(reset.data.appVersion).toBe('9.9.9')
    // 两个通道各自重新拼了一份快照 —— 每次都是真的问了控制器，不是缓存第一次的值
    expect(h.settings.calls.filter((call) => call.method === 'getAppVersion').length).toBe(2)
  })

  it('取版本抛异常时收敛成错误码，不把异常穿过 IPC', async () => {
    const broken = fakeSettings()
    const h = harness({
      settings: { ...broken, getAppVersion: () => { throw new Error(E_NOT_FOUND) } },
    })
    const result = await h.invoke(CH.SETTINGS_GET, null) as { ok: false; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe(E_NOT_FOUND)
  })
})

describe('R2-2 settings:set-download-dir 的校验与透传', () => {
  it('合法入参逐字透传给控制器，并返回写入后的快照', async () => {
    const h = harness()
    const result = await h.invoke(CH.SETTINGS_SET_DOWNLOAD_DIR, { downloadDir: 'D:/new/downloads' }) as { ok: true; data: SettingsData }
    expect(result.ok).toBe(true)
    expect(h.settings.calls).toContainEqual({ method: 'setDownloadDir', args: ['D:/new/downloads'] })
    expect(result.data.downloadDir).toBe('D:/new/downloads')
  })

  it('空串 / 缺字段 / 类型错 → E_BAD_ARGS，且**不调用**控制器（不会写坏值）', async () => {
    for (const payload of [{ downloadDir: '' }, {}, { downloadDir: 1 }, null]) {
      const h = harness()
      const result = await h.invoke(CH.SETTINGS_SET_DOWNLOAD_DIR, payload) as { ok: false; error: string }
      expect(result.ok).toBe(false)
      expect(result.error).toBe(E_BAD_ARGS)
      expect(h.settings.calls.filter((call) => call.method === 'setDownloadDir')).toEqual([])
    }
  })

  it('控制器拒绝（非绝对路径 / 目录不存在）时把错误码原样交回渲染层', async () => {
    const h = harness({}, { settings: fakeSettings({ setError: E_NOT_FOUND }) })
    const result = await h.invoke(CH.SETTINGS_SET_DOWNLOAD_DIR, { downloadDir: 'D:/gone' }) as { ok: false; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe(E_NOT_FOUND)
  })
})

describe('R2-2 settings:pick-download-dir 只挑不写', () => {
  it('选中的路径原样返回，且**不**落盘（写入由 set 通道负责）', async () => {
    const h = harness()
    const result = await h.invoke(CH.SETTINGS_PICK_DOWNLOAD_DIR, null) as { ok: true; data: string }
    expect(result).toEqual({ ok: true, data: 'D:/picked/downloads' })
    expect(h.picked).toHaveLength(1)
    // 关键：pick 通道绝不写设置 —— 用户可能选完又反悔
    expect(h.settings.calls.filter((call) => call.method === 'setDownloadDir')).toEqual([])
  })

  it('取消选择返回空串（不是错误，也不是 E_BAD_ARGS）', async () => {
    const h = harness({}, { pickResult: '' })
    const result = await h.invoke(CH.SETTINGS_PICK_DOWNLOAD_DIR, null)
    expect(result).toEqual({ ok: true, data: '' })
  })

  it('选择框抛异常时收敛成错误码', async () => {
    const h = harness({}, { pickThrows: true })
    const result = await h.invoke(CH.SETTINGS_PICK_DOWNLOAD_DIR, null) as { ok: false; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe(E_NOT_FOUND)
  })
})

/* ============ R9：按设备记住上次停留的目录 ============ */

describe('R9 settings:get-device-cwd / settings:set-device-cwd', () => {
  it('两个通道值逐字一致，且都注册成 handle', () => {
    expect(CH.SETTINGS_GET_DEVICE_CWD).toBe('settings:get-device-cwd')
    expect(CH.SETTINGS_SET_DEVICE_CWD).toBe('settings:set-device-cwd')
    const h = harness()
    expect(h.channels).toContain(CH.SETTINGS_GET_DEVICE_CWD)
    expect(h.channels).toContain(CH.SETTINGS_SET_DEVICE_CWD)
  })

  it('get：有记录时把控制器的值原样交回渲染层', async () => {
    const h = harness({}, { settings: fakeSettings({ deviceCwds: { 'SERIAL-A': '/sdcard/DCIM' } }) })
    const result = await h.invoke(CH.SETTINGS_GET_DEVICE_CWD, { serial: 'SERIAL-A' }) as { ok: true; data: string }
    expect(result).toEqual({ ok: true, data: '/sdcard/DCIM' })
    // serial 必须逐字透传给控制器（不是从别处猜的）
    expect(h.settings.calls).toContainEqual({ method: 'getDeviceCwd', args: ['SERIAL-A'] })
  })

  it('get：没有记录时返回空串而不是错误（「没记过」是正常初始状态）', async () => {
    const h = harness({}, { settings: fakeSettings({ deviceCwds: {} }) })
    const result = await h.invoke(CH.SETTINGS_GET_DEVICE_CWD, { serial: 'SERIAL-NEW' }) as { ok: true; data: string }
    expect(result).toEqual({ ok: true, data: '' })
  })

  it('get：空 serial / 缺字段 / 类型错 → E_BAD_ARGS，且不调用控制器', async () => {
    for (const payload of [{ serial: '' }, {}, { serial: 1 }, null, undefined]) {
      const h = harness()
      const result = await h.invoke(CH.SETTINGS_GET_DEVICE_CWD, payload) as { ok: false; error: string }
      expect(result.ok).toBe(false)
      expect(result.error).toBe(E_BAD_ARGS)
      expect(h.settings.calls.filter((call) => call.method === 'getDeviceCwd')).toEqual([])
    }
  })

  it('set：合法入参逐字透传给控制器（serial 与 cwd 都不许改写）', async () => {
    const h = harness()
    const result = await h.invoke(CH.SETTINGS_SET_DEVICE_CWD, { serial: 'SERIAL-A', cwd: '/sdcard/DCIM/Camera' })
    expect(result).toEqual({ ok: true, data: undefined })
    expect(h.settings.calls).toContainEqual({ method: 'setDeviceCwd', args: ['SERIAL-A', '/sdcard/DCIM/Camera'] })
  })

  it('set → get 走同一条链路：写进去的目录能读回来（不是两个各自独立的口子）', async () => {
    const h = harness()
    await h.invoke(CH.SETTINGS_SET_DEVICE_CWD, { serial: 'SERIAL-A', cwd: '/sdcard/Movies' })
    const read = await h.invoke(CH.SETTINGS_GET_DEVICE_CWD, { serial: 'SERIAL-A' }) as { ok: true; data: string }
    expect(read.data).toBe('/sdcard/Movies')
  })

  it('set：空 serial / 空 cwd / 缺字段 → E_BAD_ARGS，且不调用控制器（不会写坏值）', async () => {
    for (const payload of [{ serial: '', cwd: '/sdcard' }, { serial: 'S', cwd: '' }, { serial: 'S' }, {}, null]) {
      const h = harness()
      const result = await h.invoke(CH.SETTINGS_SET_DEVICE_CWD, payload) as { ok: false; error: string }
      expect(result.ok).toBe(false)
      expect(result.error).toBe(E_BAD_ARGS)
      expect(h.settings.calls.filter((call) => call.method === 'setDeviceCwd')).toEqual([])
    }
  })

  it('set：控制器抛异常时收敛成错误码，不把异常穿过 IPC', async () => {
    const broken = fakeSettings()
    const h = harness({
      settings: { ...broken, setDeviceCwd: () => { throw new Error(E_NOT_FOUND) } },
    })
    const result = await h.invoke(CH.SETTINGS_SET_DEVICE_CWD, { serial: 'S', cwd: '/sdcard' }) as { ok: false; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe(E_NOT_FOUND)
  })

  it('get：控制器抛异常时收敛成错误码', async () => {
    const broken = fakeSettings()
    const h = harness({
      settings: { ...broken, getDeviceCwd: () => { throw new Error(E_NOT_FOUND) } },
    })
    const result = await h.invoke(CH.SETTINGS_GET_DEVICE_CWD, { serial: 'S' }) as { ok: false; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe(E_NOT_FOUND)
  })
})

describe('R2-2 settings:reset-download-dir 走控制器的 reset', () => {
  it('调用 reset 而不是渲染层自己拼默认路径，且返回默认值', async () => {
    const h = harness({}, { settings: fakeSettings({ downloadDir: 'D:/custom', defaultDownloadDir: 'C:/Users/me/Downloads' }) })
    const result = await h.invoke(CH.SETTINGS_RESET_DOWNLOAD_DIR, null) as { ok: true; data: SettingsData }
    expect(result.ok).toBe(true)
    expect(h.settings.calls).toContainEqual({ method: 'resetDownloadDir', args: [] })
    expect(result.data.downloadDir).toBe('C:/Users/me/Downloads')
  })

  it('reset 抛异常时返回错误码', async () => {
    const h = harness({}, { settings: fakeSettings({ resetError: E_NOT_FOUND }) })
    const result = await h.invoke(CH.SETTINGS_RESET_DOWNLOAD_DIR, null) as { ok: false; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe(E_NOT_FOUND)
  })
})
