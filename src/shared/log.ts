/**
 * 日志栏的数据模型（纯函数，渲染层与测试共用）。
 *
 * ===== 为什么需要一条独立的日志栏 =====
 * 现有界面只有两个「说明发生了什么」的位置：
 *   - 页面顶部的 notice / error 条：单槽、会被下一条顶掉、切页就没了；
 *   - 传输底栏：只管传输任务，安装与其它动作进不去。
 * 而安装一个 150 MB 的包是几十秒的连续过程，用户中途很可能切页去看别的东西 ——
 * 切回来时既看不到过程，也看不到「刚才到底装成功了没有」。
 *
 * 所以这里做一条**只追加、带时间戳、可折叠**的日志：
 * 它不替代 notice（那是「现在就告诉你一句话」），而是保留「刚才发生过什么」。
 *
 * ===== 为什么只记阶段，不记每次百分比 =====
 * 百分比在底栏的实时进度行里每 300ms 都在滚；若也写进日志，
 * 一次安装就会糊出上百行，把真正重要的那几行（开始 / 失败原因）冲走。
 * 日志的粒度是「阶段变化与结果」，实时数值交给进度条。
 */

/** 日志级别：只有两档 —— 正常过程与失败。 */
export type LogLevel = 'info' | 'error'

/** 一条日志。 */
export interface LogEntry {
  /** 递增 id（列表 key；同一毫秒内也不会重复）。 */
  id: number
  /** 发生时刻（毫秒）。 */
  at: number
  level: LogLevel
  /** 已经翻好的中文文案（渲染层直接显示，不再二次翻译）。 */
  text: string
}

/**
 * 保留条数上限。
 *
 * 200 行 × 一行 ~60 字，内存代价可以忽略；而它覆盖的是一次会话里
 * 所有值得回看的动作。超出后丢最旧的 —— 用户关心的是刚发生的事。
 */
export const LOG_MAX_ENTRIES = 200

/** 追加一条并裁剪到上限（返回新数组，不改原数组）。 */
export function appendLog(
  entries: LogEntry[],
  entry: LogEntry,
  max: number = LOG_MAX_ENTRIES,
): LogEntry[] {
  const next = [...entries, entry]
  return next.length <= max ? next : next.slice(next.length - max)
}

/** 去掉两端空白后的行文本长度，用于折叠态的摘要。 */
export function lastEntryText(entries: LogEntry[]): string {
  const last = entries[entries.length - 1]
  return last === undefined ? '' : last.text
}

/**
 * 把毫秒时间戳格式化成 HH:MM:SS（本地时区）。
 *
 * 只到秒：日志是给人扫一眼「什么时候」的，毫秒只会占宽度。
 * 用本地时区而不是 UTC —— 用户拿自己的钟对时间，对 UTC 没有意义。
 */
export function formatLogTime(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => (value < 10 ? '0' + String(value) : String(value))
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
}
