import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { killAllAdbChildren } from './adb/children'

const dirname = path.dirname(fileURLToPath(import.meta.url))

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

// 规格要求：窗口关闭时回收所有子进程。登记表在 client 里，这里只挂退出钩子。
app.on('before-quit', () => { killAllAdbChildren() })
app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
