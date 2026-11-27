import { app, BrowserWindow, dialog, session, ipcMain, Menu, nativeImage, protocol, Tray, webContents } from 'electron'
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
import { CaptureService } from './capture/service'
import { startRecorder, STOP_COMMANDS } from './capture/recorder'
import { RECORD_START_TIMEOUT_MS } from '../src/shared/capture'
import { AppsService } from './apps/service'
import { createKeyService } from './device/keys'
import { createOrientationProbe } from './mirror/orientation'
import { createMirrorService } from './mirror/service'
import { DEFAULT_SCRCPY_ARGS } from '../src/shared/mirror'
import { locateScrcpy } from './mirror/binary'
import { probeScrcpyVersion, startScrcpy } from './mirror/runner'
import { createMirrorWindowManager } from './mirror/window'
import { createWindowController } from './window/controller'
import { closeOutcome, mayStartApp, restoreMainWindow } from './app/lifecycle'
import { DragOutService } from './drag/service'
import type { TransferEvent } from './transfer/manager'
import { FsOpsService } from './fs/op-service'
import { LocalFs } from './fs/local'
import { createSettingsStore } from './settings/store'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
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

/*
 * 单实例锁：只能开一个窗口。
 *
 * 为什么必须有：应用独占一条 USB/adb 连接与一份 settings.json。
 * 两个实例同时跑，后开的那个会读到前一个还没写盘的设置，
 * 而且两个进程各自 spawn 的 adb 子进程会互相抢设备（adb devices 抖动、
 * 传输中断）。这类故障现场极难复现，所以从根上不允许第二个实例存在。
 *
 * requestSingleInstanceLock 是原子操作（基于命名互斥体）：
 * 返回 false 说明已有实例在跑，此时立刻退出，并把已有窗口提到前台
 * （用户双击图标时期望看到那个窗口，而不是什么都没发生）。
 */
const gotTheLock = app.requestSingleInstanceLock()
/*
 * 没有锁就**什么都不要再做**。
 *
 * 只写 app.quit() 是不够的：quit 是异步的「发起」，当前模块会继续往下跑，
 * 于是 app.whenReady() 照样回调、照样 createWindow() —— 第二个实例的窗口
 * 先画出来，再随进程一起消失，用户看到「闪一下」。
 * 正常应用第二次双击图标应当是**毫无反应**，所以用 mayStartApp 把
 * 「建窗口 / 起托盘」这些有可见副作用的代码整块挡在外面。
 */
if (!mayStartApp(gotTheLock)) {
  app.quit()
} else {
  /*
   * 第二次双击图标 = **什么都不做**。
   *
   * 用户明确要求「像别的应用那样，已经打开了再点图标没有任何反应」。
   * 之前这里会 restore()+focus()，再加上第二个实例自己还画了一次窗口
   * （app.quit() 是异步的，模块继续执行到 createWindow），合起来就是
   * 「窗口闪一下」。现在两处都堵住：这里不做任何事，whenReady 里
   * mayStartApp 也把建窗口/起托盘挡在外面。
   *
   * 窗口被最小化到任务栏时，回来的路径是任务栏按钮或托盘图标 —— 都在。
   */
  app.on('second-instance', () => {
    // 故意留空。保留监听器是为了让 Electron 知道我们收到了这个事件。
  })
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
      // 「投屏参数」的默认值：用户第一次打开设置页看到的就是这一行，可删可改
      defaultScrcpyArgs: DEFAULT_SCRCPY_ARGS,
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
 * 单机截图 / 录屏待清理的临时文件（P1 第一批）。
 *
 * 与 batchCleanup 分开两张表而不是合并成一张：两边的清理动作虽然同形，
 * 但「谁登记了它」决定了排查残留时该看哪条链路。合并之后，一张 png 的
 * 清理失败提示里就分不出它来自批量截图还是单机截图。
 * 结算入口共用同一个 settleTask（见下），所以行为上不会有两套逻辑。
 */
const captureCleanup = new Map<string, () => void>()

/**
 * 传输事件 → 批量临时文件清理。
 *
 * 用**函数声明**而不是 const 箭头：它在 TransferService 构造时就被引用（emit），
 * 而声明在下面的常量初始化之前，只有函数声明会被提升。
 */
function settleBatchTask(event: TransferEvent): void {
  const status = event.task.status
  if (status !== 'done' && status !== 'failed' && status !== 'canceled') return
  const callback = batchCleanup.get(event.task.id) ?? captureCleanup.get(event.task.id)
  if (callback === undefined) return
  // 两张表都要删：同一个 taskId 只可能属于其中一张，但删错表会让另一张永久长胖
  batchCleanup.delete(event.task.id)
  captureCleanup.delete(event.task.id)
  try {
    callback()
  } catch (err) {
    // 清理失败只记日志：用户的截图已经拿到了，不该因为 rm 失败而变成失败项
    console.warn('[batch] 临时文件清理回调失败：' + String(err))
  }
}

/**
 * 登记「任务进终态后执行一次」的回调；若任务登记时已经结束则立即兑现。
 *
 * 任务可能在我们登记之前就已经跑完（队列空闲时几乎瞬间完成），
 * 所以必须回查一次状态 —— 否则那张 png / mp4 会永久留在设备上。
 */
function registerTaskCleanup(
  table: Map<string, () => void>,
  taskId: string,
  callback: () => void,
): void {
  const task = transfer.controller.get(taskId)
  if (task !== undefined && (task.status === 'done' || task.status === 'failed' || task.status === 'canceled')) {
    callback()
    return
  }
  table.set(taskId, callback)
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
    registerTaskCleanup(batchCleanup, taskId, callback)
  },
})

/**
 * 单机截图 / 录屏服务（P1 第一批）。
 *
 * 与 batchService 一样在模块顶层构造：IPC handler 必须尽早注册，而 handler 依赖它。
 * adbPath / defaultDstDir 传 getter —— 构造时机早于 adb 自检与设置加载完成。
 */
const captureService = new CaptureService({
  devices,
  clientFor: (serial) => createClient(serial),
  transfer: transfer.controller,
  adbPath: () => (adbState.state === 'ok' ? adbState.path : ''),
  /*
   * 落点：设置里的默认下载路径。
   *
   * 与「下载到本地」同一来源（src/shared/settings 的 downloadDirForDownload 语义），
   * 不在渲染层抄一份 —— 抄的那份一旦过期，截图会落到用户没想到的地方。
   * settings() 是懒建的，这里必须每次现取。
   */
  defaultDstDir: () => settings().getDownloadDir(),
  /*
   * 起一个 screenrecord 会话。
   *
   * 停止必须在**设备侧**发 SIGINT（见 electron/capture/recorder.ts 的说明）：
   * 本地进程在 Windows 上收不到 SIGINT，设备会一直录到 --time-limit。
   * 两条候选命令各试一次，认不出 pkill 的旧版 toybox 也能停下来。
   */
  startRecording: (serial, remotePath, maxSeconds) => {
    const adb = adbState.state === 'ok' ? adbState.path : ''
    if (adb === '') return null
    return startRecorder({
      adbPath: adb,
      serial,
      remotePath,
      maxSeconds,
      requestStopOnDevice: async () => {
        const client = createClient(serial)
        for (const command of STOP_COMMANDS) {
          try {
            const result = await client.run(['shell', command], { adbPath: adb, timeoutMs: RECORD_START_TIMEOUT_MS })
            // 第一条命令成功就够了；失败（没有 pkill）才试下一条
            if (result.code === 0) return
          } catch {
            // 继续试下一条
          }
        }
      },
    })
  },
  /*
   * 传输任务进终态后再删设备上的临时文件。
   *
   * 登记进 captureCleanup 而不是 batchCleanup：清理失败的日志要能说清来源。
   * 结算入口是同一个 settleBatchTask（它在两张表里查）。
   */
  onTaskSettled: (taskId, callback) => {
    registerTaskCleanup(captureCleanup, taskId, callback)
  },
})
/**
 * 应用管理服务（P1 第二批）。
 *
 * 与其它服务一样在模块顶层构造：IPC handler 必须尽早注册，而 handler 依赖它。
 * 拉 APK 走主进程直接 adb pull（源在 /data/app，传输队列的闸门拒绝 /data 整棵子树）——
 * 理由写在 electron/apps/service.ts 的文件头。
 */
const appsService = new AppsService({
  devices,
  clientFor: (serial) => createClient(serial),
  adbPath: () => (adbState.state === 'ok' ? adbState.path : ''),
  defaultDstDir: () => settings().getDownloadDir(),
})


/**
 * 设备按键服务（投屏侧边栏的六个按钮）。
 *
 * adbPath 传 getter：构造时机早于自检完成，与 capture/apps 同一手法。
 */
/**
 * 屏幕方向探测器（投屏窗口的初始尺寸靠它）。
 *
 * 与 keyService 同一手法：构造时机早于 adb 自检完成，所以 adbPath 走外部传入。
 */
const orientationProbe = createOrientationProbe({
  clientFor: (serial) => createClient(serial),
})

const keyService = createKeyService({
  devices,
  clientFor: (serial) => createClient(serial),
  adbPath: () => (adbState.state === 'ok' ? adbState.path : ''),
})

/**
 * 投屏窗口管理器（每台设备一个窗口）。
 *
 * 与 mirrorService 分开：service 只管「scrcpy 进程活不活」，
 * 窗口只管「画在屏幕上的那一块」。两者通过 started/exited 事件配合，
 * 拆开之后 IPC 测试完全不需要 Electron 的 BrowserWindow。
 *
 * onClosed 走 void 是因为窗口的 'closed' 回调是同步的，而停止会话是异步的
 * （要 killTree 等进程真死）；不 await 不影响正确性 —— 会话表在 stop 里先删。
 */
const mirrorWindows = createMirrorWindowManager({
  preloadPath: path.join(dirname, 'preload.cjs'),
  iconPath: path.join(process.resourcesPath, 'icon.png'),
  loadView: (win, hash) => {
    if (isDev) {
      void win.loadURL((process.env.VITE_DEV_SERVER_URL as string) + hash)
    } else {
      void win.loadURL(APP_ENTRY_URL + hash)
    }
  },
  onClosed: (serial) => {
    void mirrorService.stop(serial).catch((err: unknown) => {
      console.warn('[mirror] 关窗口时结束投屏失败：' + String(err))
    })
  },
  onEmbedFailed: (serial, reason) => {
    /*
     * 嵌入失败：把窗口关掉并结束会话。
     *
     * 为什么不「留着窗口让用户看看」：剩下的是一个黑框 + 一条错误提示，
     * 而 scrcpy 进程还在占着 ADB 通道。关掉重试是唯一有意义的出路 ——
     * 与 service 的「失败就把会话清掉，不自动重启」同一条原则。
     */
    console.warn('[mirror] 嵌入失败（' + serial + '）：' + reason)
    mirrorWindows.close(serial)
    void mirrorService.stop(serial).catch(() => undefined)
  },
})

/**
 * 投屏服务（P1 第三批：scrcpy）。
 *
 * locate 每次现查：用户可能中途才把 scrcpy 装到 PATH 上，
 * 缓存一次「没有」会让整个会话都用不了投屏。
 */
const mirrorService = createMirrorService({
  devices,
  adbPath: () => (adbState.state === 'ok' ? adbState.path : ''),
  locate: () =>
    locateScrcpy({
      resourcesPath: process.resourcesPath,
      exists: (filePath) => {
        try {
          // require 在这里是同步的存在性判定，不读内容
          return existsSync(filePath)
        } catch {
          return false
        }
      },
      probe: probeScrcpyVersion,
    }),
  spawn: startScrcpy,
  /*
   * 建窗口之前先问一次屏幕方向。
   *
   * 不传也能跑（窗口退回「先按默认尺寸建、量到视频后再改」），
   * 但那样遥控器这类横屏设备每次投屏都会「先竖后横」跳一下 —— 必须接上。
   */
  probeScreen: (serial, adbPath) => orientationProbe.screenOf(serial, adbPath),
  /*
   * 自定义 scrcpy 参数每次启动现取（用户在设置里改完立刻点投屏也要生效）。
   *
   * 放在这里而不是建服务时读一次：设置是用户可以随时改的，
   * 缓存下来就会出现「改了设置、重启应用才生效」这种说不清的行为。
   */
  getExtraArgs: () => settings().getScrcpyArgs(),
  emit: (event) => {
    /*
     * 会话事件 → 窗口 + 渲染层，两条路都要走。
     *
     * 窗口这条路先走：会话结束后渲染层收到 exited 时窗口已经在关，
     * 顺序反过来会让用户看到「窗口里闪一下暂停态」。
     */
    if (event.kind === 'started') mirrorWindows.open(event.session)
    else mirrorWindows.close(event.serial)

    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send(CH.MIRROR_CHANGED, event)
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

/**
 * 从 IPC 事件反查它来自哪个窗口。
 *
 * 这是「多窗口按钮不串台」的唯一依据：渲染层只能通过事件表达「我点了」，
 * 而事件里带着 sender。任何「取第一个窗口」的写法都会在设置窗口里出错。
 * 窗口已销毁 / sender 不是窗口时返回 undefined（调用方按安全空操作处理）。
 */
function windowOfEvent(event: unknown): BrowserWindow | undefined {
  const sender = (event as { sender?: unknown } | undefined)?.sender
  if (sender === undefined || sender === null) return undefined
  const win = BrowserWindow.fromWebContents(sender as Electron.WebContents)
  return win === null ? undefined : win
}

/** 设置窗口只允许有一个（连点两次不该开出两个）。 */
let settingsWindow: BrowserWindow | undefined

/** 主窗口引用（子窗口的父、以及「主窗口关了就把子窗口一起关」需要它）。 */
let mainWindow: BrowserWindow | undefined

/**
 * 是否正在真正退出。
 *
 * 关闭按钮走的是 hide()（退到后台），只有托盘菜单「退出」会把它置 true。
 * 这个标志必须由 main.ts 持有并传进 closeOutcome：把它放进渲染层就等于
 * 让渲染层决定进程生死，而 Alt+F4、系统关机这些路径根本不经过渲染层。
 */
let isQuitting = false

/**
 * 托盘图标。
 *
 * 为什么要托盘：关闭改为「退到后台」之后，用户需要一个看得见、点得到的入口
 * 把窗口叫回来，以及一个明确的「退出」。没有托盘的话，hide 掉的窗口就再也
 * 找不回来（任务栏里没有它，Alt+Tab 也没有）——那才是真正的「关不掉也开不了」。
 *
 * 图标走 extraResources/icon.png，与安装包图标同一份资源。
 */
let tray: Tray | undefined

function trayIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(dirname, '..', 'resources', 'icon.png')
}

function createTray(): void {
  if (tray !== undefined && !tray.isDestroyed()) return
  /*
   * 用 createFromPath 而不是 createEmpty：空图标在托盘区是不可见的，
   * 用户会以为「托盘没起来」，而这个功能的全部意义就是「看得见的入口」。
   */
  const image = nativeImage.createFromPath(trayIconPath())
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
  tray.setToolTip('HASH')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: t('tray.show'),
        click: () => { restoreMainWindow(mainWindow) },
      },
      { type: 'separator' },
      {
        label: t('tray.quit'),
        click: () => {
          // 先置位再 quit：close 事件处理器据此放行，走完整的 before-quit 清理。
          isQuitting = true
          app.quit()
        },
      },
    ]),
  )
  // 单击托盘 = 把窗口叫回来（Windows 上最常见的习惯）。
  tray.on('click', () => { restoreMainWindow(mainWindow) })
}

/**
 * 打开（或聚焦）设置子窗口。
 *
 * ===== 为什么是独立窗口，而不是主窗口内的一页 =====
 * 改完下载路径通常想立刻回文件页确认，而切页会卸载文件页（视觉上等于重新进来一次）。
 * 独立窗口让「改设置」与「看文件」能同时进行 —— 这是桌面应用的固有优势。
 *
 * ===== 为什么设置窗口不可最大化 =====
 * 它只有两块固定高度的信息，最大化只会变成一大片空白。
 * 与其给一个能点但没用的按钮，不如不给（渲染层也同步不画那个按钮）。
 */
function openSettingsWindow(): void {
  // 已开过且还活着 → 聚焦（也许被最小化了，先还原）
  if (settingsWindow !== undefined && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.focus()
    return
  }

  /*
   * 父窗口只用于「跟随主窗口最小化/置顶」这类视觉关系。
   *
   * 必须避开 settingsWindow 自己（getAllWindows() 的顺序不保证）：
   * 把设置窗口设成它自己的 parent 会形成一个无效的循环引用。
   */
  const parent = mainWindow !== undefined && !mainWindow.isDestroyed()
    ? mainWindow
    : BrowserWindow.getAllWindows().find((w) => w !== settingsWindow)
  settingsWindow = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 560,
    minHeight: 420,
    parent,
    /* 非模态：改设置时很可能要对着主窗口里的文件列表确认，挡住主窗口反而碍事。 */
    modal: false,
    maximizable: false,
    frame: false,
    backgroundColor: '#F7F8FA',
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  /*
   * 用 hash 分流到设置视图，而不是打第二个 HTML 入口。
   *
   * 多一个入口就要多一套构建产物、多一份 CSP 配置、多一处 preload 路径问题；
   * 而两个窗口的差别只有「渲染哪棵组件树」。src/App.tsx 的 isSettingsWindow
   * 读的就是这个 hash。
   */
  if (isDev) {
    settingsWindow.loadURL((process.env.VITE_DEV_SERVER_URL as string) + '#/settings')
  } else {
    settingsWindow.loadURL(APP_ENTRY_URL + '#/settings')
  }

  // 最大化状态推送（设置窗口不可最大化，但保持与主窗口同款接线，行为一致）
  settingsWindow.on('maximize', () => {
    settingsWindow?.webContents.send(CH.WINDOW_MAXIMIZED_CHANGED, true)
  })
  settingsWindow.on('unmaximize', () => {
    settingsWindow?.webContents.send(CH.WINDOW_MAXIMIZED_CHANGED, false)
  })
  settingsWindow.on('closed', () => { settingsWindow = undefined })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#F7F8FA',
    /*
     * frame: false —— 去掉系统标题栏。
     *
     * 理由：Windows 的原生标题栏（右上角那三个系统按钮）与应用自己的深色/浅色
     * 顶栏是两套视觉，且它占掉一整条高度。改成自绘之后窗口内容可以一直画到顶部，
     * 顶栏右侧由界面自己提供最小化 / 最大化 / 关闭三个按钮。
     *
     * 代价（必须自己补上，否则用户没法关窗口）：
     *   - 拖动窗口：顶栏那片区域靠 CSS 的 -webkit-app-region: drag；
     *   - 双击最大化、系统快捷键：主进程监听 maximize/unmaximize 推给渲染层；
     *   - 关闭即退出：window-all-closed 已有 app.quit()。
     */
    frame: false,
    webPreferences: {
      // preload 产物是 CJS（.cjs）。不要关闭 sandbox：本项目 preload 依赖沙箱预加载器
      // 提供的 require 垫片，sandbox: false 时 window.api 会全部变成 undefined 且不报错。
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  /*
   * 最大化状态推送。
   *
   * 为什么需要它：双击标题栏、Win+↑、系统菜单都能改变最大化状态，
   * 而这些都不经过渲染层。主进程监听后推过去，图标才不会停在错误的状态上。
   */
  mainWindow = win
  /*
   * 主窗口关掉时把设置窗口一并关掉。
   *
   * 为什么必须显式做：window-all-closed 只在**所有**窗口都关了才触发。
   * 如果用户只关主窗口而设置窗口还开着，进程会继续活着但没有主界面 ——
   * 一个只剩设置窗口的「半死」状态，而且用户再也回不到文件页。
   */
  /*
   * 关闭按钮 = 退到后台，不是退出程序。
   *
   * 为什么改：用户明确要求「点关闭后应用退到后台、任务栏图标还在」。
   * 桌面文件管理器在传输时被误关，传到一半的文件会变成残片 —— 这是真实损失。
   * 真正退出走托盘菜单的「退出」，那里用户是明确表达。
   *
   * 注意是拦 close 事件而不是在 closeWindowOf 里判断：Alt+F4、任务栏右键关闭、
   * 系统关机都走同一条路，只改 IPC 会漏掉后面那些。
   */
  win.on('close', (event) => {
    if (closeOutcome(isQuitting) === 'background') {
      event.preventDefault()
      /*
       * 用 minimize 而不是 hide：hide 会把窗口从任务栏摘掉，而用户要的是
       * 「退到后台，系统底部的应用图标还在，点一下能回来」。minimize 正是这个语义。
       * 设置子窗口一并最小化 —— 单独留一个孤零零的设置窗口不算「退到后台」。
       */
      if (settingsWindow !== undefined && !settingsWindow.isDestroyed()) settingsWindow.minimize()
      win.minimize()
      return
    }
    mainWindow = undefined
    if (settingsWindow !== undefined && !settingsWindow.isDestroyed()) settingsWindow.close()
  })
  win.on('maximize', () => {
    win.webContents.send(CH.WINDOW_MAXIMIZED_CHANGED, true)
  })
  win.on('unmaximize', () => {
    win.webContents.send(CH.WINDOW_MAXIMIZED_CHANGED, false)
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
  /*
   * 没有单实例锁时这里必须直接返回。
   *
   * 上面虽然已经 app.quit()，但那是异步的：whenReady 的回调仍会执行。
   * 不挡住的话，第二个实例会真的建窗口、真的起托盘，然后随进程消失 ——
   * 表现为「双击图标，窗口闪一下」。正常应用此时应当毫无反应。
   */
  if (!mayStartApp(gotTheLock)) return
  createTray()
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
              /*
               * R7：应用版本号 —— 设置页「关于」显示的就是它。
               *
               * ===== 为什么直接在这里调 app.getVersion()，而不走上面的懒建 settings() =====
               * 懒建（main.ts:128-139）的唯一理由是 app.getPath('userData' / 'downloads')
               * 在 app ready 之前不可靠。app.getVersion() 不读任何路径：它取的是打包时
               * 的 package.json / 可执行文件元数据，模块顶层调用也是对的 —— 那条不成立的理由
               * 不能顺带套在它身上。
               *
               * 反过来，塞进 createSettingsStore 会让「设置存储」多一个与持久化无关的
               * 版本依赖（版本既不落盘也不可写），并迫使 settings-store 的每个测试
               * 都去构造一个版本号。放在注入处 = 版本只有主进程一个来源，
               * 渲染层拿到的永远是 app.getVersion() 的返回值，发版只改 package.json。
               */
              getAppVersion: () => app.getVersion(),
              // R9：按设备序列号记住上次停留的目录
              getDeviceCwd: (serial) => settings().getDeviceCwd(serial),
              setDeviceCwd: (serial, cwd) => { settings().setDeviceCwd(serial, cwd) },
              // 自定义投屏参数（全局一套）：与其它设置项同一个设置文件、同一条降级范式
              getScrcpyArgs: () => settings().getScrcpyArgs(),
              getDefaultScrcpyArgs: () => settings().getDefaultScrcpyArgs(),
              setScrcpyArgs: (raw) => settings().setScrcpyArgs(raw),
              resetScrcpyArgs: () => settings().resetScrcpyArgs(),
            },
            transfer: transfer.controller,
            batch: batchService,
            capture: captureService,
            apps: appsService,
            keys: keyService,
            mirror: mirrorService,
            /*
             * 投屏会话变化 → 所有窗口。
             *
             * 广播而不是只推给主窗口：投屏侧边栏所在的窗口与「用户正在看的窗口」
             * 未必是同一个，漏推会让另一边的按钮状态永远停在「已投屏」。
             */
            emitMirror: (event) => {
              for (const win of BrowserWindow.getAllWindows()) {
                if (win.isDestroyed()) continue
                win.webContents.send(CH.MIRROR_CHANGED, event)
              }
            },
            /*
             * 应用管理装 APK 用的文件选择框。
             *
             * 与 batchService 的 pickApk 分开注入：那个的语义是「给批量安装挑一个包」，
             * 它的选择框默认落在下载目录且带 apk 过滤器；应用管理这边用户可能刚拉完
             * 一个 APK 就在同一个目录里装回去，路径来源不同但对话框行为一致。
             */
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
             * 安装进度 → 所有窗口。
             *
             * 为什么推给**所有**窗口而不是只在应用页的那个：装包期间用户完全可能
             * 切到文件页，进度断了会让他以为装完了/装失败了。广播的成本是每个窗口
             * 一次 send，而漏推的代价是一次几十秒的「不知道在干什么」。
             */
            /*
             * 自绘顶栏的窗口控制。
             *
             * pick() 每次现取：窗口可能在任意时刻被销毁（退出流程中），
             * 控制器内部对「没有窗口」是安全空操作。
             */
            /*
             * 窗口控制按**发起命令的那个窗口**路由。
             *
             * 应用现在有两个窗口（主窗口 + 设置子窗口）。如果一律取
             * getAllWindows()[0]，在设置窗口点最小化会最小化主窗口 ——
             * 这种缺陷只有在两个窗口同时在屏幕上时才看得出来。
             *
             * sender → BrowserWindow 的映射由 electron 提供（fromWebContents）；
             * 窗口已销毁时返回 undefined，控制器内部按「没有窗口」安全空操作。
             */
            windowOf: (event) => createWindowController(() => windowOfEvent(event)),
            closeWindowOf: (event) => {
              const win = windowOfEvent(event)
              // 关窗口 → 没有窗口了才 window-all-closed → quit。关设置窗口不会退出程序。
              if (win !== undefined && !win.isDestroyed()) win.close()
            },
            openSettings: () => { openSettingsWindow() },
            emitInstallProgress: (payload) => {
              for (const win of BrowserWindow.getAllWindows()) {
                if (win.isDestroyed()) continue
                win.webContents.send(CH.APPS_INSTALL_PROGRESS, payload)
              }
            },
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
          /*
           * 设备掉线/移除 → 自动结束它的投屏会话。
           *
           * 为什么放在这里而不是渲染层：会话表在主进程，只有这里能保证
           * 「设备没了，scrcpy 进程也不会留着」。用 catch 兜住是为了不让
           * 一次清理失败拖垮整条设备变更链路。
           */
          void mirrorService.onDeviceChanged(batch).catch((err: unknown) => {
            console.warn('[mirror] 设备变更时结束投屏失败：' + String(err))
          })
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
  // 置位：此后主窗口的 close 不再被拦（关闭 = 真关），清理流程得以继续。
  isQuitting = true
  // 托盘必须先销毁：否则进程退出后会在托盘区留一个点不动的僵尸图标。
  if (tray !== undefined && !tray.isDestroyed()) {
    tray.destroy()
    tray = undefined
  }
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
  // P1：单机录屏是长驻进程，退出时必须逐台发停止（设备的 --time-limit 是兜底，
  // 但那条上限是分钟级的，不能指望它）；未结算的临时文件清理同样在这里兑现。
  captureService.dispose()
  /*
   * 投屏进程是长驻的原生窗口，退出时必须全部收掉。
   *
   * 这里的 await 不能等：before-quit 是同步事件。用 void + 立即 kill 的方式
   * （dispose 内部对每个会话都调 killTree，且 children.ts 的闸门随后兜底）。
   */
  void mirrorService.dispose().catch((err: unknown) => {
    console.warn('[mirror] 退出时结束投屏失败：' + String(err))
  })
  // 窗口必须一起关：宿主窗口先于子窗口销毁会留下一个悬空的原生窗口
  mirrorWindows.closeAll()
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
  captureCleanup.clear()
  shutdownChildren()
  tracking?.flushChanges()
  tracking?.stop()
  tracking = undefined
})

/*
 * 所有窗口都没了才退出。
 *
 * 注意：关闭按钮走 hide()，窗口并**没有**被销毁，所以这条不会因为「点关闭」
 * 触发 —— 进程与托盘继续存在，这正是「退到后台」的定义。
 * 只有托盘菜单「退出」（isQuitting=true，窗口真的 close 掉）才会走到这里。
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit()
})
