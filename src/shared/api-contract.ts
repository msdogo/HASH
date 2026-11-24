import { z } from 'zod'
import type { DevicesChangedBatch, DevicesListData, FsListData, IpcResult } from './types'
import type { TransferSnapshot, TransferTask } from './transfer'
import type { FsOpData, FsRemoveFactsData, LocalFileStat, LocalListData } from './file-ops'
import type { BatchRunData } from './batch'
import type { DragOutFailure, DragOutProgress } from './drag'
import type { SettingsData } from './settings'
import type { CaptureResult, RecordStarted } from './capture'

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

/**
 * transfer:begin-drag-out 入参（简报 C：把设备文件拖给资源管理器）。
 *
 * 为什么**没有** dstDir：拖拽的落点由用户在资源管理器里松手的位置决定，
 * 而那要等 startDrag 之后才知道 —— 我们只能先把文件准备到主进程自己的临时目录
 * （app.getPath('temp')/adbfm-drag）。让渲染层指定 dstDir 等于给它一个
 * 任意本地写入入口，绕开本地根目录闸门，所以这里刻意不接受。
 *
 * paths 上限 100 与 fs 批量操作同量级：拖 100 个文件时用户已经分不清自己在拖什么。
 */
export const DRAG_OUT_INPUT = z.object({
  serial: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1).max(100),
})

export type DragOutInput = z.infer<typeof DRAG_OUT_INPUT>

/**
 * 「File 对象 → 本地路径」的入参形状（**不经过 IPC**，仅用于类型自证）。
 *
 * 为什么不给它一个通道：File 对象无法穿过 IPC —— 结构化克隆过去之后
 * 它已经不是一个可解析的磁盘绑定，webUtils.getPathForFile 只能看到空串。
 * 而 webUtils 是【渲染进程】的 API（Electron 只允许从 preload 里 import），
 * 所以这一步在 preload 里同步完成，见 DshApi.transfer.getPathForFile。
 * 保留这个 schema 是为了让「空串=不是磁盘文件」这条判定有单一事实源。
 */
export const DRAG_PATH_INPUT = z.object({ file: z.unknown() })

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

/**
 * local:file-stat 入参（R10：双击下载前的同名文件预检）。
 *
 * 两个字段都 min(1)，且**名字必须是单个路径段**：
 * 名字来自远端 ls，含分隔符时若在这里放行，下游 path.join 就会写到别处去。
 * 这里只做「非空 + 单段」的语法拦截，真正的收敛在主进程的 checkName（与所有
 * 写路径共用同一份名字规则，见 src/shared/path-guard.ts）。
 *
 * 为什么 dir 也 min(1)：空串在这条通道上没有「用默认下载目录」的语义 ——
 * 下载目标由渲染层从设置里取好后显式传进来，隐式回退会让「文件落到哪」变得不可预测。
 */
export const LOCAL_FILE_STAT_INPUT = z.object({
  dir: z.string().min(1),
  name: z.string().min(1),
})
export type LocalFileStatInput = z.infer<typeof LOCAL_FILE_STAT_INPUT>

/** local:pick-root 入参（无意义载荷，统一走 unknown 保持「一律 zod 校验」）。 */
export const LOCAL_PICK_ROOT_INPUT = z.unknown()

/* ============ R2-2：设置（默认下载路径） ============ */

/**
 * settings:get 入参（无意义载荷，统一走 unknown 保持「一律 zod 校验」）。
 *
 * 为什么不是 settings:get({ key })：设置页现在只展示「默认下载路径 + adb 状态」，
 * 后者每次都要现取（adb 自检可能还在跑），按 key 取会让界面自己拼一份不一致的快照。
 * 整份返回才有唯一的一份真值。
 */
export const SETTINGS_GET_INPUT = z.unknown()

/**
 * settings:set-download-dir 入参。
 *
 * 为什么**不**做一个通用的 settings:set({ patch })：
 * 用户裁决「设置页目前只加默认下载路径」，通用 patch 会让「再塞一个字段」变成零成本，
 * 而每个字段的校验规则其实不同（这是路径，将来可能是开关或枚举）。
 * 一个通道一件事，校验就永远精确。
 *
 * min(1)：空串没有「用默认目录」的合理含义 —— 想回默认应该点「恢复默认」，
 * 那是**动作用户明确点出来的**，而不是一个空值的隐式副作用。
 */
export const SETTINGS_SET_DOWNLOAD_DIR_INPUT = z.object({
  downloadDir: z.string().min(1),
})
export type SettingsSetDownloadDirInput = z.infer<typeof SETTINGS_SET_DOWNLOAD_DIR_INPUT>

/**
 * settings:pick-download-dir 入参（无意义载荷，统一走 unknown）。
 *
 * 为什么**不复用** local:pick-root：那个通道的副作用是把本地面板的起始浏览目录
 * 改成新选的目录（main.ts 里的 `startDir = ...`）。在设置页换个下载路径
 * 不该顺手把本地栏跳走 —— 那是两件不同的事，只是都会弹同一个系统对话框。
 */
export const SETTINGS_PICK_DOWNLOAD_DIR_INPUT = z.unknown()

/** settings:reset-download-dir 入参（无意义载荷，统一走 unknown 保持「一律 zod 校验」）。 */
export const SETTINGS_RESET_DOWNLOAD_DIR_INPUT = z.unknown()

/* ===== R9：按设备序列号记住上次停留的目录 ===== */

/**
 * settings:get-device-cwd 入参。
 *
 * serial 必须非空：空串代表「设备没有序列号」，那种情况下压根不该有记录
 * （存储层也拒绝写入空 key）。在这里就拒掉，省得下游每一步都判一次空串。
 */
export const SETTINGS_GET_DEVICE_CWD_INPUT = z.object({
  serial: z.string().min(1),
})
export type SettingsGetDeviceCwdInput = z.infer<typeof SETTINGS_GET_DEVICE_CWD_INPUT>

/**
 * settings:set-device-cwd 入参。
 *
 * 两个字段都 min(1)：空 serial 会产生垃圾键，空 cwd 没有语义。
 * 这里**不**校验 cwd 是不是绝对路径、是不是以 / 开头 —— 那是主进程存储层的职责
 * （它还要兼容 Windows 风格路径），校验规则只能有一个来源（src/shared/settings.ts）。
 */
export const SETTINGS_SET_DEVICE_CWD_INPUT = z.object({
  serial: z.string().min(1),
  cwd: z.string().min(1),
})
export type SettingsSetDeviceCwdInput = z.infer<typeof SETTINGS_SET_DEVICE_CWD_INPUT>

/* ============ 任务 10：批量操作（全设备总览页） ============ */

/**
 * 四个批量通道共用的 serials 列表。
 *
 * 上限 16 的理由（R6 的反面）：批量是给人用的（3~5 台），超过 16 台说明用法不对；
 * 而且并发 3 下 16 台要跑好几分钟，界面上的「运行中」会变成一种折磨。
 * 下限 1：空列表没有任何动作可做，直接在 zod 层拒，省得下游每种动作都写一次「没选设备」。
 */
const batchSerials = z.array(z.string().min(1)).min(1).max(16)

/**
 * batch:screenshot 入参。
 *
 * 【复审 I5】dstDir 由 batch:pick-directory 的选择框提供（界面拿不到本地绝对路径，
 * <input type=file> 在 Electron 里不可用）。主进程仍会用 resolveLocalPath
 * 再校验一次（语法 + 真实路径）—— 不信任渲染层给的任何路径。
 *
 * R2-1：本地根目录沙箱已移除，dstDir 可以是任意合法绝对路径。
 *
 * 为什么目录不能为空：空串在这里没有「用默认目录」的合理含义，
 * 默认目录（用户主目录）对一个批量截图动作来说太容易误写。
 */
export const BATCH_SCREENSHOT_INPUT = z.object({
  serials: batchSerials,
  dstDir: z.string().min(1),
})
export type BatchScreenshotInput = z.infer<typeof BATCH_SCREENSHOT_INPUT>

/**
 * batch:install 入参。
 *
 * apkPath 来自 transfer:pick-files 的选择结果（渲染层拿不到绝对路径）。
 * 这里不校验 .apk 后缀：用户完全可以把一个改名成 .bin 的包推上去，
 * 而 adb 自己会给出失败原因 —— 按后缀拒绝只会误伤。
 */
export const BATCH_INSTALL_INPUT = z.object({
  serials: batchSerials,
  apkPath: z.string().min(1),
})
export type BatchInstallInput = z.infer<typeof BATCH_INSTALL_INPUT>

/**
 * batch:push 入参。
 *
 * files 上限 50：每个文件对每台设备都是一条独立传输任务，
 * 50 个文件 × 16 台 = 800 条任务，队列已经失去可读性。
 */
export const BATCH_PUSH_INPUT = z.object({
  serials: batchSerials,
  files: z.array(z.string().min(1)).min(1).max(50),
  dstDir: z.string().min(1),
})
export type BatchPushInput = z.infer<typeof BATCH_PUSH_INPUT>

/**
 * batch:shell 入参。
 *
 * command 上限 4096：与设备侧单行命令的实际上限同量级（PATH_MAX），
 * 再长必然被截断，而截断的命令执行结果无从解释。
 */
export const BATCH_SHELL_INPUT = z.object({
  serials: batchSerials,
  command: z.string().min(1).max(4096),
})
export type BatchShellInput = z.infer<typeof BATCH_SHELL_INPUT>

/* ============ 出参类型（从 shared/types 派生，不重复定义） ============ */

export type { DevicesChangedBatch, DevicesListData, FsListData, IpcResult } from './types'
export type { TransferSnapshot, TransferTask } from './transfer'
export type { DragOutFailure, DragOutProgress } from './drag'
export type { FsOpData, FsRemoveFactsData, LocalFileStat, LocalListData, LocalItem } from './file-ops'
export type { BatchItemResult, BatchRunData } from './batch'
export type { SettingsAdb, SettingsData } from './settings'

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
/* ============ P1 第一批：单机截图 / 录屏 ============ */

/**
 * capture:screenshot 入参。
 *
 * dstDir 允许空串：空串 = 用设置里的默认下载路径。
 * 为什么不在 zod 层要求非空：默认下载路径是用户偏好，界面不该为了「必须传个目录」
 * 而自己抄一份设置值 —— 抄的那份一旦过期，文件会落到用户没想到的地方。
 */
export const CAPTURE_SCREENSHOT_INPUT = z.object({
  serial: z.string().min(1),
  dstDir: z.string(),
})

export type CaptureScreenshotInput = z.infer<typeof CAPTURE_SCREENSHOT_INPUT>

/** capture:record-start 入参（与截图同一形状）。 */
export const CAPTURE_RECORD_START_INPUT = z.object({
  serial: z.string().min(1),
  dstDir: z.string(),
})

export type CaptureRecordStartInput = z.infer<typeof CAPTURE_RECORD_START_INPUT>

/** capture:record-stop 入参（只需 serial：落点在建会话时就已经定了）。 */
export const CAPTURE_RECORD_STOP_INPUT = z.object({
  serial: z.string().min(1),
})

export type CaptureRecordStopInput = z.infer<typeof CAPTURE_RECORD_STOP_INPUT>

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
    /** 列举本地目录（任意合法绝对路径；不存在的返回 E_NOT_FOUND）。 */
    list(payload: LocalListInput): Promise<IpcResult<LocalListData>>
    /** 让用户挑选本地栏的起始浏览目录（不是访问边界）；取消返回空串（不是错误）。 */
    pickRoot(): Promise<IpcResult<string>>
    /**
     * 预检「这个本地目录里有没有同名文件、它多大」（R10 双击下载前）。
     *
     * 返回形状只有两种：存在（带 size）与不存在。「查不到」（权限 / 竞态 / 非法名字）
     * 也收敛成 exists:false —— 渲染层据此照常下载，绝不因为查不了就拦。
     */
    fileStat(payload: LocalFileStatInput): Promise<IpcResult<LocalFileStat>>
  }
  /* ---- R2-2：设置（默认下载路径 + adb 只读状态） ---- */
  settings: {
    /**
     * 取一份设置快照：生效中的默认下载路径、本机默认下载目录、adb 只读状态。
     *
     * downloadDir 一定是**可用值**（主进程已在读取时把坏值降级为本机「下载」目录），
     * 所以「普通下载」直接拿它当目标 —— 见 src/shared/settings.ts 的 downloadTargetOf。
     */
    get(): Promise<IpcResult<SettingsData>>
    /**
     * 写默认下载路径。
     *
     * 非法值（非绝对路径 / 目录不存在）返回错误码而不是静默回退：
     * 这是用户的显式动作，必须能区分「改成了」与「没改成」。
     */
    setDownloadDir(payload: SettingsSetDownloadDirInput): Promise<IpcResult<SettingsData>>
    /**
     * 弹出目录选择框挑默认下载路径；取消返回空串（不是错误）。
     *
     * 与 local:pick-root 分开：那个通道会顺带改本地面板的起始浏览目录，
     * 在设置页换下载路径不该让本地栏跳走。
     */
    pickDownloadDir(): Promise<IpcResult<string>>
    /** 恢复默认（写回本机「下载」目录）。 */
    resetDownloadDir(): Promise<IpcResult<SettingsData>>
    /* ---- R9：按设备记住上次停留的目录 ---- */
    /**
     * 读某台设备上次停留的目录。
     *
     * 返回**空串**表示没有记录（首次使用 / 记录是坏值被降级）——
     * 不是错误：目录记忆是可选能力，「没记过」是它的正常初始状态。
     */
    getDeviceCwd(payload: SettingsGetDeviceCwdInput): Promise<IpcResult<string>>
    /**
     * 记住某台设备停留的目录。
     *
     * **调用方不要 await**（裁决 A：每次成功进入目录就写，fire-and-forget）：
     * 目录记忆是便利功能，它的写盘延迟不该进入用户的浏览路径。
     */
    setDeviceCwd(payload: SettingsSetDeviceCwdInput): Promise<IpcResult<void>>
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
    /* ---- 简报 C：设备 ↔ 资源管理器双向拖拽 ---- */
    /**
     * File → 本地磁盘绝对路径。**同步**，且不经过 IPC。
     *
     * 唯一实现是 Electron 的 webUtils.getPathForFile（渲染层没有 node 能力，
     * 拿不到 File 的磁盘路径；<input type=file> 也一样）。
     * 返回**空串**表示这个 File 不是磁盘上的真实文件（例如从网页里拖来的图片），
     * 调用方必须跳过它 —— 空串绝不能拿去入队。
     */
    getPathForFile(file: unknown): string
    /**
     * 拖出：把设备上的文件拖给资源管理器。
     *
     * 主进程会先下载到临时目录（不设大小门槛，500 MB 也一样），
     * 全部成功后才调 webContents.startDrag；任一失败则不拖并推 onDragOutFailed。
     * 因此这个 Promise **在所有任务进终态后才 resolve** —— 期间界面显示
     * onDragOutProgress 的「正在准备拖拽（N/M）」。
     */
    beginDragOut(payload: DragOutInput): Promise<IpcResult<void>>
    /** 订阅拖出准备进度（「正在准备拖拽（N/M）」）。 */
    onDragOutProgress(callback: (payload: DragOutProgress) => void): Unsubscribe
    /** 订阅拖出失败（任一文件失败就整体不拖）。 */
    onDragOutFailed(callback: (payload: DragOutFailure) => void): Unsubscribe
  }
  /* ---- 任务 10：批量操作（全设备总览页的四个动作） ---- */
  batch: {
    /**
     * 批量截图：每台设备各存一张 png 到**用户在弹出的选择框里挑的目录**。
     *
     * 目标目录刻意不从渲染层传：渲染层拿不到本地绝对路径，
     * 而「往哪里写文件」不该由一个只认识 serial 的界面决定。
     * 用户取消选择时返回 { results: [] }（空结果，不是错误）。
     */
    screenshot(payload: BatchScreenshotInput): Promise<IpcResult<BatchRunData>>
    /** 批量安装（adb install -r）：apk 由主进程的选取框给出。 */
    install(payload: BatchInstallInput): Promise<IpcResult<BatchRunData>>
    /**
     * 批量推送：对每台设备各产生传输任务，立刻返回结果矩阵。
     *
     * 结果里的 ok 表示「已加入队列」，**不是**「已完成」——
     * 真正的传输在队列里跑，进度在底栏看（R2）。
     */
    push(payload: BatchPushInput): Promise<IpcResult<BatchRunData>>
    /** 在所有勾选设备上跑同一条 shell 命令（输出截断到 8 KB）。 */
    shell(payload: BatchShellInput): Promise<IpcResult<BatchRunData>>
    /** 弹出目录选择框（批量截图的目标目录）；取消返回空串。 */
    pickDirectory(): Promise<IpcResult<string>>
    /** 弹出文件选择框挑一个 .apk；取消返回空串。 */
    pickApk(): Promise<IpcResult<string>>
  }
  /* ---- P1 第一批：单机截图 / 录屏 ---- */
  capture: {
    /**
     * 对一台设备截图。
     *
     * 结果里的 taskId 是**传输任务 id**：真正的下载在队列里跑，
     * 落地进度见底栏。localPath 是预期的落点，界面用它做「复制路径」。
     */
    screenshot(payload: CaptureScreenshotInput): Promise<IpcResult<CaptureResult>>
    /**
     * 开始录屏。返回时文件还没生成 —— 停止（或到时间上限）之后才拉回本地。
     */
    recordStart(payload: CaptureRecordStartInput): Promise<IpcResult<RecordStarted>>
    /** 停止录屏并把 mp4 拉回本地。没有在录时返回 E_NOT_RECORDING。 */
    recordStop(payload: CaptureRecordStopInput): Promise<IpcResult<CaptureResult>>
  }
}

/*
 * 【复审 I4】这里原本还有一个 API_SURFACE 清单（DshApi 键集合的字面量副本）
 * 与 apiMethodNames / apiGroupNames 辅助函数。全部删除，理由：
 *   1. 全仓**零消费者**（tests/ 里也零命中），是纯死代码；
 *   2. 它的注释声称「preload 与 api.d.ts 都据此派生，测试做双向比对」，
 *      但那个比对测试在上一轮就删了 —— 注释在撒谎，比没有更危险；
 *   3. DshApi 的守卫已经由三层编译期机制保证：
 *      buildApi 的返回类型标注 + 对象字面量的 satisfies + tests/api-contract-binding
 *      的 never 断言（任一方向不同步都编译失败）。
 */
