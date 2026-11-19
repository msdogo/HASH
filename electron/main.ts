import { app, BrowserWindow, dialog, session, ipcMain, protocol } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { shutdownChildren } from './adb/children'
import { E_UNKNOWN } from '../src/shared/errors'
import { listDirDetailed } from './fs/remote'
import { AdbTracking, createAdbProbe, createClient } from './app/sessions'
import { createBootSequence } from './app/boot'
import { APP_ENTRY_URL, registerAppProtocol, registerAppScheme } from './app/protocol'
import { DeviceManager } from './devices/manager'
import { applyCsp } from './csp'
import { CH } from './ipc/channels'
import { registerHandlers } from './ipc/handlers'
import { TransferOnlineTracker, wireBatchToTransfer } from './app/transfer-wiring'
import { TransferService } from './transfer/service'
import { FsOpsService } from './fs/op-service'
import { LocalFs } from './fs/local'
import { homedir } from 'node:os'
import type { TransferSnapshot } from './../src/shared/transfer'
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

/**
 * 设备上下线 → 传输队列的判定器（审查 I1）。
 *
 * 必须活得比单次推送久：它要记住「上一次这台设备能不能传」，
 * 否则无法区分「元数据变化」与「真的掉线/恢复」，会在每轮轮询都白 pump 队列。
 */
const onlineTracker = new TransferOnlineTracker()

/**
 * 传输服务（任务 8）。
 *
 * 为什么现在（模块顶层）就建：IPC handler 必须尽早注册，而 handler 依赖它。
 * 此时 adbPath 可能还是空串 —— 服务内部每次用一个 getter 取当前值，
 * 不会把「还没定位到 adb」这个瞬时状态固化成空路径。
 */
const transfer = new TransferService({
  adbPath: () => (adbState.state === 'ok' ? adbState.path : ''),
  clientFor: (serial) => createClient(serial),
  // emit 里的 broadcast 是函数声明（会提升），窗口还没建好时它自然只会遍历到空窗口列表。
  emit: () => { broadcastTransfer() },
})
/**
 * 文件操作服务（任务 9）。
 *
 * adbPath 同样用 getter：模块顶层构造时自检还没完成，取到的必然是空串。
 */
const fsOps = new FsOpsService({
  clientFor: (serial) => createClient(serial),
  adbPath: () => (adbState.state === 'ok' ? adbState.path : ''),
})

/**
 * 本地根目录（裁决 5）。
 *
 * 缺省是用户主目录 —— 比「用户自己挑一个」更可用（大多数下载/上传都发生在主目录下），
 * 又比「整台机器」安全得多。用户可以通过本地栏的「选择目录」改成别处，
 * 一旦改了，所有本地访问（读与写）都被限制在新根内。
 *
 * root 是变量而不是常量：选择框改它之后，下一次访问立刻生效，不需要重启。
 */
let localRoot = homedir()
const localFs = new LocalFs({ root: () => localRoot })

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
 * 把当前传输队列快照推给所有窗口。
 *
 * 为什么整份快照而不是增量：队列最多几十条任务，整份快照让渲染层无状态、
 * 不会出现「某次增量丢了就永久错位」。进度已经在主进程侧节流（裁决 6），
 * 所以这个函数的调用频率本身就是受限的。
 */
function broadcastTransfer(): void {
  const snapshot: TransferSnapshot = transfer.manager.snapshot()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(CH.TRANSFER_CHANGED, snapshot)
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
            ops: fsOps,
            local: localFs,
            /*
             * 挑选本地根目录。
             *
             * 与 pickFiles 一样必须挂在有窗口的父级上；没有窗口时返回空串
             * （渲染层当成「用户没选」，不是错误 —— 取消选择本来就不是错误）。
             */
            pickRoot: async () => {
              const win = BrowserWindow.getAllWindows()[0]
              if (win === undefined) return ''
              const picked = await dialog.showOpenDialog(win, {
                title: '选择本地根目录（此目录之外的文件不会被访问）',
                defaultPath: localRoot,
                properties: ['openDirectory', 'createDirectory'],
              })
              if (picked.canceled || picked.filePaths.length === 0) return ''
              localRoot = picked.filePaths[0]
              return localRoot
            },
            transfer: transfer.controller,
            // 文件选择框必须挂在有窗口的父级上（否则模态会跑到屏幕角落）。
            // 没有窗口时返回空数组：渲染层会把它当成「用户没选」。
            pickFiles: async () => {
              const win = BrowserWindow.getAllWindows()[0]
              if (win === undefined) return []
              const picked = await dialog.showOpenDialog(win, {
                title: '选择要上传到手机的文件',
                properties: ['openFile', 'multiSelections'],
              })
              return picked.canceled ? [] : picked.filePaths
            },
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
        /*
         * 退出时的自检收尾（I5，审查轮 2 修正过注释）。
         *
         * 【上一轮的说法是错的】：我曾写「剩余探测子进程由 killAllAdbChildren 统一回收」，
         * 但复审实测该说法不成立 —— killAllAdbChildren 只杀【当刻在册】的进程，
         * 对一个正在 await、马上要 spawn 的调用无效，于是退出后仍会留下孤儿（pid 45740）。
         *
         * 现在真正起作用的机制是两道：
         * 1. race：abort 一发生就立刻放弃等待自检结果，不再阻塞退出流程；
         * 2. children.ts 的【全局关闭闸门】：before-quit 里先 shutdownChildren() 置位 closed，
         *    之后所有 spawnTracked() 直接返回 null（根本不创建进程），
         *    trackChild() 也会立刻 kill 迟到的 child。
         *    所以「迟到的那次 spawn」会自己失败，而不是靠事后枚举去杀。
         */
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
        /*
         * 【审查 I1，第 2 轮重写】设备上下线接到传输队列 —— 直接消费事件批次。
         *
         * 第 1 轮的写法是错的：在回调里取两次 devices.list() 再自 diff。
         * 由于 DeviceManager 是「先改状态再 emit」、事件还要过 50ms 合并窗，
         * 回调执行时两次 list() 读到的是同一份已改完的表 → diff 恒为空 → 恒空转
         * （复审探针实证 setDeviceOnline 调用次数为 0）。
         *
         * 现在 batch.changed / batch.removed 才是真实的状态变化来源，
         * TransferOnlineTracker 负责记住上一次结论并区分「元数据变化」与「真翻转」。
         */
        tracking.onDevicesChanged((batch) => {
          // 先推渲染层（设备栏要立刻更新），再做传输暂停/恢复
          broadcast(batch)
          wireBatchToTransfer(onlineTracker, batch, transfer)
          // 设备状态变化可能让排队任务可以继续，也可能改动了进度提示
          broadcastTransfer()
        })
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
  // 顺序很重要（I5）：
  // 1. 先 abort 在飞的自检 —— 让 await probe() 立刻返回，不再等它跑完；
  // 2. shutdownChildren() 置位全局闸门并回收在册进程 —— 这之后任何迟到的
  //    spawn（包括自检里正在 await 的那一次）都会被 spawnTracked 拒绝，
  //    从根本上杜绝「退出瞬间又冒出一个子进程」；
  // 3. 最后停 tracker（它的定时器与长驻 track-devices 也走同一套闸门 + killTree）。
  bootAbort.abort()
  // 传输必须是「先取消再杀进程」：dispose 会 abort 每个在跑任务的 signal，
  // 进而由 AdbClient 走 killTree 终结整棵进程树（裁决 3）。
  transfer.dispose()
  shutdownChildren()
  tracking?.flushChanges()
  tracking?.stop()
  tracking = undefined
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })