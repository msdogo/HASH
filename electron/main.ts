import { app, BrowserWindow, session, ipcMain, protocol } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { killAllAdbChildren } from './adb/children'
import { E_UNKNOWN } from '../src/shared/errors'
import { listDirDetailed } from './fs/remote'
import { AdbTracking, createAdbProbe, createClient } from './app/sessions'
import { createBootSequence } from './app/boot'
import { APP_ENTRY_URL, registerAppProtocol, registerAppScheme } from './app/protocol'
import { DeviceManager } from './devices/manager'
import { applyCsp } from './csp'
import { CH } from './ipc/channels'
import { registerHandlers } from './ipc/handlers'
import { errorText } from '../src/shared/i18n'
import type { AdbState, DevicesChangedBatch } from '../src/shared/types'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/** dev 判定：vite-plugin-electron 在 dev 下注入 VITE_DEV_SERVER_URL。 */
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)

// 手工验证用：设置 ADB_FM_DEBUG_PORT 后开放 Chrome DevTools 协议端口，
// 就可以用 CDP 抓渲染层真实的 DOM 与截图（不必只靠肉眼猜界面显示什么）。
const debugPort = process.env.ADB_FM_DEBUG_PORT
if (debugPort !== undefined && debugPort !== '') {
  app.commandLine.appendSwitch('remote-debugging-port', debugPort)
}

/**
 * 【C2】scheme 特权必须在 app ready 之前声明，晚了不生效。
 * 生产模式页面走 app://bundle/index.html，而不是 file://。
 */
registerAppScheme()

/**
 * adb 自检状态。
 * 初值是 checking —— 自检要 4~8s，这段时间界面必须显示「正在查找 adb…」，
 * 而不是把「还没开始查」误报成「无法使用 adb」。
 */
let adbState: AdbState = { state: 'checking' }

/**
 * 会话表在 adb 自检之前就建好：IPC handler 必须尽早注册，
 * 否则渲染层首屏的 devices:list 会撞上 "No handler registered for channel"。
 */
const devices = new DeviceManager()

/** 跟踪器要等自检拿到 adb 路径才能起，此时为 undefined。 */
let tracking: AdbTracking | undefined
/** 退出时用来取消在飞的自检（I5），避免 probe 子进程成孤儿。 */
const bootAbort = new AbortController()

/**
 * CSP（裁决 4）：dev/prod 双模式。
 * - dev：页面来自 http://127.0.0.1:5555，走 session 的 onHeadersReceived；
 * - prod：页面来自 app://，CSP 由 protocol.handle 亲手写进响应头（C2），
 *   因为 onHeadersReceived 对 file:// 根本不触发 —— 这正是审查发现的漏洞。
 * 两边共用同一份 buildCsp()，策略不会漂移。
 */
function installCsp(): void {
  applyCsp(session.defaultSession, isDev)
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#12141A',
    webPreferences: {
      // preload 产物是 CJS（.cjs）。不要关闭 sandbox：本项目 preload 依赖沙箱预加载器
      // 提供的 require 垫片，sandbox: false 时 window.api 会全部变成 undefined 且不报错。
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL as string)
  } else {
    // 生产走自定义协议：有真实响应头（CSP 能落地），'self' 语义也正常（不会白屏）
    win.loadURL(APP_ENTRY_URL)
  }
}

/**
 * 把一批设备变更推给所有窗口。
 * 只遍历窗口，不额外持有窗口引用 —— 持有的引用在窗口销毁后就是悬垂的，
 * 而 getAllWindows() 天然只返回存活的窗口。
 */
function broadcast(batch: DevicesChangedBatch): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(CH.DEVICES_CHANGED, batch)
  }
}

/**
 * 启动（I7：顺序由 createBootSequence 保证并被测试锁住）：
 * CSP → 注册 IPC → 建窗口 → 自检 adb → 起 tracker → 通知 adb 状态。
 *
 * 注册 IPC 严格早于建窗口：窗口一出现渲染层就会 invoke devices:list，
 * 那一刻 handler 必须在位。（修前的代码顺序相反，只因同 tick 无间隙才没出事。）
 */
app.whenReady().then(async () => {
  // 生产模式：把 dist 用 app:// 提供出来（C2）。dev 模式不需要。
  if (!isDev) {
    registerAppProtocol(path.join(dirname, '..', 'dist'), isDev)
  }

  await createBootSequence(
    {
      installCsp,
      registerHandlers: () => {
        registerHandlers(
          {
            devices,
            adbPath: () => (adbState.state === 'ok' ? adbState.path : ''),
            adbState: () => adbState,
            clientFactory: (serial) => createClient(serial),
            fs: { list: listDirDetailed },
          },
          ipcMain,
        )
      },
      createWindow,
      probeAdb: async (signal) => {
        const probe = createAdbProbe({
          resourcePath: process.resourcesPath,
          env: process.env.ADB_PATH,
        })
        // 自检本身不支持取消（resolveAdb 内部逐候选探测，最坏 8s），
        // 但这里用 race 让它【不再阻塞启动流程】：退出时立刻放弃等待，
        // 剩下的探测子进程由 before-quit 的 killAllAdbChildren 统一回收（I5）。
        const aborted = new Promise<AdbState>((resolve) => {
          signal.addEventListener('abort', () => {
            resolve({ state: 'error', code: 'E_ABORTED', attempts: [] })
          })
        })
        adbState = await Promise.race([probe(), aborted])
        return adbState
      },
      startTracking: () => {
        tracking = new AdbTracking({
          // 自检失败时用裸名兜底：错误已经通过 adbState 显示给用户，tracker 起不来也无害。
          adbPath: adbState.state === 'ok' ? adbState.path : 'adb',
          manager: devices,
          // adb 状态随每次推送下发（I8 已把该字段改成必填）。
          adbState: () => adbState,
        })
        tracking.onDevicesChanged((batch) => { broadcast(batch) })
        tracking.start()
      },
      notifyAdbState: () => {
        // 自检结果晚于窗口：主动推一次，让设备栏立刻脱离 checking。
        tracking?.notifyAdbState()
        tracking?.flushChanges()
      },
      onAdbError: (code) => { console.warn('[adb] 自检失败：' + errorText(code)) },
    },
    bootAbort.signal,
  )().catch((err: unknown) => {
    // 启动失败不能让窗口空白着没有任何提示
    console.error('[boot] 启动失败：' + String(err))
  })
})

// 规格要求：窗口关闭时回收所有子进程；tracker 也必须在这里停掉，
// 否则它的定时器与长驻 track-devices 进程会挂住事件循环（裁决 1）。
app.on('before-quit', () => {
  // I5：先取消在飞的自检，别让 probe 的子进程在退出过程中被漏掉
  bootAbort.abort()
  tracking?.flushChanges()
  tracking?.stop()
  tracking = undefined
  killAllAdbChildren()
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
