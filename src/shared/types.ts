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
