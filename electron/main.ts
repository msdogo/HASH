import { app, BrowserWindow, session, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { killAllAdbChildren } from './adb/children'
import { E_UNKNOWN } from '../src/shared/errors'
import { listDirDetailed } from './fs/remote'
import { AdbTracking, createAdbProbe, createClient } from './app/sessions'
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
// 就可以用 CDP 抓渲染层真实的 DOM 与截图（不必靠肉眼猜界面显示什么）。
// 未设置环境变量时完全无副作用，也不进打包产物的默认行为。
const debugPort = process.env.ADB_FM_DEBUG_PORT
if (debugPort !== undefined && debugPort !== '') {
  app.commandLine.appendSwitch('remote-debugging-port', debugPort)
}

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
/**
 * CSP（裁决 4）：dev/prod 双模式，用响应头注入而不是写死 meta（写死会挡掉 Vite HMR）。
 * 具体实现在 ./csp，那里可以脱离 Electron 单测。
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
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(dirname, '../dist/index.html'))
  }
}

/**
 * 把一批设备变更推给所有窗口（自检完成时也用它补推一次）。
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
 * 启动顺序（裁决 1）：
 * 1. 建窗口 —— adb 自检要 4~8s，绝不能挡在窗口出现之前；
 * 2. 立刻注册 IPC（用还没起来的会话表），渲染层首屏调用不会落空；
 * 3. 异步自检 adb，拿到路径后再起 tracker；
 * 4. 自检失败也照样起 tracker（它会降级轮询），让用户至少看到「无设备」而不是一直转圈。
 */
app.whenReady().then(async () => {
  installCsp()
  createWindow()

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

  const probe = createAdbProbe({
    resourcePath: process.resourcesPath,
    env: process.env.ADB_PATH,
  })
  adbState = await probe()

  tracking = new AdbTracking({
    // 自检失败时用裸名兜底：错误已经通过 adbState 显示给用户，tracker 起不来也无害。
    adbPath: adbState.state === 'ok' ? adbState.path : 'adb',
    manager: devices,
    // adb 状态随每次推送下发：渲染层首屏拿到的往往是 checking，
    // 只有推送能把界面从「正在查找 adb…」推进到「无法使用 adb」或正常状态。
    adbState: () => adbState,
  })
  // 设备掉线 / 重连时清掉该 serial 的时区缓存（裁决 6）：这一步由
  // DeviceChangeTracker 在构造时接好的 clearDeviceSerialTzCache 完成，
  // 这里只负责把去重 + 合并后的批次推给渲染层。
  tracking.onDevicesChanged((batch) => { broadcast(batch) })
  tracking.start()

  // 自检结果晚于窗口：主动推一次，让设备栏立刻脱离 checking。
  tracking.notifyAdbState()
  tracking.flushChanges()
  if (adbState.state === 'error') {
    console.warn('[adb] 自检失败：' + errorText(adbState.code))
  }
})

// 规格要求：窗口关闭时回收所有子进程；tracker 也必须在这里停掉，
// 否则它的定时器与长驻 track-devices 进程会挂住事件循环（裁决 1）。
app.on('before-quit', () => {
  tracking?.flushChanges()
  tracking?.stop()
  tracking = undefined
  killAllAdbChildren()
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })