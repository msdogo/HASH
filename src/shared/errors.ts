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