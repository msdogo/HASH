/**
 * 跨进程共享的类型定义。
 *
 * 红线：src/shared 被 tsconfig.app（渲染层）与 tsconfig.node 同时 include。
 * 这里只允许出现纯类型与纯函数，绝不能 import node 内置模块 ——
 * 一旦引入，渲染层的类型门禁就会把 node 类型拖进去而失效。
 */

/** 设备上的一个文件/目录条目（ls -l 语义）。 */
export interface FileEntry {
  name: string
  isDir: boolean
  isLink: boolean
  size: number
  /** 毫秒时间戳；解析不出时为 0。 */
  mtime: number
  /** 权限位，如 rwxr-xr-x。 */
  mode: string
  owner: string
  group: string
  /** 软链接的指向（ls 原样输出，相对目标保持相对）；非软链接为 undefined。 */
  linkTarget?: string
  /**
   * 软链接目标解析后的绝对路径。
   * 只有「绝对目标」或「已知所在目录的相对目标」才能解析出来，其余留 undefined。
   */
  linkTargetResolved?: string
  /**
   * 除 name 之外的字段是否来自真实元数据。
   *
   * 为什么必须有这个字段：真机上大量系统项的 mtime 是 1970-01-01 08:00（设备时区 +08:00），
   * 换算后【正好等于 0】，与「解析不出时为 0」在数值上完全重合；size=0、mode='' 同理。
   * 没有这个标志，调用方就无法区分「真的是 0」与「压根没拿到」，
   * 排序、筛选、显示都会出错。
   * 缺省视为 true（缺省即「来自 ls/stat 的真实输出」）；
   * 只有降级补齐时 stat 也失败、只能造占位条目的情况才置 false。
   */
  metaKnown?: boolean
}

/**
 * 设备连接状态。
 * 只收敛到这 5 个值：adb 的 sideload / bootloader / host / no permissions 等
 * 全部映射为 unknown，避免上层 switch 漏分支。
 */
export type DeviceStatus = 'device' | 'unauthorized' | 'offline' | 'recovery' | 'unknown'

/** 连接方式：serial 里带 ':'（host:port）即无线。 */
export type Transport = 'usb' | 'wireless'

/** 一台设备的会话。断线后会话保留 30 分钟，重连时复用。 */
export interface DeviceSession {
  serial: string
  status: DeviceStatus
  transport: Transport
  model?: string
  android?: string
  battery?: number
  storage?: { usedKb: number; totalKb: number }
  /** 最后一次出现在 adb 设备表里的时间（毫秒）。 */
  lastSeenAt: number
}
/** adb 的来源优先级：custom > env > bundled > path（与 electron/adb/binary.ts 一致）。 */
export type AdbSource = 'custom' | 'env' | 'bundled' | 'path'

/** 单个 adb 候选的探测结论。 */
export interface AdbAttempt {
  path: string
  source: AdbSource
  ok: boolean
  /** 失败原因；成功时缺省。 */
  code?: string
}

/**
 * adb 自检状态（裁决 3：设备栏要显示「无法使用 adb」）。
 * state 只有两态：要么拿到一个可用 adb，要么给出一个错误码。
 */
export type AdbState =
  /** 自检还没结束（启动瞬间）。界面据此显示「正在查找 adb…」，而不是误报「无法使用 adb」。 */
  | { state: 'checking' }
  | { state: 'ok'; path: string; version: string; source: AdbSource }
  | { state: 'error'; code: string; attempts: AdbAttempt[] }

/** 一次完整的设备快照（设备表 + adb 状态），用于指纹比对与首屏下发。 */
export interface DeviceSnapshot {
  devices: DeviceSession[]
  adb: AdbState
}

/** devices:list 的返回数据：设备表 + adb 状态。 */
export type DevicesListData = DeviceSnapshot

/** devices:changed 推送的批次（已节流合并）。 */
export interface DevicesChangedBatch {
  /** 新增或字段有变化的设备。 */
  changed: DeviceSession[]
  /** 被清理掉的 serial（会话过期）。 */
  removed: string[]
  /**
   * 当前 adb 自检状态，随每次推送一起下发。
   *
   * 为什么必须带（而不是可选）：渲染层启动时先拉一次 devices:list，那一刻 adb 自检
   * （4~8s）往往还是 checking。若推送里不带 adb，界面就永远停在「正在查找 adb…」，
   * 「无法使用 adb」的提示永远不会出现。
   * 审查轮 1（I8）把这里从 `adb?` 改成**必填**：bug 2 的本质就是「推送方可以忘记带」，
   * 留成可选等于没把教训固化 —— 现在漏传直接是类型错误。
   */
  adb: AdbState
}

/** fs:list 的返回数据（裁决 7：degraded 与 exitCode 必须带到渲染层）。 */
export interface FsListData {
  serial: string
  /** 归一化后的目录路径（已消除尾斜杠与 ..）。 */
  dir: string
  entries: FileEntry[]
  /** 是否降级（解析率过低或走了 stat 兜底）→ 界面提示「部分文件无法读取」。 */
  degraded: boolean
  /** ls -lA 里解析失败的条数。 */
  unparsed: number
  /** 是否真的执行了 ls -1A + stat 兜底。 */
  usedFallback: boolean
  /** ls 退出码；非 0 但有条目属于「部分可读」，不是错误。 */
  exitCode: number | null
  /** 本次列举使用的设备时区偏移（分钟）。 */
  tzOffsetMinutes: number
}

/**
 * 所有 IPC invoke 通道的统一返回结构（裁决 2）。
 * 主进程永远不通过 reject 传播业务错误 —— 渲染层拿到的要么是 data，要么是一个错误码。
 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }