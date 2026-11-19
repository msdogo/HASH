/**
 * 跨进程共享的错误码（裁决 3）。
 *
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块。
 *
 * 为什么集中：错误码散落在 client / binary / remote 三处定义，
 * 渲染层要么自己抄一份字符串（抄错就永远匹配不上），要么把中文文案硬编码在组件里。
 * 这里做单一事实源：所有码、判断函数、从异常里取码的翻译器。
 */

/** AdbClient 缺 serial。 */
export const E_NO_SERIAL = 'E_NO_SERIAL'
/** adb 命令超时。 */
export const E_TIMEOUT = 'E_TIMEOUT'
/** 操作被取消。 */
export const E_ABORTED = 'E_ABORTED'
/** 应用正在退出，子进程关闭闸门已置位：命令没有执行（审查轮 3 补登记）。 */
export const E_SHUTDOWN = 'E_SHUTDOWN'
/** 路径非法（含 \n / \r / \0，或空路径）。 */
export const E_INVALID_PATH = 'E_INVALID_PATH'
/** 一个可用的 adb 都没找到。 */
export const E_ADB_NOT_FOUND = 'E_ADB_NOT_FOUND'
/** adb 文件存在但起不来。 */
export const E_ADB_NOT_EXECUTABLE = 'E_ADB_NOT_EXECUTABLE'
/** adb 输出解析不出任何版本行。 */
export const E_ADB_BAD_OUTPUT = 'E_ADB_BAD_OUTPUT'
/** adb 探测超时。 */
export const E_ADB_TIMEOUT = 'E_ADB_TIMEOUT'
/** 候选是 .cmd/.bat 包装脚本（scoop/npm 常见）。 */
export const E_ADB_SHIM_UNSUPPORTED = 'E_ADB_SHIM_UNSUPPORTED'
/** 目录/文件无权限。 */
export const E_NO_PERMISSION = 'E_NO_PERMISSION'
/** 路径不存在。 */
export const E_NOT_FOUND = 'E_NOT_FOUND'
/** 目录内容完全无法解析（连降级都拿不到条目）。 */
export const E_PARSE_DEGRADED = 'E_PARSE_DEGRADED'
/** IPC 入参非法（zod 校验失败）。 */
export const E_BAD_ARGS = 'E_BAD_ARGS'
/** ls 非零退出且零条目，且认不出已知原因。 */
export const E_LIST_FAILED = 'E_LIST_FAILED'
/** 兜底：无法归类的异常。 */
export const E_UNKNOWN = 'E_UNKNOWN'
/** 符号链接的目标无法解析（ls 没给出可用目标），因此不知道该进哪个目录。 */
export const E_LINK_UNRESOLVED = 'E_LINK_UNRESOLVED'
/** 跟随符号链接时检测到环（目标已在本次访问轨迹里，或超过跳数上限）。 */
export const E_LINK_CYCLE = 'E_LINK_CYCLE'
/** 目标存在，但不是目录（例如指向普通文件的快捷方式）。 */
export const E_NOT_A_DIRECTORY = 'E_NOT_A_DIRECTORY'
/**
 * 传输失败，且 stderr 里认不出已知原因（裁决 7：失败任务保留在列表里可重试）。
 *
 * 为什么不复用 E_LIST_FAILED：那条文案说的是「列出目录」，用在传输上会让用户
 * 去检查目录权限，而真实原因往往是写到一半断了、空间不足、目标只读。
 */
export const E_SYNC_FAILED = 'E_SYNC_FAILED'
/** 传输途中设备掉线（裁决 4）：该设备的队列暂停，任务保留可重试。 */
export const E_DEVICE_OFFLINE = 'E_DEVICE_OFFLINE'

/* ===== 任务 9：文件操作与本地双栏 ===== */

/**
 * 路径语法合法但语义越界：含 '..' 段，试图跳出允许的根（裁决 2 / 5）。
 *
 * 与 E_INVALID_PATH 分开的理由：前者是「这个字符串根本不是一个能用的路径」，
 * 后者是「路径本身没问题，但它指向了不该去的地方」。用户看到的文案完全不同 ——
 * 一个是「你输入错了」，另一个是「这个操作被安全策略拦下了」。
 */
export const E_PATH_UNSAFE = 'E_PATH_UNSAFE'
/** 目标是受保护的根路径（/、/sdcard、/storage/emulated/0 …），拒绝删除/移动/改名（裁决 1）。 */
export const E_PROTECTED_PATH = 'E_PROTECTED_PATH'
/** 目标已存在（新建/重命名/复制/移动一律不覆盖，裁决 3）。 */
export const E_ALREADY_EXISTS = 'E_ALREADY_EXISTS'
/** 文件操作失败，且 stderr 里认不出已知原因。 */
export const E_OP_FAILED = 'E_OP_FAILED'
/** 设备上的目标位置只读（例如未 root 时写 /system）。 */
export const E_READ_ONLY = 'E_READ_ONLY'
/** 设备存储空间不足。 */
export const E_NO_SPACE = 'E_NO_SPACE'
/**
 * 本地路径落在用户选定的根目录之外（含符号链接逃逸，裁决 5）。
 *
 * 与 E_PATH_UNSAFE 分开：这条是**本地**盘的越界，文案要引导用户去改根目录设置，
 * 而 E_PATH_UNSAFE 是设备侧的目录穿越，两者该做的事不一样。
 */
export const E_OUTSIDE_ROOT = 'E_OUTSIDE_ROOT'

/**
 * 全部错误码，顺序即「匹配优先级」的参考顺序。
 * 新增错误码必须同时在这里与 i18n 的中文文案表里登记，否则 errors.test 会红。
 */
export const ERROR_CODES = [
  E_NO_SERIAL,
  E_TIMEOUT,
  E_ABORTED,
  E_SHUTDOWN,
  E_INVALID_PATH,
  E_ADB_NOT_FOUND,
  E_ADB_NOT_EXECUTABLE,
  E_ADB_BAD_OUTPUT,
  E_ADB_TIMEOUT,
  E_ADB_SHIM_UNSUPPORTED,
  E_NO_PERMISSION,
  E_NOT_FOUND,
  E_PARSE_DEGRADED,
  E_BAD_ARGS,
  E_LIST_FAILED,
  E_UNKNOWN,
  E_LINK_UNRESOLVED,
  E_LINK_CYCLE,
  E_NOT_A_DIRECTORY,
  E_SYNC_FAILED,
  E_DEVICE_OFFLINE,
  // 任务 9：文件操作与本地双栏
  E_PATH_UNSAFE,
  E_PROTECTED_PATH,
  E_ALREADY_EXISTS,
  E_OP_FAILED,
  E_READ_ONLY,
  E_NO_SPACE,
  E_OUTSIDE_ROOT,
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** 判断任意值是不是表内的错误码。 */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
}

/**
 * 从任意异常/字符串里取出错误码。
 *
 * 匹配要求「独立出现」：前后不能是字母数字下划线，
 * 否则 E_NOT_FOUND 会把 E_ADB_NOT_FOUND 里的片段误认成自己，错误文案就串了。
 * 取不到一律 E_UNKNOWN —— 渲染层永远能拿到一个错误码，不用处理 undefined。
 */
export function toErrorCode(err: unknown): ErrorCode {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (text !== '') {
    for (const code of ERROR_CODES) {
      if (new RegExp('(^|[^A-Za-z0-9_])' + code + '($|[^A-Za-z0-9_])').test(text)) return code
    }
  }
  return E_UNKNOWN
}