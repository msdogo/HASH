import { app, BrowserWindow, dialog, session, ipcMain, protocol, webContents } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { shutdownChildren } from './adb/children'
import { E_UNKNOWN } from '../src/shared/errors'
import { t } from '../src/shared/i18n'
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
import { BatchService } from './batch/service'
import { DragOutService } from './drag/service'
import type { TransferEvent } from './transfer/manager'
import { FsOpsService } from './fs/op-service'
import { LocalFs } from './fs/local'
import { createSettingsStore } from './settings/store'
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
/**
 * 本地栏的**起始浏览目录**（缺省用户主目录）。
 *
 * R2-1：它**不是访问边界**。本地根目录沙箱已由用户裁决移除 ——
 * 任何合法绝对路径都能列、能读、能作为传输目标（拖入/拖出/截图/安装）。
 * 这个变量现在只决定两件事：本地栏第一次打开时看哪个目录，
 * 以及选择框的 defaultPath。
 *
 * 是变量而不是常量：用户在选择框里改它之后，下一次访问立刻生效，不需要重启。
 *
 * 注意它必须在 TransferService / LocalFs 之前声明：两个服务都通过 getter 读它，
 * 声明放在后面虽然运行时没问题（getter 是延迟求值），但读代码的人会以为
 * 「构造时它还是 undefined」—— 声明顺序即事实顺序。
 */
let startDir = homedir()

const transfer = new TransferService({
  adbPath: () => (adbState.state === 'ok' ? adbState.path : ''),
  clientFor: (serial) => createClient(serial),
  // emit 里的 broadcast 是函数声明（会提升），窗口还没建好时它自然只会遍历到空窗口列表。
  emit: (event: TransferEvent) => {
    settleBatchTask(event)
    broadcastTransfer()
  },
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

const localFs = new LocalFs({ startDir: () => startDir })

/**
 * 设置存储（R2-2：默认下载路径持久化）。
 *
 * ===== 为什么是「懒建」的 getter 而不是模块顶层的 createSettingsStore(...) =====
 * app.getPath('userData') / app.getPath('downloads') 在 app ready 之前不可靠
 * （模块顶层求值时 whenReady 还没跑）。而 HandlerDeps 要求 settings 是一个**对象**，
 * 不能是「还不确定什么时候能建」的东西。用 getter 把求值推迟到第一次真正读设置，
 * 那时窗口已建、ready 早已发生 —— 这条路径只在 whenReady 之后被调用。
 *
 * ===== 为什么路径必须注入 =====
 * electron-store 依赖 Electron 的 app 对象，直接 `new Store()` 在纯 node 环境下会抛。
 * 把 filePath / defaultDownloadDir 交给调用方（这里是 app），
 * electron/settings/store.ts 才能在测试里用临时目录做「写 → 重建 → 读回」的真读写证明。
 */
let settingsStore: ReturnType<typeof createSettingsStore> | undefined

/** 取设置存储；尚未初始化时立即建（getPath 在 whenReady 之后恒定可用）。 */
function settings(): ReturnType<typeof createSettingsStore> {
  if (settingsStore === undefined) {
    settingsStore = createSettingsStore({
      filePath: app.getPath('userData'),
      defaultDownloadDir: app.getPath('downloads'),
    })
  }
  return settingsStore
}

/**
 * 批量截图待清理的临时文件（任务 10 / R1）。
 *
 * 为什么需要这张表：截图走的是「设备上写临时 png → 传输队列拉回 → 删临时文件」，
 * 而删的时机必须是**传输任务进入终态之后** —— 提前删会让 adb pull 读到一个
 * 已经不存在的源文件，用户拿到的是「截图失败」但他明明看到屏幕上闪了一下。
 *
 * key 是传输任务 id；TransferService 的每个事件都带 task，
 * 落到 done/failed/canceled 时取出回调执行一次（执行后立即删除，表不会长胖）。
 */
const batchCleanup = new Map<string, () => void>()

/**
 * 传输事件 → 批量临时文件清理。
 *
 * 用**函数声明**而不是 const 箭头：它在 TransferService 构造时就被引用（emit），
 * 而声明在下面的常量初始化之前，只有函数声明会被提升。
 */
function settleBatchTask(event: TransferEvent): void {
  const status = event.task.status
  if (status !== 'done' && status !== 'failed' && status !== 'canceled') return
  const callback = batchCleanup.get(event.task.id)
  if (callback === undefined) return
  batchCleanup.delete(event.task.id)
  try {
    callback()
  } catch (err) {
    // 清理失败只记日志：用户的截图已经拿到了，不该因为 rm 失败而变成失败项
    console.warn('[batch] 临时文件清理回调失败：' + String(err))
  }
}

/**
 * 批量动作服务（任务 10）。
 *
 * 与 fsOps / transfer 一样在模块顶层构造：IPC handler 必须尽早注册，而 handler 依赖它。
 * adbPath 传 getter —— 构造时机早于 adb 自检完成，取当前值才是对的。
 */
const batchService = new BatchService({
  devices,
  clientFor: (serial) => createClient(serial),
  transfer: transfer.controller,
  adbPath: () => (adbState.state === 'ok' ? adbState.path : ''),
  /*
   * 两个选择框。取消一律返回空串（不是错误）—— 与 pickFiles / pickRoot 同一约定。
   * 批量截图的目录选择框默认落在本地栏的起始浏览目录（用户可以在这里改成任意位置）。
   */
  pickDirectory: async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win === undefined) return ''
    const picked = await dialog.showOpenDialog(win, {
      title: t('batch.pickDirTitle'),
      defaultPath: startDir,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (picked.canceled || picked.filePaths.length === 0) return ''
    return picked.filePaths[0]
  },
  pickApk: async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win === undefined) return ''
    const picked = await dialog.showOpenDialog(win, {
      title: t('batch.pickApkTitle'),
      filters: [{ name: t('batch.apkFilter'), extensions: ['apk'] }],
      properties: ['openFile'],
    })
    if (picked.canceled || picked.filePaths.length === 0) return ''
    return picked.filePaths[0]
  },
  /*
   * 传输任务进终态后再删临时文件（R1）。
   * 任务可能在我们登记之前就已经结束（队列空闲时几乎瞬间完成），
   * 所以登记时先看一眼当前状态 —— 否则那张 png 会永久留在设备上。
   */
  onTaskSettled: (taskId, callback) => {
    batchCleanup.set(taskId, callback)
    const task = transfer.controller.get(taskId)
    if (task === undefined) return
    if (task.status === 'done' || task.status === 'failed' || task.status === 'canceled') {
      settleBatchTask({ type: 'changed', task })
    }
  },
})


/**
 * 拖拽服务（简报 C：设备 ↔ 资源管理器）。
 *
 * 落点是 app.getPath('temp')/adbfm-drag：**必须**是临时目录 ——
 * startDrag 要的是本地磁盘上已存在的文件，而这份文件只是「待拖走」的副本，
 * 放进用户的文件夹等于每次拖拽都在他不知道的地方留一份。
 *
 * 清理有两个调用点，缺一不可（都在下面接好了）：
 *   1. 每次拖拽开始前（dragOut 内部第一步）；
 *   2. 进程退出时（before-quit）。
 */
const dragService = new DragOutService({
  tempRoot: () => app.getPath('temp'),
  enqueue: (input) => transfer.controller.enqueue(input),
  getTask: (id) => transfer.controller.get(id),
  emitProgress: (payload) => { broadcastDragProgress(payload) },
  emitFailed: (payload) => { broadcastDragFailed(payload) },
  /*
   * startDrag 只能由主进程发起，且必须挂在**当前窗口**的 webContents 上：
   * 它是「从这个页面拖出去」这个动作的接续。没有窗口时什么也不做
   * （此时 beginDragOut 会拿到成功但没有任何拖拽 —— 见下面 resolveWebContents 的说明）。
   */
  startDrag: (item) => {
    const target = dragTarget()
    if (target === undefined) return
    target.startDrag(item)
  },
})

/**
 * 发起拖拽的 webContents：取第一个还活着的窗口。
 *
 * 为什么用「第一个存活窗口」而不是把发起方传下来：
 * startDrag 的语义是「当前这个页面开始拖」，本应用只有一个主窗口；
 * 而 IPC 事件的 sender 无法穿过 HandlerDeps 的接口（那是主进程内部细节），
 * 为一个单窗口应用多绕一层不值得。若将来多窗口，这里要改成按 sender 取。
 */
function dragTarget(): Electron.WebContents | undefined {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) return win.webContents
  }
  return undefined
}

/** 拖出准备进度 → 所有窗口（界面显示「正在准备拖拽（N/M）」）。 */
function broadcastDragProgress(payload: { total: number; done: number }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(CH.TRANSFER_DRAG_OUT_PROGRESS, payload)
  }
}

/** 拖出失败 → 所有窗口（任一文件失败就整体不拖）。 */
function broadcastDragFailed(payload: { total: number; done: number; error: string }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(CH.TRANSFER_DRAG_OUT_FAILED, payload)
  }
}

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
    backgroundColor: '#F7F8FA',
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
             * 挑选本地栏的起始浏览目录。
             *
             * R2-1 之后这**不再是**「划定可访问范围」：本地根目录沙箱已由用户裁决移除，
             * 任何位置的文件都能上传、拖入、作为下载目标。这个选择框只决定
             * 「本地栏打开时先看哪里」，所以标题与注释都不再声称有边界。
             *
             * 与 pickFiles 一样必须挂在有窗口的父级上；没有窗口时返回空串
             * （渲染层当成「用户没选」，不是错误 —— 取消选择本来就不是错误）。
             */
            pickRoot: async () => {
              const win = BrowserWindow.getAllWindows()[0]
              if (win === undefined) return ''
              const picked = await dialog.showOpenDialog(win, {
                title: '选择本地栏的起始目录',
                defaultPath: startDir,
                properties: ['openDirectory', 'createDirectory'],
              })
              if (picked.canceled || picked.filePaths.length === 0) return ''
              startDir = picked.filePaths[0]
              return startDir
            },
            /*
             * R2-2：设置页的「更换下载路径」。
             *
             * 与 pickRoot 的关键差别：**不改 startDir**（本地面板的浏览起点）。
             * 在设置页换下载路径不该让本地栏跳走；两者只是共用同一个系统对话框。
             * 默认路径给当前生效的下载目录，用户再次打开时从上次的位置开始。
             */
            pickDownloadDir: async () => {
              const win = BrowserWindow.getAllWindows()[0]
              if (win === undefined) return ''
              const current = settings().getDownloadDir()
              const picked = await dialog.showOpenDialog(win, {
                title: t('settings.downloadDir.pickTitle'),
                defaultPath: current,
                properties: ['openDirectory', 'createDirectory'],
              })
              if (picked.canceled || picked.filePaths.length === 0) return ''
              return picked.filePaths[0]
            },
            // 设置页读写的唯一数据源；坏值降级、校验都在 electron/settings/store.ts 里
            settings: {
              getDownloadDir: () => settings().getDownloadDir(),
              getDefaultDownloadDir: () => settings().getDefaultDownloadDir(),
              setDownloadDir: (dir) => settings().setDownloadDir(dir),
              resetDownloadDir: () => settings().resetDownloadDir(),
            },
            transfer: transfer.controller,
            batch: batchService,
            drag: dragService.controller,
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
  // 复审 I1：批量截图的临时文件清理登记也要在退出时兑现，
  // 否则排队中的 transfer 任务永远不进终态（dispose 不 emit），设备上会留 png。
  batchService.dispose()
  /*
   * 拖拽临时目录的兜底清理（简报 C 硬性要求）。
   *
   * 常规路径是「下次拖拽前清理」，但用户完全可能拖完就退出 ——
   * 那个目录里留着的是他刚拖走的文件的副本（可能几百 MB），必须在这里删掉。
   * 清理失败只记日志：退出流程不能被一个删不掉的临时文件卡住。
   */
  try {
    dragService.cleanup()
  } catch (err) {
    console.warn('[drag] 退出时清理临时目录失败：' + String(err))
  }
  // dispose 已经把未结算的清理执行掉了，把表清空避免残留闭包
  batchCleanup.clear()
  shutdownChildren()
  tracking?.flushChanges()
  tracking?.stop()
  tracking = undefined
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
