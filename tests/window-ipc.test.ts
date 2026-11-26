import { stubMirrorDeps } from './helpers/mirror-stubs'
import { describe, it, expect } from 'vitest'
import { CH } from '../electron/ipc/channels'
import { registerHandlers, type HandlerDeps, type IpcMainLike } from '../electron/ipc/handlers'
import { DeviceManager } from '../electron/devices/manager'
import { fakeLocalController } from './fake-local'
import { fakeSettings } from './fake-settings'
import { fakeCapture } from './fake-capture'
import { fakeApps } from './fake-apps'
import { fakeBatch } from './fake-batch'
import { fakeDrag } from './fake-drag'
import { fakeWindow } from './fake-window'

/*
 * 自绘顶栏三个按钮的 IPC 层。
 *
 * 这里最关键的一条是**按窗口路由**：应用有主窗口与设置子窗口两个窗口，
 * 如果一律作用于 getAllWindows()[0]，在设置窗口里点最小化会最小化主窗口 —— 
 * 这种缺陷只有在两个窗口同时在屏幕上时才看得出来，所以必须有真门禁。
 */

function harness() {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  const mgr = new DeviceManager()
  mgr.applySnapshot([{ serial: 'S1', status: 'device', transport: 'usb' }])
  const mainWin = fakeWindow()
  const settingsWin = fakeWindow()
  const closings: string[] = []
  const opened: string[] = []
  /*
   * 用「事件里的 sender.name」模拟窗口身份：真实实现是 webContents → BrowserWindow。
   * 走 pickWindow 注入而不是硬编码某个窗口，才能验证路由本身。
   */
  const pickWindow = (event: unknown) => {
    const name = (event as { name?: string } | undefined)?.name
    return name === 'settings' ? settingsWin : mainWin
  }
  const deps: HandlerDeps = {
    devices: mgr,
    adbPath: () => 'C:/adb.exe',
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
    local: fakeLocalController(),
    settings: fakeSettings(),
    capture: fakeCapture(),
    apps: fakeApps(),
    pickApk: async () => '',
    emitInstallProgress: () => undefined,
    windowOf: (event) => pickWindow(event),
    closeWindowOf: (event) => { closings.push((event as { name?: string }).name ?? 'main') },
    openSettings: () => { opened.push('settings') },
    // 本文件不测投屏/按键：空壳只为满足 HandlerDeps（见 tests/mirror-*.test.ts）
    ...stubMirrorDeps(),
    drag: fakeDrag(),
    transfer: {
      enqueue: async () => { throw new Error('not used') },
      cancel: () => false,
      retry: () => false,
      get: () => undefined,
      snapshot: () => ({ tasks: [], running: 0, queued: 0 }),
      clearFinished: () => 0,
    },
    batch: fakeBatch(),
    pickRoot: async () => '',
    pickDownloadDir: async () => '',
  }
  registerHandlers(deps, {
    handle: (channel, listener) => { handlers.set(channel, listener) },
  } as IpcMainLike)
  return {
    mainWin,
    settingsWin,
    closings,
    opened,
    invoke: async (channel: string, event?: unknown): Promise<unknown> => {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error('no handler: ' + channel)
      return handler(event)
    },
  }
}

describe('窗口按钮的 IPC 接线', () => {
  it('最小化只作用于**发起命令的那个窗口**（不是永远第一个窗口）', async () => {
    const { invoke, mainWin, settingsWin } = harness()
    await invoke(CH.WINDOW_MINIMIZE, { name: 'settings' })
    expect(settingsWin.calls).toEqual(['minimize'])
    // 主窗口完全没被碰过 —— 这正是多窗口场景下最容易写错的地方
    expect(mainWin.calls).toEqual([])
  })

  it('最大化按钮返回切换后的状态（渲染层据此换图标）', async () => {
    const { invoke } = harness()
    expect(await invoke(CH.WINDOW_TOGGLE_MAXIMIZE)).toEqual({ ok: true, data: true })
    expect(await invoke(CH.WINDOW_TOGGLE_MAXIMIZE)).toEqual({ ok: true, data: false })
  })

  it('is-maximized 反映该窗口自己的状态', async () => {
    const { invoke } = harness()
    expect(await invoke(CH.WINDOW_IS_MAXIMIZED)).toEqual({ ok: true, data: false })
    await invoke(CH.WINDOW_TOGGLE_MAXIMIZE)
    expect(await invoke(CH.WINDOW_IS_MAXIMIZED)).toEqual({ ok: true, data: true })
  })

  /*
   * 关闭按钮必须是「关窗口」而不是直接 app.quit()：
   * 退出前的清理（杀 adb 子进程、关闸门）挂在 window-all-closed → quit 这条链上，
   * 多一条 quit 路径就多一处「清理没跑」的可能。
   * 而且关设置窗口不该退出程序 —— 只有关掉主窗口之后才没有窗口了。
   */
  it('关闭只关发起命令的窗口（关设置窗口不应退出程序）', async () => {
    const { invoke, closings } = harness()
    await invoke(CH.WINDOW_CLOSE, { name: 'settings' })
    expect(closings).toEqual(['settings'])
  })

  it('打开设置窗口是一条独立命令（设置已不是主窗口内的一页）', async () => {
    const { invoke, opened } = harness()
    expect(await invoke(CH.WINDOW_OPEN_SETTINGS)).toEqual({ ok: true, data: undefined })
    expect(opened).toEqual(['settings'])
  })
})