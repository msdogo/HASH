import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CH } from './ipc/channels'
import type {
  BatchInstallInput,
  BatchPushInput,
  BatchScreenshotInput,
  BatchShellInput,
  DshApi,
  DragOutInput,
  FsBatchInput,
  FsListInput,
  FsMkdirInput,
  FsRemoveFactsInput,
  FsRenameInput,
  LocalListInput,
  SettingsGetDeviceCwdInput,
  SettingsSetDeviceCwdInput,
  SettingsSetDownloadDirInput,
  TransferEnqueueInput,
  TransferIdInput,
} from '../src/shared/api-contract'
import type { BatchRunData } from '../src/shared/batch'
import type { DragOutFailure, DragOutProgress } from '../src/shared/drag'
import type { DevicesChangedBatch, DevicesListData, FsListData, IpcResult } from '../src/shared/types'
import type { FsOpData, FsRemoveFactsData, LocalListData } from '../src/shared/file-ops'
import type { SettingsData } from '../src/shared/settings'
import type { TransferSnapshot, TransferTask } from '../src/shared/transfer'

/**
 * 唯一 API 面（裁决 2 / I3）。
 *
 * ===== 为什么是「返回类型标注 + 字面量 satisfies」双保险，而不是只留其中一层 =====
 *
 * （任务 7 裁决 8 更正：本行原文写的是「用一个带显式返回类型标注的函数，而不是对象 + satisfies」，
 *   与第 4 轮已落地的「标注 + satisfies 双保险」自相矛盾 —— 现在两层都在，缺一不可。）
 * 审查轮 3 发现：`satisfies DshApi` 这个语法可以被**替换掉**——把它换成 `const api: DshApi = {...}`
 * 是一个很自然的重构，而那样「多实现一个方法」就不再报错（对象字面量的多余属性检查只对
 * 直接标注的上下文生效，而这里经过了一次赋值）。更糟的是：原来那两条「钉住 satisfies」的
 * 测试是**用正则匹配源码文本**的，源码注释里出现 `satisfies DshApi` 字样就能满足它们 ——
 * 删掉真的 satisfies、留下注释，测试照样全绿。那和上一轮修掉的假护栏是同一类问题。
 *
 * 现在两层一起用（返回类型标注 + 字面量 satisfies）：
 *   - **多实现**：函数体返回对象字面量，返回类型写死 `DshApi`，多余属性是编译错误；
 *   - **少实现**：必填成员缺失是编译错误；
 *   - 两种方向都**不依赖任何可被注释满足的文本**，也不需要正则测试。
 *
 * 已知限制（如实记录）：方法参数的二变性使得「把形参改成更宽的对象类型」不会报错。
 * 彻底解决要用函数重载或精确类型，成本远超收益，故接受。
 */

/** preload 依赖的 Electron 面（注入以便脱离 Electron 单测）。 */
export interface PreloadDeps {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  /** 事件监听器：Electron 传的第一个参数是 IpcRendererEvent，其余是通道载荷。 */
  on: (channel: string, listener: (event: unknown, payload: unknown) => void) => void
  off: (channel: string, listener: (event: unknown, payload: unknown) => void) => void
  /**
   * File → 本地磁盘绝对路径（生产是 electron 的 webUtils.getPathForFile）。
   *
   * 注入而不是在 buildApi 里直接调 webUtils：
   *   - 测试能给出确定的返回值（与 invoke/on/off 同一手法）；
   *   - 「空串表示不是磁盘文件」这条判定才有唯一的可测入口。
   */
  getPathForFile: (file: unknown) => string
}

/**
 * 造出 API 面。返回类型标注 + 字面量上的 satisfies 双保险，编译期强制，不靠测试。
 *
 * 为什么要【同时】写返回类型标注和 satisfies（审查轮 4 / A′）：
 *   多余属性检查只对「直接 return 的对象字面量」生效。若将来有人做一次极常见的重构
 *   ——把字面量先赋给中间变量再 return——仅靠返回类型标注就会**静默失守**：
 *   中间变量的推断类型保留那个多余属性，而它仍可赋值给 DshApi（多余属性不是错误），
 *   于是 tsc exit 0、never 断言也照样通过（因为 ReturnType 恒等于标注）。
 *   加上 satisfies 后，检查点落在**字面量本身**，提取中间变量也逃不掉。
 */
export function buildApi(deps: PreloadDeps): DshApi {
  return {
    app: {
      /** 之前的 ping 保留，作为「桥是否活着」的探针。 */
      ping: (): string => 'pong',
    },
    devices: {
      /** 取设备表 + adb 自检状态。 */
      list: (): Promise<IpcResult<DevicesListData>> =>
        deps.invoke(CH.DEVICES_LIST) as Promise<IpcResult<DevicesListData>>,
      /** 订阅设备变更推送；返回退订函数（组件卸载时必须调用）。 */
      onChanged: (callback: (batch: DevicesChangedBatch) => void): (() => void) => {
        // 载荷在 PreloadDeps 里是 unknown（传输通道的载荷类型不同，接口只能取交集），
        // 这里在通道边界上收窄成设备批次 —— 通道与载荷是一一对应的，越界不会发生。
        const listener = (_event: unknown, payload: unknown): void => {
          callback(payload as DevicesChangedBatch)
        }
        deps.on(CH.DEVICES_CHANGED, listener)
        return () => { deps.off(CH.DEVICES_CHANGED, listener) }
      },
    },
    fs: {
      /** 列举远程目录（裁决 7：真实实现，带 degraded/exitCode）。 */
      list: (payload: FsListInput): Promise<IpcResult<FsListData>> =>
        deps.invoke(CH.FS_LIST, payload) as Promise<IpcResult<FsListData>>,
      /* ---- 任务 9：写操作。全部逐项返回（shared/file-ops 的 FsOpData） ---- */
      mkdir: (payload: FsMkdirInput): Promise<IpcResult<FsOpData>> =>
        deps.invoke(CH.FS_MKDIR, payload) as Promise<IpcResult<FsOpData>>,
      rename: (payload: FsRenameInput): Promise<IpcResult<FsOpData>> =>
        deps.invoke(CH.FS_RENAME, payload) as Promise<IpcResult<FsOpData>>,
      removeFacts: (payload: FsRemoveFactsInput): Promise<IpcResult<FsRemoveFactsData>> =>
        deps.invoke(CH.FS_REMOVE_FACTS, payload) as Promise<IpcResult<FsRemoveFactsData>>,
      remove: (payload: FsRemoveFactsInput): Promise<IpcResult<FsOpData>> =>
        deps.invoke(CH.FS_REMOVE, payload) as Promise<IpcResult<FsOpData>>,
      copy: (payload: FsBatchInput): Promise<IpcResult<FsOpData>> =>
        deps.invoke(CH.FS_COPY, payload) as Promise<IpcResult<FsOpData>>,
      move: (payload: FsBatchInput): Promise<IpcResult<FsOpData>> =>
        deps.invoke(CH.FS_MOVE, payload) as Promise<IpcResult<FsOpData>>,
    },
    local: {
      /** 列举本地目录（任意合法绝对路径；R2-1 之后没有根目录限制）。 */
      list: (payload: LocalListInput): Promise<IpcResult<LocalListData>> =>
        deps.invoke(CH.LOCAL_LIST, payload) as Promise<IpcResult<LocalListData>>,
      /**
       * 挑选本地栏的起始浏览目录（不是访问边界）；取消返回空串。
       *
       * 【问题 1 修复】必须显式传一个载荷（这里用 null）。
       * 修前写的是 deps.invoke(CH.LOCAL_PICK_ROOT)，ipcRenderer.invoke 不带第二参时
       * 主进程收到的 payload 是 undefined，被 preflight 判成 E_BAD_ARGS ——
       * 「更换目录」按钮点了就报「请求参数不合法」。
       * 显式传 null 是防御性的第二层：即使将来 preflight 又收紧，这个通道也不会再踩空。
       */
      pickRoot: (): Promise<IpcResult<string>> =>
        deps.invoke(CH.LOCAL_PICK_ROOT, null) as Promise<IpcResult<string>>,
    },
    settings: {
      /** 取设置快照（默认下载路径 + 本机默认目录 + adb 只读状态）。 */
      get: (): Promise<IpcResult<SettingsData>> =>
        deps.invoke(CH.SETTINGS_GET, null) as Promise<IpcResult<SettingsData>>,
      /** 写默认下载路径（非法值返回错误码，不静默回退）。 */
      setDownloadDir: (payload: SettingsSetDownloadDirInput): Promise<IpcResult<SettingsData>> =>
        deps.invoke(CH.SETTINGS_SET_DOWNLOAD_DIR, payload) as Promise<IpcResult<SettingsData>>,
      /**
       * 挑一个目录作为默认下载路径；取消返回空串。
       *
       * 显式传 null 与 pickRoot 同理：不带载荷时主进程收到 undefined，
       * 会被 preflight 判成 E_BAD_ARGS（任务 9 真机踩过一次，这里不再重犯）。
       */
      pickDownloadDir: (): Promise<IpcResult<string>> =>
        deps.invoke(CH.SETTINGS_PICK_DOWNLOAD_DIR, null) as Promise<IpcResult<string>>,
      /** 恢复默认下载路径。 */
      resetDownloadDir: (): Promise<IpcResult<SettingsData>> =>
        deps.invoke(CH.SETTINGS_RESET_DOWNLOAD_DIR, null) as Promise<IpcResult<SettingsData>>,
      /* ---- R9：按设备记住上次停留的目录 ---- */
      /** 读该设备上次停留的目录；空串 = 没有记录（不是错误）。 */
      getDeviceCwd: (payload: SettingsGetDeviceCwdInput): Promise<IpcResult<string>> =>
        deps.invoke(CH.SETTINGS_GET_DEVICE_CWD, payload) as Promise<IpcResult<string>>,
      /**
       * 记住该设备停留的目录。
       *
       * 渲染层是 fire-and-forget 地调它（不 await）。契约里保留 Promise，
       * 是因为 IPC 本来就异步；「不 await」的决定在调用点（src/shared/cwd-memo.ts
       * 的 remember 返回 void），不是靠这里把返回值抹掉来暗示。
       */
      setDeviceCwd: (payload: SettingsSetDeviceCwdInput): Promise<IpcResult<void>> =>
        deps.invoke(CH.SETTINGS_SET_DEVICE_CWD, payload) as Promise<IpcResult<void>>,
    },
    transfer: {
      /** 加入传输队列。 */
      enqueue: (payload: TransferEnqueueInput): Promise<IpcResult<TransferTask>> =>
        deps.invoke(CH.TRANSFER_ENQUEUE, payload) as Promise<IpcResult<TransferTask>>,
      /** 取消（在跑的会被主进程真杀进程树，不只是让 Promise settle）。 */
      cancel: (payload: TransferIdInput): Promise<IpcResult<TransferTask>> =>
        deps.invoke(CH.TRANSFER_CANCEL, payload) as Promise<IpcResult<TransferTask>>,
      /** 重试失败/被取消的传输。 */
      retry: (payload: TransferIdInput): Promise<IpcResult<TransferTask>> =>
        deps.invoke(CH.TRANSFER_RETRY, payload) as Promise<IpcResult<TransferTask>>,
      /** 取队列快照（首屏与重连自愈入口）。 */
      list: (): Promise<IpcResult<TransferSnapshot>> =>
        deps.invoke(CH.TRANSFER_LIST) as Promise<IpcResult<TransferSnapshot>>,
      /** 清掉已完成的传输。 */
      clear: (): Promise<IpcResult<TransferSnapshot>> =>
        deps.invoke(CH.TRANSFER_CLEAR) as Promise<IpcResult<TransferSnapshot>>,
      /** 打开系统文件选择框（渲染层拿不到本地绝对路径，必须走主进程）。 */
      pickFiles: (): Promise<IpcResult<string[]>> =>
        deps.invoke(CH.TRANSFER_PICK_FILES) as Promise<IpcResult<string[]>>,
      /* ---- 简报 C：双向拖拽 ---- */
      /**
       * File → 本地路径（**同步，不走 IPC**）。
       *
       * 不经过 IPC 是技术要求：File 对象穿不过结构化克隆，到了主进程已经
       * 无法再映射回磁盘文件。空串 = 不是磁盘文件（例如网页拖来的）。
       */
      getPathForFile: (file: unknown): string => deps.getPathForFile(file),
      /** 拖出：设备文件 → 资源管理器（主进程下载到临时目录后才 startDrag）。 */
      beginDragOut: (payload: DragOutInput): Promise<IpcResult<void>> =>
        deps.invoke(CH.TRANSFER_BEGIN_DRAG_OUT, payload) as Promise<IpcResult<void>>,
      /** 订阅「正在准备拖拽（N/M）」；返回退订函数。 */
      onDragOutProgress: (callback: (payload: DragOutProgress) => void): (() => void) => {
        const listener = (_event: unknown, payload: unknown): void => {
          callback(payload as DragOutProgress)
        }
        deps.on(CH.TRANSFER_DRAG_OUT_PROGRESS, listener)
        return () => { deps.off(CH.TRANSFER_DRAG_OUT_PROGRESS, listener) }
      },
      /** 订阅拖出失败（任一文件失败就整体不拖）；返回退订函数。 */
      onDragOutFailed: (callback: (payload: DragOutFailure) => void): (() => void) => {
        const listener = (_event: unknown, payload: unknown): void => {
          callback(payload as DragOutFailure)
        }
        deps.on(CH.TRANSFER_DRAG_OUT_FAILED, listener)
        return () => { deps.off(CH.TRANSFER_DRAG_OUT_FAILED, listener) }
      },
      /** 订阅传输推送；返回退订函数（组件卸载时必须调用）。 */
      onChanged: (callback: (snapshot: TransferSnapshot) => void): (() => void) => {
        const listener = (_event: unknown, payload: unknown): void => {
          callback(payload as TransferSnapshot)
        }
        deps.on(CH.TRANSFER_CHANGED, listener)
        return () => { deps.off(CH.TRANSFER_CHANGED, listener) }
      },
    },
    batch: {
      /** 批量截图：目录由主进程弹框选（渲染层拿不到本地绝对路径）。 */
      screenshot: (payload: BatchScreenshotInput): Promise<IpcResult<BatchRunData>> =>
        deps.invoke(CH.BATCH_SCREENSHOT, payload) as Promise<IpcResult<BatchRunData>>,
      /** 批量安装：apk 由主进程的选取框给出。 */
      install: (payload: BatchInstallInput): Promise<IpcResult<BatchRunData>> =>
        deps.invoke(CH.BATCH_INSTALL, payload) as Promise<IpcResult<BatchRunData>>,
      /** 批量推送：返回的是「已加入队列」，进度在底栏看。 */
      push: (payload: BatchPushInput): Promise<IpcResult<BatchRunData>> =>
        deps.invoke(CH.BATCH_PUSH, payload) as Promise<IpcResult<BatchRunData>>,
      /** 批量执行命令：输出已截断（8 KB）。 */
      shell: (payload: BatchShellInput): Promise<IpcResult<BatchRunData>> =>
        deps.invoke(CH.BATCH_SHELL, payload) as Promise<IpcResult<BatchRunData>>,
      /** 选目录；取消返回空串。 */
      pickDirectory: (): Promise<IpcResult<string>> =>
        deps.invoke(CH.BATCH_PICK_DIRECTORY) as Promise<IpcResult<string>>,
      /** 选 apk；取消返回空串。 */
      pickApk: (): Promise<IpcResult<string>> =>
        deps.invoke(CH.BATCH_PICK_APK) as Promise<IpcResult<string>>,
    },
  } satisfies DshApi
}

// 渲染层没有任何 node 能力，一切都要经过这里。
// 通道名只允许引用 CH 常量（裸字符串等于绕过白名单）。
const api = buildApi({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => { ipcRenderer.on(channel, listener) },
  off: (channel, listener) => { ipcRenderer.off(channel, listener) },
  // webUtils 是渲染进程侧的 API：File 在这里还能映射回磁盘文件，
  // 一旦穿过 IPC 就只剩一个普通对象了。所以这一步必须在 preload 里完成。
  getPathForFile: (file) => webUtils.getPathForFile(file as File),
})

contextBridge.exposeInMainWorld('api', api)
