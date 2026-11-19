import { z } from 'zod'
import type { DevicesChangedBatch, DevicesListData, FsListData, IpcResult } from './types'
import type { TransferSnapshot, TransferTask } from './transfer'
import type { FsOpData, FsRemoveFactsData, LocalListData } from './file-ops'

/**
 * IPC API 契约的【单一事实源】（审查轮 1 / I3、I4）。
 *
 * 修前的问题：同一份 API 形状有三处副本 ——
 *   1. electron/preload.ts 里自写的 `interface DevicesListPayload`
 *   2. src/shared/api.d.ts 里再写一份 `DevicesListPayload` / `FsListPayload`
 *   3. electron/ipc/handlers.ts 里手写的 zod schema
 * 三份靠人肉同步，守卫还是单向的（只从 preload 往 api.d.ts 比）。
 *
 * 修后：本文件是唯一事实源，包含
 *   - 入参的 zod schema（handlers 直接复用，不再各写一份）
 *   - 出参的类型（从 shared/types 派生，不重新定义）
 *   - API 面清单（preload 与 api.d.ts 都据此派生，测试做双向比对）
 *
 * 红线：本文件同时被渲染层与主进程编译。zod 是纯 JS 依赖（无 node 内置模块），
 * 渲染层可以安全 import。
 */

/* ============ 入参 schema（唯一副本） ============ */

/** fs:list 入参。 */
export const FS_LIST_INPUT = z.object({
  serial: z.string().min(1),
  dir: z.string().min(1),
})

/** fs:list 入参的类型（从 schema 派生，永远与校验一致）。 */
export type FsListInput = z.infer<typeof FS_LIST_INPUT>

/**
 * devices:list 入参。
 *
 * 它不接收任何有意义的载荷（handler 只用自己的会话表），但仍然写成 schema：
 * 一是「所有 IPC 入参一律 zod 校验」这条契约不能有例外，
 * 二是显式记录「这个通道会忽略载荷」——用 unknown() 而不是 z.undefined()，
 * 这样任何输入都能被安全解析、不会因为渲染层多传字段就报 E_BAD_ARGS。
 */
export const DEVICES_LIST_INPUT = z.unknown()

/**
 * transfer:enqueue 入参。
 *
 * 三条判据都要在 zod 层拦住（而不是到主进程里再判断）：
 * - serial 必填非空：没有设备就不知道该传给谁；
 * - direction 只认 push/pull：防止渲染层传出主进程无法解释的方向；
 * - src / dstDir 非空字符串：路径拼接在下游做，这里只保证「不是空/不是别的类型」。
 *
 * 注意这里**不校验路径是否绝对 / 是否含换行**：那是主进程的职责
 * （走 fs/remote 的 normalizeDir 与 shellsafe 的 shellQuote，错误码更精确）。
 */
export const TRANSFER_ENQUEUE_INPUT = z.object({
  serial: z.string().min(1),
  direction: z.enum(['push', 'pull']),
  src: z.string().min(1),
  dstDir: z.string().min(1),
})

export type TransferEnqueueInput = z.infer<typeof TRANSFER_ENQUEUE_INPUT>

/** transfer:cancel / transfer:retry 入参。 */
export const TRANSFER_ID_INPUT = z.object({
  id: z.string().min(1),
})

export type TransferIdInput = z.infer<typeof TRANSFER_ID_INPUT>

/** transfer:clear 入参（无意义载荷，统一走 unknown 保持「一律 zod 校验」的契约）。 */
export const TRANSFER_CLEAR_INPUT = z.unknown()

/* ============ 任务 9：文件操作（新建 / 重命名 / 删除 / 复制 / 移动） ============ */

/**
 * 所有远程写操作的公共外壳。
 *
 * 为什么单独抽 serial：每一条写命令都必须打到「用户正在看的那台设备」上，
 * 而 serial 在四条通道里的语义完全相同 —— 重复写四遍只会漂移。
 *
 * 注意**不在这里**校验路径是否绝对 / 是否含 '..'：那是主进程
 * shared/path-guard 的 assertSafeRemotePath 的职责（错误码更精确，
 * 且渲染层的列表数据本来就来自主进程，没必要在校验层再猜一次）。
 */
const serialBase = { serial: z.string().min(1) }

/** fs:mkdir 入参。 */
export const FS_MKDIR_INPUT = z.object({
  ...serialBase,
  dir: z.string().min(1),
  name: z.string().min(1),
})
export type FsMkdirInput = z.infer<typeof FS_MKDIR_INPUT>

/** fs:rename 入参。 */
export const FS_RENAME_INPUT = z.object({
  ...serialBase,
  from: z.string().min(1),
  name: z.string().min(1),
})
export type FsRenameInput = z.infer<typeof FS_RENAME_INPUT>

/**
 * 批量操作入参（删除 / 复制 / 移动共用）。
 *
 * sources 数组上限 500：一次删几千项既不是用户能确认的量（确认框只列前 3 个），
 * 也会把单次 IPC 变成一个长事务。超过就该分批/换用法。
 */
export const FS_BATCH_INPUT = z.object({
  ...serialBase,
  sources: z.array(z.string().min(1)).min(1).max(500),
  /** 目标目录（复制/移动必填；删除时为 undefined）。 */
  dstDir: z.string().min(1).optional(),
})
export type FsBatchInput = z.infer<typeof FS_BATCH_INPUT>

/**
 * 删除前的确认事实入参。
 *
 * 与 fs:remove 分开是**刻意的**：确认框必须先看到「N 项 / 前 3 个名字 / 是否有非空目录」
 * 才能问用户，而这份事实只能由主进程去 stat 出来。
 * 让渲染层自己拼就是「界面猜了一个数字，然后删掉的是另一批东西」。
 */
export const FS_REMOVE_FACTS_INPUT = z.object({
  ...serialBase,
  targets: z.array(z.string().min(1)).min(1).max(500),
})
export type FsRemoveFactsInput = z.infer<typeof FS_REMOVE_FACTS_INPUT>

/** local:list 入参（dir 可省略，省略即根目录）。 */
export const LOCAL_LIST_INPUT = z.object({
  dir: z.string().min(1).optional(),
})
export type LocalListInput = z.infer<typeof LOCAL_LIST_INPUT>

/** local:pick-root 入参（无意义载荷，统一走 unknown 保持「一律 zod 校验」）。 */
export const LOCAL_PICK_ROOT_INPUT = z.unknown()

/* ============ 出参类型（从 shared/types 派生，不重复定义） ============ */

export type { DevicesChangedBatch, DevicesListData, FsListData, IpcResult } from './types'
export type { TransferSnapshot, TransferTask } from './transfer'
export type { FsOpData, FsRemoveFactsData, LocalListData, LocalItem } from './file-ops'

/* ============ 唯一 API 接口（I3：编译期强制的唯一事实源） ============ */

/** 退订函数。 */
export type Unsubscribe = () => void

/**
 * window.api 的**唯一**接口定义（审查轮 2 / I3）。
 *
 * 为什么必须放在这里：原来的实现里 api.d.ts 自己写了一份 DshApi，
 * 与 preload 的实现之间【没有任何编译期约束】—— 往 d.ts 里注入一个 rename() 方法，
 * 测试照样全绿。那比不修更危险：后续任务会以为有护栏而大胆加 API。
 *
 * 现在两侧都绑到这一个接口，防护是三层（审查轮 4 更正：此前这里写的是"靠 satisfies 绑定"，
 * 那是轮 3 之前的机制，已经不准确了）：
 *   1. electron/preload.ts 的返回类型标注 `function buildApi(deps): DshApi`
 *      → 挡住「少实现」（缺必填成员）；
 *   2. 同一函数里 `return { ... } satisfies DshApi` → 检查点落在**字面量本身**，
 *      挡住「多实现」（多余属性），并且即使将来把字面量提取成中间变量也仍然生效；
 *   3. tests/api-contract-binding.test.ts 的 never 断言 → 把「标注 ≡ 契约」也钉住。
 *   - src/shared/api.d.ts：`interface Window { api: DshApi }` ← 声明与实现同源
 * 于是「改一侧不同步另一侧」是**编译错误**，不再依赖正则比对。
 *
 * 已知限制：方法参数的二变性意味着「形参改成更宽的结构兼容类型」不会报错，
 * 参数签名的精确一致性仍需人工核对。
 */
export interface DshApi {
  app: {
    /** 桥是否活着。 */
    ping(): string
  }
  devices: {
    /** 取设备表 + adb 自检状态（含首屏与迟到订阅者的自愈入口）。 */
    list(): Promise<IpcResult<DevicesListData>>
    /** 订阅设备变更推送；返回退订函数。批次必然携带 adb 状态（I8）。 */
    onChanged(callback: (batch: DevicesChangedBatch) => void): Unsubscribe
  }
  fs: {
    /** 列举远程目录；入参类型从 FsListInput（zod schema 派生）来。 */
    list(payload: FsListInput): Promise<IpcResult<FsListData>>
    /* ---- 任务 9：写操作（全部逐项返回，见 shared/file-ops） ---- */
    /** 新建目录。 */
    mkdir(payload: FsMkdirInput): Promise<IpcResult<FsOpData>>
    /** 重命名（同目录改名，不覆盖）。 */
    rename(payload: FsRenameInput): Promise<IpcResult<FsOpData>>
    /**
     * 取删除确认框要显示的事实（数量 / 前 3 个名字 / 是否有非空目录）。
     * 必须先调它拿到事实，再由界面问用户，最后才调 remove —— 顺序不能反。
     */
    removeFacts(payload: FsRemoveFactsInput): Promise<IpcResult<FsRemoveFactsData>>
    /**
     * 删除（不可逆）。逐项返回结果：一项失败不影响其余（裁决 4）。
     * 受保护的根路径会被主进程拒绝（E_PROTECTED_PATH）。
     */
    remove(payload: FsRemoveFactsInput): Promise<IpcResult<FsOpData>>
    /** 复制到目标目录（同设备内 cp，不走 USB / 不进队列）。 */
    copy(payload: FsBatchInput): Promise<IpcResult<FsOpData>>
    /** 移动到目标目录（同设备内 mv，原子语义，目标已存在则拒绝）。 */
    move(payload: FsBatchInput): Promise<IpcResult<FsOpData>>
  }
  local: {
    /** 列举本地目录（限制在用户选定的根目录内，越界返回 E_OUTSIDE_ROOT）。 */
    list(payload: LocalListInput): Promise<IpcResult<LocalListData>>
    /** 让用户挑选本地根目录；取消返回空串（不是错误）。 */
    pickRoot(): Promise<IpcResult<string>>
  }
  transfer: {
    /** 加入传输队列（上传或下载）。 */
    enqueue(payload: TransferEnqueueInput): Promise<IpcResult<TransferTask>>
    /** 取消一个传输（在跑的会被真杀进程树）。 */
    cancel(payload: TransferIdInput): Promise<IpcResult<TransferTask>>
    /** 重试一个失败/被取消的传输。 */
    retry(payload: TransferIdInput): Promise<IpcResult<TransferTask>>
    /** 取当前队列快照。 */
    list(): Promise<IpcResult<TransferSnapshot>>
    /** 清掉已完成的传输（失败/取消的保留以便重试）。 */
    clear(): Promise<IpcResult<TransferSnapshot>>
    /**
     * 打开系统文件选择框，返回选中的本地文件绝对路径。
     *
     * 为什么必须走主进程：渲染层没有 node 能力、也没有 dialog，
     * 而 <input type=file> 在 Electron 里拿不到真实绝对路径（只有 File 对象）。
     * 取消选择返回空数组（不是错误）。
     */
    pickFiles(): Promise<IpcResult<string[]>>
    /** 订阅传输变化推送（进度已在主进程节流）；返回退订函数。 */
    onChanged(callback: (snapshot: TransferSnapshot) => void): Unsubscribe
  }
}

/* ============ API 面清单（运行期反射用；类型层的等价性由 DshApi 保证） ============ */

/**
 * 每个命名空间下的方法名。
 *
 * 注意：这里只是给「运行期静态检查 / 文档」用的便利清单，
 * **真正的守卫是 DshApi 接口 + satisfies**（tests/api-contract-binding.test.ts 会断言这一点）。
 * 若两者不一致，tests 里对 DshApi 键集合的类型断言会编译失败。
 */
export const API_SURFACE = {
  app: ['ping'],
  devices: ['list', 'onChanged'],
  fs: ['list', 'mkdir', 'rename', 'removeFacts', 'remove', 'copy', 'move'],
  local: ['list', 'pickRoot'],
  transfer: ['enqueue', 'cancel', 'retry', 'list', 'clear', 'pickFiles', 'onChanged'],
} as const

export type ApiSurface = typeof API_SURFACE

/** 拍平后的方法名列表（'app.ping', 'devices.list', ...）。 */
export function apiMethodNames(): string[] {
  const out: string[] = []
  for (const [group, methods] of Object.entries(API_SURFACE)) {
    for (const method of methods) out.push(group + '.' + method)
  }
  return out
}

/** 命名空间名列表。 */
export function apiGroupNames(): string[] {
  return Object.keys(API_SURFACE)
}