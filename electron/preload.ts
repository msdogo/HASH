import { contextBridge, ipcRenderer } from 'electron'
import { CH } from './ipc/channels'
import type {
  BatchInstallInput,
  BatchPushInput,
  BatchScreenshotInput,
  BatchShellInput,
  DshApi,
  FsBatchInput,
  FsListInput,
  FsMkdirInput,
  FsRemoveFactsInput,
  FsRenameInput,
  LocalListInput,
  TransferEnqueueInput,
  TransferIdInput,
} from '../src/shared/api-contract'
import type { BatchRunData } from '../src/shared/batch'
import type { DevicesChangedBatch, DevicesListData, FsListData, IpcResult } from '../src/shared/types'
import type { FsOpData, FsRemoveFactsData, LocalListData } from '../src/shared/file-ops'
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
      /** 列举本地目录（限制在用户选定的根目录内）。 */
      list: (payload: LocalListInput): Promise<IpcResult<LocalListData>> =>
        deps.invoke(CH.LOCAL_LIST, payload) as Promise<IpcResult<LocalListData>>,
      /** 挑选本地根目录；取消返回空串。 */
      pickRoot: (): Promise<IpcResult<string>> =>
        deps.invoke(CH.LOCAL_PICK_ROOT) as Promise<IpcResult<string>>,
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
})

contextBridge.exposeInMainWorld('api', api)