import {
  BATCH_INSTALL_INPUT,
  BATCH_PUSH_INPUT,
  BATCH_SCREENSHOT_INPUT,
  BATCH_SHELL_INPUT,
  CAPTURE_RECORD_START_INPUT,
  CAPTURE_RECORD_STOP_INPUT,
  CAPTURE_SCREENSHOT_INPUT,
  DEVICE_KEYEVENT_INPUT,
  MIRROR_START_INPUT,
  MIRROR_STOP_INPUT,
  APPS_DETAIL_INPUT,
  APPS_INSTALL_INPUT,
  APPS_LIST_INPUT,
  APPS_PACKAGE_INPUT,
  APPS_PULL_APK_INPUT,
  DRAG_OUT_INPUT,
  FS_BATCH_INPUT,
  FS_LIST_INPUT,
  FS_MKDIR_INPUT,
  FS_REMOVE_FACTS_INPUT,
  FS_RENAME_INPUT,
  LOCAL_FILE_STAT_INPUT,
  LOCAL_LIST_INPUT,
  LOCAL_PICK_ROOT_INPUT,
  SETTINGS_GET_DEVICE_CWD_INPUT,
  SETTINGS_GET_INPUT,
  SETTINGS_PICK_DOWNLOAD_DIR_INPUT,
  SETTINGS_RESET_DOWNLOAD_DIR_INPUT,
  SETTINGS_SET_DEVICE_CWD_INPUT,
  SETTINGS_SET_DOWNLOAD_DIR_INPUT,
  SETTINGS_SET_SCRCPY_ARGS_INPUT,
  TRANSFER_CLEAR_INPUT,
  TRANSFER_ENQUEUE_INPUT,
  TRANSFER_ID_INPUT,
} from '../../src/shared/api-contract'
import type { BatchRunData } from '../../src/shared/batch'
import type { CaptureResult, RecordStarted } from '../../src/shared/capture'
import type { AppDetail, AppEntry, InstallProgress } from '../../src/shared/apps'
import type { DeviceKey } from '../../src/shared/device-key'
import type { MirrorEvent, MirrorSession } from '../../src/shared/mirror'
import type { KeyController } from '../device/keys'
import type { MirrorController } from '../mirror/service'
import { toSettingsAdb, type SettingsData } from '../../src/shared/settings'
import type { FsOpData, FsRemoveFactsData, LocalFileStat, LocalListData } from '../../src/shared/file-ops'
import type { DeviceManager } from '../devices/manager'
import type { ShellRunner } from '../fs/remote'
import { normalizeDir } from '../fs/remote'
import { E_BAD_ARGS, E_NO_SERIAL, E_ADB_NOT_FOUND, E_NOT_FOUND, toErrorCode } from '../../src/shared/errors'
import type { TransferSnapshot, TransferTask } from '../../src/shared/transfer'
import type {
  AdbState,
  DeviceSnapshot,
  FsListData,
  IpcResult,
} from '../../src/shared/types'
import { CH, INVOKE_CHANNELS } from './channels'

/**
 * IPC 通道注册（裁决 2）。
 *
 * 三条硬约束：
 * 1. 每个入参都过 zod；校验失败返回 { ok:false, error:'E_BAD_ARGS' }，绝不抛异常
 *    —— 异常穿过 ipcMain.handle 会被 Electron 包成 "Error invoking remote method"，
 *    渲染层拿不到结构化错误码，只能解析字符串，等于把错误处理外包给了错误消息格式。
 * 2. 主进程只信任自己掌握的会话表：fs:list 的 serial 必须是已连上的设备，
 *    绝不凭渲染层传什么就发命令。
 * 3. 业务错误同样收敛成 { ok:false, error:<code> }，渲染层永远只需处理一种形状。
 */

import type { WindowController } from '../window/controller'

/** ipcMain 的最小契约（测试注入假实现，不必起 Electron）。 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void
}

export interface HandlerDeps {
  devices: DeviceManager
  /** 已解析出的 adb 绝对路径；空串表示还没定位到（或定位失败）。 */
  adbPath: () => string
  /** adb 自检状态（设备栏显示「无法使用 adb」）。 */
  adbState: () => AdbState
  /** 按 serial 造 client。 */
  clientFactory: (serial: string) => ShellRunner
  /**
   * 传输调度器。
   *
   * 只依赖【接口】而不是具体类：测试可以塞一个假调度器验证 IPC 层的
   * 校验 / 会话检查 / 错误码收敛，不必起真 adb。
   */
  transfer: TransferController
  /**
   * 打开系统文件选择框。
   *
   * 注入而不是在 handler 里直接 import electron 的 dialog：
   * tests/ipc-handlers.test.ts 在纯 node 下跑，import electron 会直接炸；
   * 而且「取消选择」与「选中若干文件」这两条路径都能被测到。
   */
  pickFiles: () => Promise<string[]>
  /** 文件操作服务（新建/重命名/删除/复制/移动）。 */
  ops: FileOpsController
  /** 本地目录访问（限制在用户选定的根目录内）。 */
  local: LocalController
  /** 让用户挑选本地栏的起始浏览目录（系统目录选择框）；取消返回空串。 */
  pickRoot: () => Promise<string>
  /**
   * 批量动作服务（任务 10）。
   *
   * 与 ops / local 一样只依赖接口：IPC 层负责「校验 + 会话检查 + 错误码收敛」，
   * 四个动作各自的编排（离线跳过、参数预检、截图走队列）由 service 负责并有专门测试。
   */
  batch: BatchController
  /** 单机截图 / 录屏（P1 第一批）。 */
  capture: CaptureController
  /** 应用管理（P1 第二批）。 */
  apps: AppsController
  /** 设备按键（投屏侧边栏的六个按钮）。 */
  keys: KeyController
  /** scrcpy 投屏（P1 第三批）。 */
  mirror: MirrorController
  /**
   * 把投屏会话变化推给渲染层。
   *
   * 注入而不是在这里 import BrowserWindow：IPC 层要能在纯 node 测试里跑，
   * 与 emitInstallProgress 同一手法。
   */
  emitMirror: (event: MirrorEvent) => void
  /** 弹出文件选择框挑一个 .apk（应用管理安装用）；取消返回空串。 */
  pickApk: () => Promise<string>
  /**
   * 按「发起命令的 IPC 事件」取那个窗口的控制器。
   *
   * 为什么是函数而不是一个实例：应用有两个窗口（主窗口 + 设置子窗口），
   * 一律取 getAllWindows()[0] 会让「在设置窗口点最小化」变成最小化主窗口。
   * 事件里带着 sender，只有它能确定「用户点的是哪个窗口的按钮」。
   *
   * 注入而不是在主进程里 import BrowserWindow：控制器本身的行为
   * （没有窗口时安全空操作、最大化/还原共用一个按钮）有专门测试。
   */
  windowOf: (event: unknown) => WindowController
  /**
   * 把投屏窗口恢复到默认尺寸（按发起命令的那个投屏窗口的 serial）。
   *
   * 为什么需要「按 sender 反查 serial」：投屏窗口的 hash 里带着 serial
   * （#/mirror/<serial>），渲染层把它传上来即可 —— 但主进程一侧仍要校验它
   * 确实是当前在投屏的设备，否则一个窗口能重置另一个窗口的尺寸。
   */
  resetMirrorSize: (event: unknown, serial: string) => void
  /** 关掉发起命令的那个窗口；没有窗口时是安全空操作。 */
  closeWindowOf: (event: unknown) => void
  /**
   * 打开（或聚焦）设置子窗口。
   *
   * 设置不再是主窗口内的一页：它有自己的窗口，主窗口停在原地。
   * 已在开则聚焦 —— 连点两次不该开出两个设置窗口。
   */
  openSettings: () => void
  /**
   * 把安装进度推给渲染层。
   *
   * 注入而不是在这里 import BrowserWindow：IPC 层要能在纯 node 测试里跑
   * （tests/apps-ipc.test.ts 断言「进度事件确实被转发」）。
   */
  emitInstallProgress: (payload: InstallProgress) => void
  /**
   * 拖拽（简报 C）。
   *
   * 只依赖接口：IPC 层负责「校验 + 会话检查 + 错误码收敛」，
   * 「下载到临时目录 → 等终态 → startDrag」的编排在 electron/drag/service.ts
   * 并有专门的行为测试。这样 IPC 测试不需要 Electron、也不需要真 adb。
   */
  drag: DragController
  /**
   * 设置（R2-2：默认下载路径的持久化）。
   *
   * 只依赖接口而不是 electron-store 本身：electron-store 依赖 Electron 的 app 对象，
   * 在纯 node 的测试环境里 import 即炸（见 electron/settings/store.ts 的注入式设计）。
   * 这正是「持久化必须用真读写证明」能在 node 里跑起来的原因。
   */
  settings: SettingsController
  /**
   * 让用户挑一个目录作为默认下载路径。
   *
   * 与 pickRoot 分开注入：pickRoot 会顺带把本地面板的起始浏览目录改掉，
   * 而「在设置页换下载路径」不该让本地栏跳走 —— 两件事只是共用系统对话框。
   * 取消返回空串（与 pickRoot / pickFiles 同一约定）。
   */
  pickDownloadDir: () => Promise<string>
  /** 目录列举实现（默认 listDirDetailed；测试可注入）。 */
  fs: {
    list: (client: ShellRunner, adbPath: string, dir: string) => Promise<{
      entries: FsListData['entries']
      degraded: boolean
      unparsed: number
      usedFallback: boolean
      exitCode: number | null
      tzOffsetMinutes: number
    }>
  }
}

/**
 * 传输调度器对 IPC 层暴露的最小面（electron/transfer/manager 的 TransferManager 满足它）。
 *
 * enqueue 的路径参数是「渲染层给的原始意图」：
 *   push: src = 本地文件绝对路径，dstDir = 设备上的目标目录
 *   pull: src = 设备上的源文件路径，destDir = 本地目标目录
 * 由调度器负责拼出完整目标路径与取 totalBytes（裁决 5）。
 */
export interface TransferController {
  /**
   * 入队。**返回 Promise** —— 因为入队前要解析本地路径（realpath 是 IO）。
   *
   * 复审 C1 之前这里是同步的，而「同步」正是当时没法做路径归一化的直接原因
   * （符号链接只有 realpath 能展开）。IPC handler 本来就是 async，代价为零。
   * R2-1：本地根目录限制已移除，但路径解析仍然要做（判定路径 = 执行路径）。
   */
  enqueue(input: {
    serial: string
    direction: 'push' | 'pull'
    src: string
    dstDir: string
  }): Promise<TransferTask>
  cancel(id: string): boolean
  retry(id: string): boolean
  get(id: string): TransferTask | undefined
  snapshot(): TransferSnapshot
  clearFinished(): number
}

/**
 * 文件操作对 IPC 层暴露的最小面（electron/fs/op-service 的 FsOpsService 满足它）。
 *
 * 只依赖接口而不是具体类：测试可以塞一个假实现验证
 * 「校验 / 会话检查 / 错误码收敛 / 逐项结果透传」，不必起真 adb。
 */
export interface FileOpsController {
  mkdir(serial: string, dir: string, name: string): Promise<{ ok: true } | { ok: false; code: string }>
  rename(serial: string, from: string, newName: string): Promise<{ ok: true } | { ok: false; code: string }>
  removeFacts(serial: string, targets: readonly string[]): Promise<FsRemoveFactsData>
  remove(serial: string, targets: readonly string[]): Promise<FsOpData>
  copy(serial: string, sources: readonly string[], dstDir: string | undefined): Promise<FsOpData>
  move(serial: string, sources: readonly string[], dstDir: string | undefined): Promise<FsOpData>
}

/**
 * 设置对 IPC 层暴露的最小面（electron/settings/store.ts 的 SettingsStore 满足它）。
 *
 * 四个方法 = 三个动作 + 一个读取。**写接口返回写入后的值**，而不是 void：
 * IPC 层要把整份 SettingsData 回给渲染层，界面不必再发一次 get 才知道结果。
 */
export interface SettingsController {
  /** 当前生效的默认下载路径（坏值已在实现里降级）。 */
  getDownloadDir(): string
  /** 本机「下载」目录（默认值）。 */
  getDefaultDownloadDir(): string
  /** 写默认下载路径；非法值抛 E_INVALID_PATH / E_NOT_FOUND。返回实际写入的值。 */
  setDownloadDir(dir: string): string
  /** 恢复默认；返回实际写入的值。 */
  resetDownloadDir(): string
  /**
   * 应用版本号（R7）。
   *
   * 单独一个方法而不是塞进 SettingsStore：版本既不落盘也不可写，
   * 与「默认下载路径的持久化」没有关系。具体实现由 main.ts 注入
   * （`() => app.getVersion()`），这样 IPC 层只依赖一个字符串来源，
   * 测试可以直接喂假值证明「版本是透传的，不是写死的」。
   */
  getAppVersion(): string
  /**
   * 该设备上次停留的目录（R9）；没有记录 / 记录是坏值 → undefined。
   *
   * 返回 undefined 而不是空串：**「没记过」与「记了个空串」必须区分** ——
   * 后者是坏值（存储层会告警并降级），前者是正常初始状态。
   * 转成 IPC 友好的空串由 handler 那一层做。
   */
  getDeviceCwd(serial: string): string | undefined
  /**
   * 记住某台设备停留的目录（R9）。
   *
   * void 而不是返回写入后的值：这个动作没有需要回给界面的结果
   * （界面本来就知道自己进了哪个目录），返回值只会诱使调用方去 await 它。
   * 非法入参（空 serial / 空 cwd / 非绝对路径）在存储层被静默拒绝 + warn。
   */
  setDeviceCwd(serial: string, cwd: string): void
  /**
   * 自定义 scrcpy 参数（全局一套，原始输入）。
   *
   * 读取时坏值已降级成空串，所以拿到的一定是可直接切分的字符串。
   */
  getScrcpyArgs(): string
  /** 默认参数（「恢复默认」写回它，界面也用它判断当前是不是默认）。 */
  getDefaultScrcpyArgs(): string
  /** 写自定义 scrcpy 参数；返回实际写入的值（已 trim）。 */
  setScrcpyArgs(raw: string): string
  /** 恢复默认参数；返回实际写入的值。 */
  resetScrcpyArgs(): string
}

/** 本地目录访问的最小面（electron/fs/local 的 LocalFs 满足它）。 */
export interface LocalController {
  list(dir?: string): Promise<LocalListData>
  /**
   * 预检「这个目录里有没有同名文件、它多大」（R10 双击下载前）。
   *
   * 实现在 electron/fs/local.ts 的 LocalFs.fileStat：目录过 resolveLocalPath、
   * 名字过 checkName，stat 失败一律 exists:false（查不了就当不存在，照常下载）。
   */
  fileStat(dir: string, name: string): Promise<LocalFileStat>
}

/**
 * 批量动作对 IPC 层暴露的最小面（electron/batch/service 的 BatchService 满足它）。
 *
 * 六个方法 = 四个动作 + 两个选择框。选择框也在这一层，因为它们的**结果**
 * 只有批量动作会消费（截图目录 / apk 路径），拆成独立服务只是多一层转发。
 */
export interface BatchController {
  screenshot(input: { serials: readonly string[] }, dstDir: string): Promise<BatchRunData>
  install(input: { serials: readonly string[] }, apkPath: string): Promise<BatchRunData>
  push(input: { serials: readonly string[]; files: readonly string[]; dstDir: string }): Promise<BatchRunData>
  shell(input: { serials: readonly string[] }, command: string): Promise<BatchRunData>
  pickScreenshotDir(): Promise<string>
  pickApk(): Promise<string>
}

/**
 * 单机截图 / 录屏对 IPC 层暴露的最小面（electron/capture/service 的 CaptureService 满足它）。
 *
 * 与 batch 同一原则：IPC 层只做「zod 校验 + 会话检查 + 错误码收敛」，
 * 「临时文件怎么建、录屏怎么收尾、拉回来之后怎么清」都由 service 负责，
 * 那条链路有专门的假 client / 假录屏用例（tests/capture-service.test.ts）。
 */
export interface CaptureController {
  screenshot(serial: string, dstDir: string): Promise<CaptureResult>
  startRecord(serial: string, dstDir: string): Promise<RecordStarted>
  stopRecord(serial: string): Promise<CaptureResult>
}

/**
 * 应用管理对 IPC 层暴露的最小面（electron/apps/service 的 AppsService 满足它）。
 *
 * 与其它服务同一原则：IPC 层只做「zod 校验 + 会话检查 + 错误码收敛」，
 * 解析、命令构造、包名闸门都在 service 与 shared/apps 里（有专门用例）。
 */
export interface AppsController {
  listApps(serial: string): Promise<AppEntry[]>
  appDetail(serial: string, packageName: string): Promise<AppDetail>
  pullApk(serial: string, packageName: string, dstDir: string): Promise<{ packageName: string; files: string[] }>
  /**
   * 安装 APK。
   *
   * onProgress 由 IPC 层注入：它把回调转成 webContents.send（渲染层只订阅事件）。
   * service 不认识 Electron，这是本项目「主进程服务不 import electron」那条红线的延伸。
   */
  installApk(
    serial: string,
    apkPath: string,
    onProgress?: (payload: InstallProgress) => void,
  ): Promise<void>
  forceStop(serial: string, packageName: string): Promise<void>
  clearData(serial: string, packageName: string): Promise<void>
  uninstall(serial: string, packageName: string): Promise<void>
  launch(serial: string, packageName: string): Promise<void>
}

/**
 * 拖拽对 IPC 层暴露的最小面（electron/drag/service 的 DragOutService 满足它）。
 *
 * 与 transfer / ops / batch 同一原则：只依赖接口，测试塞假实现即可验证
 * 「校验/会话检查/错误码收敛」，不必启动 Electron。
 */
export interface DragController {
  dragOut(input: { serial: string; paths: string[] }): Promise<{ ok: true } | { ok: false; code: string }>
}

/** 统一的失败出口。 */
function fail(error: string): IpcResult<never> {
  return { ok: false, error }
}

/**
 * 注册全部 invoke 通道。
 * 重复注册会抛错 —— 两处 registerHandlers 互相覆盖时，后者的 handler 静默生效，
 * 而调用方毫无察觉，这是最难查的一类 IPC 故障。
 */
export function registerHandlers(deps: HandlerDeps, ipc: IpcMainLike): void {
  const registered = new Set<string>()
  const handle = (channel: string, listener: (event: unknown, payload?: unknown) => unknown): void => {
    if (registered.has(channel)) throw new Error('duplicate handler: ' + channel)
    registered.add(channel)
    ipc.handle(channel, listener)
  }

  handle(CH.DEVICES_LIST, (): IpcResult<DeviceSnapshot> => {
    // 设备表只认主进程掌握的会话表；渲染层传来的载荷一律忽略。
    return { ok: true, data: { devices: deps.devices.list(), adb: deps.adbState() } }
  })

  handle(CH.FS_LIST, async (_event, payload): Promise<IpcResult<FsListData>> => {
    // 入参 schema 来自 api-contract（与 preload / api.d.ts 同源，见 I4）
    const parsed = FS_LIST_INPUT.safeParse(payload)
    if (!parsed.success) return fail(E_BAD_ARGS)
    const { serial, dir } = parsed.data

    // serial 必须对应一台已建立的会话：渲染层不能凭字符串命令任意设备
    if (deps.devices.get(serial) === undefined) return fail(E_NO_SERIAL)

    const adbPath = deps.adbPath()
    if (adbPath === '') return fail(E_ADB_NOT_FOUND)

    // 路径先归一化：既拿到返回给渲染层的规范路径，也让非法字符在校验层就被拒，
    // 避免带着坏路径进到 adb 命令构造里再炸。
    let normalized: string
    try {
      normalized = normalizeDir(dir)
    } catch (err) {
      return fail(toErrorCode(err))
    }

    try {
      const result = await deps.fs.list(deps.clientFactory(serial), adbPath, normalized)
      return {
        ok: true,
        data: {
          serial,
          dir: normalized,
          entries: result.entries,
          degraded: result.degraded,
          unparsed: result.unparsed,
          usedFallback: result.usedFallback,
          exitCode: result.exitCode,
          tzOffsetMinutes: result.tzOffsetMinutes,
        },
      }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /* ============ 文件操作（任务 9） ============ */

  /**
   * 所有写操作通道共用的前置检查。
   *
   * 三条判据（与 fs:list 一致，且**必须**一致 —— 不一致就是一条能被绕过的旁路）：
   * 1. serial 必须是主进程掌握的会话，否则渲染层可以命令任意设备；
   * 2. adb 必须已定位，否则下游 spawn('') 会变成一个语焉不详的 E_SYNC_FAILED；
   * 3. 入参必须过 zod。
   *
   * 返回 Ok 时把 deps 里的 serial 收窄成分支，避免每个 handler 再写一遍。
   */
  /*
   * schema 的返回形状写成一个可判别联合（而不是 { success: boolean; data?: T }）：
   * 后者在 success 为真时 data 仍然是 T | undefined，收窄不过去，只能靠 as 硬转。
   * 联合写法与 zod 的 ZodSafeParseResult 同形（成功分支 data 必填），
   * 于是 if (!parsed.success) 之后 data 自然就是 T —— 类型是真收敛的，不是断言出来的。
   */
  type ParseResult<T> =
    | { success: true; data: T; error?: never }
    | { success: false; data?: never; error?: unknown }
  const preflight = <T>(payload: unknown, schema: { safeParse: (value: unknown) => ParseResult<T> }): { ok: true; data: T } | { ok: false; error: string } => {
    const parsed = schema.safeParse(payload)
    /*
     * 【问题 1 修复】这里只认 success，不再要求 data !== undefined。
     *
     * 修前是 !parsed.success || parsed.data === undefined：而 ipcRenderer.invoke(channel)
     * 不带载荷时 payload 就是 undefined，z.unknown().safeParse(undefined) 是 success=true、
     * data=undefined —— 于是「无载荷」这个【合法】形态被判成 E_BAD_ARGS，
     * 「更换目录」按钮稳定报「请求参数不合法」（真机实测复现）。
     *
     * 安全性没有因此降低：真正需要载荷的通道用的是 z.object(...)，缺字段时 success 为 false，
     * 仍然在这里被拒（tests/ipc-handlers.test.ts 有对照组：fs:list 不带载荷仍是 E_BAD_ARGS）。
     */
    if (!parsed.success) return { ok: false, error: E_BAD_ARGS }
    // zod 的成功分支里 data 一定存在（ZodSafeParseSuccess.data 是必填字段，没有 undefined 成员）——
    // 这里的收窄靠的是联合类型判别，不是 as。
    return { ok: true, data: parsed.data }
  }

  handle(CH.FS_MKDIR, async (_event, payload): Promise<IpcResult<FsOpData>> => {
    const parsed = preflight<{ serial: string; dir: string; name: string }>(payload, FS_MKDIR_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    const { serial, dir, name } = parsed.data
    if (deps.devices.get(serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)
    try {
      const result = await deps.ops.mkdir(serial, dir, name)
      // 单项目操作也统一成逐项结果：渲染层只需处理一种形状（裁决 4 的同一条原则）
      return {
        ok: true,
        data: { results: [result.ok ? { name, ok: true } : { name, ok: false, code: result.code }] },
      }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.FS_RENAME, async (_event, payload): Promise<IpcResult<FsOpData>> => {
    const parsed = preflight<{ serial: string; from: string; name: string }>(payload, FS_RENAME_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    const { serial, from, name } = parsed.data
    if (deps.devices.get(serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)
    try {
      const result = await deps.ops.rename(serial, from, name)
      return {
        ok: true,
        data: { results: [result.ok ? { name, ok: true } : { name, ok: false, code: result.code }] },
      }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.FS_REMOVE_FACTS, async (_event, payload): Promise<IpcResult<FsRemoveFactsData>> => {
    const parsed = preflight<{ serial: string; targets: string[] }>(payload, FS_REMOVE_FACTS_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    if (deps.devices.get(parsed.data.serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)
    try {
      return { ok: true, data: await deps.ops.removeFacts(parsed.data.serial, parsed.data.targets) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /**
   * 删除。
   *
   * 这个通道**不做二次确认** —— 确认是渲染层的职责（裁决 1 要求确认框列事实）。
   * 主进程侧的另一半防线是 fs/path-guard 的受保护路径：即使渲染层被绕过，
   * /sdcard、/storage/emulated/0 这类根路径依然删不掉。
   * 两层各自独立，不把安全押在单一层上。
   */
  handle(CH.FS_REMOVE, async (_event, payload): Promise<IpcResult<FsOpData>> => {
    const parsed = preflight<{ serial: string; targets: string[] }>(payload, FS_REMOVE_FACTS_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    if (deps.devices.get(parsed.data.serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)
    try {
      return { ok: true, data: await deps.ops.remove(parsed.data.serial, parsed.data.targets) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.FS_COPY, async (_event, payload): Promise<IpcResult<FsOpData>> => {
    const parsed = preflight<{ serial: string; sources: string[]; dstDir?: string }>(payload, FS_BATCH_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    if (deps.devices.get(parsed.data.serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)
    try {
      return { ok: true, data: await deps.ops.copy(parsed.data.serial, parsed.data.sources, parsed.data.dstDir) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.FS_MOVE, async (_event, payload): Promise<IpcResult<FsOpData>> => {
    const parsed = preflight<{ serial: string; sources: string[]; dstDir?: string }>(payload, FS_BATCH_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    if (deps.devices.get(parsed.data.serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)
    try {
      return { ok: true, data: await deps.ops.move(parsed.data.serial, parsed.data.sources, parsed.data.dstDir) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /* ============ 本地目录（任务 9 本地双栏，裁决 5） ============ */

  handle(CH.LOCAL_LIST, async (_event, payload): Promise<IpcResult<LocalListData>> => {
    const parsed = preflight<{ dir?: string }>(payload, LOCAL_LIST_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return { ok: true, data: await deps.local.list(parsed.data.dir) }
    } catch (err) {
      // 路径不合法（E_INVALID_PATH）与不存在（E_NOT_FOUND）都必须如实传出去：
      // 前者是路径本身写错了，后者是目标不在了，界面要给不同提示。
      // （R2-1：本地根沙箱已移除，这里不再有「越界」这一种失败。）
      return fail(toErrorCode(err))
    }
  })

  /*
   * R10：双击下载前的本地同名文件预检。
   *
   * 这条通道**没有** IPC 层自己的失败分支，这是刻意的：
   * 它的语义只有「有（多大）」与「没有」，而「查不到」必须收敛成「没有」——
   * 因为调用方（双击下载）在查不到时要照常下载，不该被一个错误码拦住。
   * 所以 LocalFs.fileStat 自己吞掉 stat 的异常，这里只透传结果。
   * 唯一的失败出口是入参不合法（zod），那属于程序内部错误，渲染层用不到它。
   */
  handle(CH.LOCAL_FILE_STAT, async (_event, payload): Promise<IpcResult<LocalFileStat>> => {
    const parsed = preflight<{ dir: string; name: string }>(payload, LOCAL_FILE_STAT_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return { ok: true, data: await deps.local.fileStat(parsed.data.dir, parsed.data.name) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.LOCAL_PICK_ROOT, async (_event, payload): Promise<IpcResult<string>> => {
    const parsed = preflight<unknown>(payload, LOCAL_PICK_ROOT_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      // 取消选择返回空串（不是错误）：与 transfer:pick-files 的「取消 = 空数组」一致
      return { ok: true, data: await deps.pickRoot() }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /* ============ 设置（R2-2：默认下载路径持久化） ============ */

  /**
   * 一份设置快照。
   *
   * downloadDir 由 SettingsController 保证「可用」：坏值已经在读取时降级成系统「下载」
   * 目录。所以界面拿到的就是可以直接用于下载的路径，不必自己再判一次。
   *
   * adb 状态只读 —— 用户裁决「设置页只加默认下载路径」，adb 只展示不给改。
   *
   * appVersion（R7）也在这里取：三个通道（get / set / reset）回的都是同一份快照，
   * 「关于」那块显示的版本与读设置那一次同源，不会一页里出现两个版本。
   */
  const settingsSnapshot = (): SettingsData => ({
    downloadDir: deps.settings.getDownloadDir(),
    defaultDownloadDir: deps.settings.getDefaultDownloadDir(),
    appVersion: deps.settings.getAppVersion(),
    adb: toSettingsAdb(deps.adbState()),
    scrcpyArgs: deps.settings.getScrcpyArgs(),
    defaultScrcpyArgs: deps.settings.getDefaultScrcpyArgs(),
  })

  handle(CH.SETTINGS_GET, (_event, payload): IpcResult<SettingsData> => {
    const parsed = preflight<unknown>(payload, SETTINGS_GET_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return { ok: true, data: settingsSnapshot() }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /**
   * 写默认下载路径。
   *
   * 校验有三层，缺一不可：
   *   1. zod：必须是非空字符串（空串不是「用默认」，想回默认请点「恢复默认」）；
   *   2. SettingsController：绝对路径 + 目录真实存在（抛 E_INVALID_PATH / E_NOT_FOUND）；
   *   3. try/catch 收敛成错误码 —— 与其它通道同一条原则：绝不把异常穿过 ipcMain.handle。
   *
   * 失败时**不写**任何东西：用户看到错误码就知道没改成，不会出现「界面显示已改、
   * 实际还是旧值」的分叉。
   */
  handle(CH.SETTINGS_SET_DOWNLOAD_DIR, (_event, payload): IpcResult<SettingsData> => {
    const parsed = preflight<{ downloadDir: string }>(payload, SETTINGS_SET_DOWNLOAD_DIR_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      deps.settings.setDownloadDir(parsed.data.downloadDir)
      return { ok: true, data: settingsSnapshot() }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /**
   * 写自定义 scrcpy 参数。
   *
   * 与 set-download-dir 同构：写成功才返回新快照，失败时**一个字节都不写**。
   * 差别在错误面：这里只有 zod 的「太长」一种拒绝理由，
   * 内容合法性（哪些参数会被忽略）不在这里判定 —— 那是启动投屏时的事，
   * 而且它只影响「参数是否生效」，不该拦住保存。
   */
  handle(CH.SETTINGS_SET_SCRCPY_ARGS, (_event, payload): IpcResult<SettingsData> => {
    const parsed = preflight<{ scrcpyArgs: string }>(payload, SETTINGS_SET_SCRCPY_ARGS_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      deps.settings.setScrcpyArgs(parsed.data.scrcpyArgs)
      return { ok: true, data: settingsSnapshot() }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /**
   * 挑一个目录作为默认下载路径。
   *
   * 取消返回空串（不是错误）—— 与 local:pick-root / transfer:pick-files 同一约定。
   * 注意这里**不**落盘：选完只是把路径交回渲染层，由它再调 set-download-dir。
   * 两件事分开的理由：用户可能在选择框里选完又反悔（改主意不点保存），
   * 而「弹框」不应该等于「已写入」。
   */
  handle(CH.SETTINGS_PICK_DOWNLOAD_DIR, async (_event, payload): Promise<IpcResult<string>> => {
    const parsed = preflight<unknown>(payload, SETTINGS_PICK_DOWNLOAD_DIR_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return { ok: true, data: await deps.pickDownloadDir() }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /** 恢复默认下载路径（= 系统「下载」目录）。 */
  handle(CH.SETTINGS_RESET_DOWNLOAD_DIR, (_event, payload): IpcResult<SettingsData> => {
    const parsed = preflight<unknown>(payload, SETTINGS_RESET_DOWNLOAD_DIR_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      deps.settings.resetDownloadDir()
      return { ok: true, data: settingsSnapshot() }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /* ============ R9：按设备记住上次停留的目录 ============ */

  /**
   * 读某台设备上次停留的目录。
   *
   * 三个决定：
   * 1. **没有记录返回空串，不是错误**。「从没记过」是目录记忆的正常初始状态，
   *    用错误码会让首次使用的用户走一遍错误处理（甚至弹提示）。
   * 2. **不检查设备是否在线**：这个通道一次 adb 都不发，它只读本机设置文件。
   *    渲染层的恢复流程拿到记录后才去列举，那时才需要设备在线。
   * 3. 存储层的坏值已在读取时降级成 undefined，这里只做 undefined → '' 的转换。
   */
  handle(CH.SETTINGS_GET_DEVICE_CWD, (_event, payload): IpcResult<string> => {
    const parsed = preflight<{ serial: string }>(payload, SETTINGS_GET_DEVICE_CWD_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return { ok: true, data: deps.settings.getDeviceCwd(parsed.data.serial) ?? '' }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /**
   * 记住某台设备停留的目录。
   *
   * 渲染层是 **fire-and-forget** 地调它（不 await），所以这里的失败不会变成
   * 用户的错误提示；但通道本身仍然守「绝不把异常穿过 ipcMain.handle」这条铁律，
   * 否则会留下一个未处理的 rejection。
   */
  handle(CH.SETTINGS_SET_DEVICE_CWD, (_event, payload): IpcResult<void> => {
    const parsed = preflight<{ serial: string; cwd: string }>(payload, SETTINGS_SET_DEVICE_CWD_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      deps.settings.setDeviceCwd(parsed.data.serial, parsed.data.cwd)
      return { ok: true, data: undefined }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /* ============ 传输（任务 8） ============ */

  handle(CH.TRANSFER_ENQUEUE, async (_event, payload): Promise<IpcResult<TransferTask>> => {
    const parsed = TRANSFER_ENQUEUE_INPUT.safeParse(payload)
    if (!parsed.success) return fail(E_BAD_ARGS)
    const { serial, direction, src, dstDir } = parsed.data

    // serial 必须是已建立的会话（与 fs:list 同一条原则：主进程只信自己的会话表）
    if (deps.devices.get(serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)

    /*
     * 【审查 I3】必须包 try/catch。
     *
     * service.enqueue 会为真实场景抛错：本地文件不存在（statSync ENOENT）、
     * 是指向目录（E_NOT_A_DIRECTORY）、路径非法（E_INVALID_PATH）。
     * 修前这里直接 throw，穿过 ipcMain.handle 被 Electron 包成
     * "Error invoking remote method"，渲染层 store 只处理 result.ok === false，
     * 于是 await 直接抛、**界面没有任何提示**，只留下一个未捕获 Promise。
     *
     * 现在与 fs:list 一致：收敛成 { ok:false, error:<码> }。
     */
    try {
      const target = await deps.transfer.enqueue({ serial, direction, src, dstDir })
      return { ok: true, data: target }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.TRANSFER_CANCEL, (_event, payload): IpcResult<TransferTask> => {
    const parsed = TRANSFER_ID_INPUT.safeParse(payload)
    if (!parsed.success) return fail(E_BAD_ARGS)
    try {
      if (!deps.transfer.cancel(parsed.data.id)) return fail(E_NOT_FOUND)
    } catch (err) {
      return fail(toErrorCode(err))
    }
    const task = deps.transfer.get(parsed.data.id)
    if (task === undefined) return fail(E_NOT_FOUND)
    return { ok: true, data: task }
  })

  handle(CH.TRANSFER_RETRY, (_event, payload): IpcResult<TransferTask> => {
    const parsed = TRANSFER_ID_INPUT.safeParse(payload)
    if (!parsed.success) return fail(E_BAD_ARGS)
    if (!deps.transfer.retry(parsed.data.id)) return fail(E_BAD_ARGS)
    const task = deps.transfer.get(parsed.data.id)
    if (task === undefined) return fail(E_NOT_FOUND)
    return { ok: true, data: task }
  })

  handle(CH.TRANSFER_PICK_FILES, async (): Promise<IpcResult<string[]>> => {
    try {
      // 用户取消选择时返回空数组 —— 取消是正常操作，不是错误
      return { ok: true, data: await deps.pickFiles() }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /**
   * 拖出（简报 C）：设备文件 → 资源管理器。
   *
   * 与其它通道同一条前置链：zod → 会话检查 → adb 就绪。
   * 注意这里**没有**任何 dstDir：落点由主进程定在临时目录，
   * 渲染层不能指定本地写入位置（否则一个被注入的路径就能往任意位置落文件）。
   *
   * 返回 { ok: true } 只在**startDrag 已经发出**之后成立；
   * 下载期间界面靠 transfer:drag-out-progress 显示「正在准备拖拽（N/M）」。
   */
  handle(CH.TRANSFER_BEGIN_DRAG_OUT, async (_event, payload): Promise<IpcResult<void>> => {
    const parsed = DRAG_OUT_INPUT.safeParse(payload)
    if (!parsed.success) return fail(E_BAD_ARGS)
    const { serial, paths } = parsed.data
    if (deps.devices.get(serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)
    try {
      const result = await deps.drag.dragOut({ serial, paths })
      if (!result.ok) return fail(result.code)
      return { ok: true, data: undefined }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.TRANSFER_LIST, (): IpcResult<TransferSnapshot> => {
    return { ok: true, data: deps.transfer.snapshot() }
  })

  handle(CH.TRANSFER_CLEAR, (_event, payload): IpcResult<TransferSnapshot> => {
    // 与其它通道一样「一律 zod 校验」，即使这个通道没有有意义的载荷
    const parsed = TRANSFER_CLEAR_INPUT.safeParse(payload)
    if (!parsed.success) return fail(E_BAD_ARGS)
    deps.transfer.clearFinished()
    return { ok: true, data: deps.transfer.snapshot() }
  })

  /* ============ 批量操作（任务 10） ============ */

  /*
   * 批量通道的公共前置：zod + 会话检查（R6）。
   *
   * 「每个 serial 都必须是主进程已知的会话」这条要在 handler 层判，
   * 而不是让 service 去猜：渲染层从未连接过的 serial 意味着它在问一个不存在的设备，
   * 整批 E_BAD_ARGS 比「N 台里有一台莫名失败」更能表达问题所在。
   *
   * 为什么允许列表中既有在线也有离线设备：离线设备由 service 按 R5 逐台跳过，
   * 那是**用户能看见并理解**的结果（「设备已断开」）；整批拒绝反而让在线的那些白勾了。
   */
  const batchPreflight = <T extends { serials: string[] }>(
    payload: unknown,
    schema: { safeParse: (value: unknown) => ParseResult<T> },
  ): { ok: true; data: T } | { ok: false; error: string } => {
    const parsed = preflight<T>(payload, schema)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    for (const serial of parsed.data.serials) {
      if (deps.devices.get(serial) === undefined) return { ok: false, error: E_BAD_ARGS }
    }
    if (deps.adbPath() === '') return { ok: false, error: E_ADB_NOT_FOUND }
    return { ok: true, data: parsed.data }
  }

  handle(CH.BATCH_SCREENSHOT, async (_event, payload): Promise<IpcResult<BatchRunData>> => {
    const parsed = batchPreflight<{ serials: string[]; dstDir: string }>(payload, BATCH_SCREENSHOT_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return {
        ok: true,
        data: await deps.batch.screenshot({ serials: parsed.data.serials }, parsed.data.dstDir),
      }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.BATCH_INSTALL, async (_event, payload): Promise<IpcResult<BatchRunData>> => {
    const parsed = batchPreflight<{ serials: string[]; apkPath: string }>(payload, BATCH_INSTALL_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return { ok: true, data: await deps.batch.install({ serials: parsed.data.serials }, parsed.data.apkPath) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.BATCH_PUSH, async (_event, payload): Promise<IpcResult<BatchRunData>> => {
    const parsed = batchPreflight<{ serials: string[]; files: string[]; dstDir: string }>(payload, BATCH_PUSH_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return {
        ok: true,
        data: await deps.batch.push({
          serials: parsed.data.serials,
          files: parsed.data.files,
          dstDir: parsed.data.dstDir,
        }),
      }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.BATCH_SHELL, async (_event, payload): Promise<IpcResult<BatchRunData>> => {
    const parsed = batchPreflight<{ serials: string[]; command: string }>(payload, BATCH_SHELL_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return { ok: true, data: await deps.batch.shell({ serials: parsed.data.serials }, parsed.data.command) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /*
   * 两个选择框。
   *
   * 取消返回**空串**（不是错误）—— 与 transfer:pick-files 的「取消 = 空数组」、
   * local:pick-root 的「取消 = 空串」保持同一约定。把取消当错误会让界面弹一条
   * 「请求参数不合法」，而用户只是按了 Esc。
   *
   * 这里不校验也有 no-device 的前置：选目录与选 apk 与设备无关，
   * 用户可以先选好文件再插设备。
   */
  handle(CH.BATCH_PICK_DIRECTORY, async (): Promise<IpcResult<string>> => {
    try {
      return { ok: true, data: await deps.batch.pickScreenshotDir() }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.BATCH_PICK_APK, async (): Promise<IpcResult<string>> => {
    try {
      return { ok: true, data: await deps.batch.pickApk() }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /*
   * P1 第一批：单机截图 / 录屏。
   *
   * 与批量动作的区别：这里只有**一台**设备，所以没有 runBatch 的结果矩阵，
   * 失败直接是一个错误码（成功与否是一件事，不是 N 件事）。
   *
   * serial 必须是主进程掌握的会话（与 fs:list 同一条原则）；
   * 三个通道都不接受渲染层给的其它路径参数 —— 设备上的临时落点由 service 决定，
   * 本地落点由设置或用户显式传入的 dstDir 决定。
   */
  const capturePreflight = <T extends { serial: string }>(
    payload: unknown,
    schema: { safeParse: (value: unknown) => ParseResult<T> },
  ): { ok: true; data: T } | { ok: false; error: string } => {
    const parsed = preflight<T>(payload, schema)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    if (deps.devices.get(parsed.data.serial) === undefined) return { ok: false, error: E_NO_SERIAL }
    if (deps.adbPath() === '') return { ok: false, error: E_ADB_NOT_FOUND }
    return { ok: true, data: parsed.data }
  }

  handle(CH.CAPTURE_SCREENSHOT, async (_event, payload): Promise<IpcResult<CaptureResult>> => {
    const parsed = capturePreflight<{ serial: string; dstDir: string }>(payload, CAPTURE_SCREENSHOT_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return { ok: true, data: await deps.capture.screenshot(parsed.data.serial, parsed.data.dstDir) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.CAPTURE_RECORD_START, async (_event, payload): Promise<IpcResult<RecordStarted>> => {
    const parsed = capturePreflight<{ serial: string; dstDir: string }>(payload, CAPTURE_RECORD_START_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return { ok: true, data: await deps.capture.startRecord(parsed.data.serial, parsed.data.dstDir) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.CAPTURE_RECORD_STOP, async (_event, payload): Promise<IpcResult<CaptureResult>> => {
    const parsed = capturePreflight<{ serial: string }>(payload, CAPTURE_RECORD_STOP_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return { ok: true, data: await deps.capture.stopRecord(parsed.data.serial) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /* ============ 应用管理（P1 第二批） ============ */

  /*
   * 与截图/录屏同一套前置：zod + 会话检查 + adb 已定位。
   * 差别只在「载荷里多一个 packageName」—— 它的合法性由 service 的
   * isSafePackageName 判（那是拼进 shell 命令之前的安全闸门，不是入参形状问题）。
   */
  const appsPreflight = <T extends { serial: string }>(
    payload: unknown,
    schema: { safeParse: (value: unknown) => ParseResult<T> },
  ): { ok: true; data: T } | { ok: false; error: string } => {
    const parsed = preflight<T>(payload, schema)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    if (deps.devices.get(parsed.data.serial) === undefined) return { ok: false, error: E_NO_SERIAL }
    if (deps.adbPath() === '') return { ok: false, error: E_ADB_NOT_FOUND }
    return { ok: true, data: parsed.data }
  }

  /*
   * 自绘顶栏的窗口控制。
   *
   * 命令无载荷、无有意义的返回值，但仍走 IpcResult：
   * 渲染层统一按 ok/error 处理，不必为它们写第二套错误通道。
   */
  handle(CH.WINDOW_MINIMIZE, (event): IpcResult<void> => {
    deps.windowOf(event).minimize()
    return { ok: true, data: undefined }
  })

  handle(CH.WINDOW_TOGGLE_MAXIMIZE, (event): IpcResult<boolean> => {
    return { ok: true, data: deps.windowOf(event).toggleMaximize() }
  })

  /*
   * 关闭 = 退出应用。
   *
   * 这里不直接 app.quit()：退出必须走 before-quit 那套清理（杀子进程、关闸门），
   * 而 close 窗口 → window-all-closed → quit 是唯一入口。
   * 多一条 quit 路径就多一处「清理没跑」的可能。
   */
  handle(CH.WINDOW_CLOSE, (event): IpcResult<void> => {
    deps.closeWindowOf(event)
    return { ok: true, data: undefined }
  })

  /*
   * 重置投屏窗口尺寸。
   *
   * 载荷只有 serial，且必须过 zod —— 与其它通道同一条铁律：
   * 渲染层送进来的东西一律当作不可信输入。
   */
  handle(CH.MIRROR_RESET_SIZE, (event, payload): IpcResult<void> => {
    const parsed = preflight<{ serial: string }>(payload, MIRROR_STOP_INPUT)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    deps.resetMirrorSize(event, parsed.data.serial)
    return { ok: true, data: undefined }
  })

  handle(CH.WINDOW_IS_MAXIMIZED, (event): IpcResult<boolean> => {
    return { ok: true, data: deps.windowOf(event).isMaximized() }
  })

  handle(CH.WINDOW_OPEN_SETTINGS, (): IpcResult<void> => {
    deps.openSettings()
    return { ok: true, data: undefined }
  })

  handle(CH.APPS_LIST, async (_event, payload): Promise<IpcResult<AppEntry[]>> => {
    const parsed = appsPreflight<{ serial: string }>(payload, APPS_LIST_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return { ok: true, data: await deps.apps.listApps(parsed.data.serial) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.APPS_DETAIL, async (_event, payload): Promise<IpcResult<AppDetail>> => {
    const parsed = appsPreflight<{ serial: string; packageName: string }>(payload, APPS_DETAIL_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return { ok: true, data: await deps.apps.appDetail(parsed.data.serial, parsed.data.packageName) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.APPS_PULL_APK, async (_event, payload): Promise<IpcResult<{ packageName: string; files: string[] }>> => {
    const parsed = appsPreflight<{ serial: string; packageName: string; dstDir: string }>(payload, APPS_PULL_APK_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return {
        ok: true,
        data: await deps.apps.pullApk(parsed.data.serial, parsed.data.packageName, parsed.data.dstDir),
      }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.APPS_INSTALL, async (_event, payload): Promise<IpcResult<void>> => {
    const parsed = appsPreflight<{ serial: string; apkPath: string }>(payload, APPS_INSTALL_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      /*
       * 进度直接经 deps.emitInstallProgress 推给窗口。
       *
       * 为什么在 IPC 层转手而不是让 service 自己 send：
       * service 不 import electron（它要能在纯 node 下被测试），
       * 而「推给哪个窗口」是渲染层拓扑问题，本来就该在接线层解决。
       */
      await deps.apps.installApk(parsed.data.serial, parsed.data.apkPath, (progress) => {
        deps.emitInstallProgress(progress)
      })
      return { ok: true, data: undefined }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /*
   * 四个「对某个包做动作」的通道共用同一个形状与同一段错误处理。
   * 拆成四个独立的 handle 调用（而不是一个循环）：注册表自检要能按通道名
   * 精确指出漏了哪一个，循环里的失败信息只有下标。
   */
  const appAction = (
    channel: string,
    invoke: (serial: string, packageName: string) => Promise<void>,
  ): void => {
    handle(channel, async (_event, payload): Promise<IpcResult<void>> => {
      const parsed = appsPreflight<{ serial: string; packageName: string }>(payload, APPS_PACKAGE_INPUT)
      if (!parsed.ok) return fail(parsed.error)
      try {
        await invoke(parsed.data.serial, parsed.data.packageName)
        return { ok: true, data: undefined }
      } catch (err) {
        return fail(toErrorCode(err))
      }
    })
  }

  appAction(CH.APPS_FORCE_STOP, (serial, pkg) => deps.apps.forceStop(serial, pkg))
  appAction(CH.APPS_CLEAR_DATA, (serial, pkg) => deps.apps.clearData(serial, pkg))
  appAction(CH.APPS_UNINSTALL, (serial, pkg) => deps.apps.uninstall(serial, pkg))
  appAction(CH.APPS_LAUNCH, (serial, pkg) => deps.apps.launch(serial, pkg))

  handle(CH.APPS_PICK_APK, async (): Promise<IpcResult<string>> => {
    try {
      return { ok: true, data: await deps.pickApk() }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /* ============ 设备按键 + scrcpy 投屏（P1 第三批） ============ */

  /*
   * 按键：zod 已经把 key 收成六个枚举，所以这里不需要再判「命令是否安全」——
   * 非法值在 preflight 阶段就已经是 E_BAD_ARGS，根本到不了 service。
   */
  handle(CH.DEVICE_KEYEVENT, async (_event, payload): Promise<IpcResult<void>> => {
    const parsed = capturePreflight<{ serial: string; key: DeviceKey }>(payload, DEVICE_KEYEVENT_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      await deps.keys.press(parsed.data.serial, parsed.data.key)
      return { ok: true, data: undefined }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.MIRROR_START, async (_event, payload): Promise<IpcResult<MirrorSession>> => {
    const parsed = capturePreflight<{ serial: string }>(payload, MIRROR_START_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return { ok: true, data: await deps.mirror.start(parsed.data.serial) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /*
   * stop 刻意**不做**设备会话检查：设备刚被拔掉时，窗口可能还开着，
   * 用户点关闭必须能关掉它。用 capturePreflight 会因为 E_NO_SERIAL 直接拒绝，
   * 那个窗口就再也关不掉了。这里只做 zod 形状校验。
   */
  handle(CH.MIRROR_STOP, async (_event, payload): Promise<IpcResult<void>> => {
    const parsed = preflight<{ serial: string }>(payload, MIRROR_STOP_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      await deps.mirror.stop(parsed.data.serial)
      return { ok: true, data: undefined }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /*
   * mirror:list 刻意**不做**会话检查：它返回的是「当前有哪些投屏」，
   * 设备刚掉线时用户更需要看到「那个窗口还在」而不是一个错误码。
   */
  handle(CH.MIRROR_LIST, async (): Promise<IpcResult<MirrorSession[]>> => {
    try {
      return { ok: true, data: deps.mirror.list() }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  // 自检：注册表必须覆盖全部 invoke 通道，漏一个就是渲染层点了没反应
  for (const channel of INVOKE_CHANNELS) {
    if (!registered.has(channel)) throw new Error('missing handler: ' + channel)
  }
}
