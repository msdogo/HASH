/**
 * 批量操作的共享类型与纯函数（任务 10）。
 *
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块。
 *
 * 为什么类型必须放 shared 而不是 electron/batch/runner.ts：
 * 渲染层的 OverviewPage / batchStore 要消费逐设备结果，而测试工程与 tsconfig.app
 * 都 import 不了 electron/ 目录（工程划分）。主进程只是使用方，不是类型的家。
 */

/**
 * 一台设备在一次批量动作里的结果。
 *
 * 形状与任务 9 的 OpItemResult 同族：**逐项返回**，长度恒等于入参 serials，
 * 下标与输入一致（R4）。批量动作的价值全在「哪台成了、哪台没成、为什么」，
 * 返回单个布尔就把这些信息丢光了。
 */
export interface BatchItemResult {
  serial: string
  ok: boolean
  /** 失败时的错误码；成功时缺省。 */
  code?: string
  /**
   * 成功时的附加信息。
   *
   * 【约定】这里只放**语言中立的数据**（文件名、数量、命令输出摘要），
   * 不拼中文句子 —— 文案统一由渲染层用 shared/i18n 的 key 组合，
   * 否则主进程会散落一堆用户可见的硬编码中文（裁决 3 的集中管理会被绕过）。
   */
  detail?: string
  /**
   * detail 是否因为过长被截断（R8：单台 stdout 超过 8 KB 截断）。
   *
   * 为什么用独立布尔字段而不是在 detail 里拼「已截断」：
   * 那是中文文案，属于 i18n；主进程只负责陈述事实。
   */
  truncated?: boolean
}

/** 批量动作的统一出参（IPC 的 data 就是它）。 */
export interface BatchRunData {
  results: BatchItemResult[]
}

/** 四个批量动作。 */
export type BatchActionKind = 'screenshot' | 'install' | 'push' | 'shell'

/**
 * 渲染层发给主进程的一次批量请求（判别联合）。
 *
 * 用判别联合而不是四个松散参数：store 只有一个 run()，靠 action 分辨载荷，
 * 少一个字段就是编译错误，不会出现「截图时忘了传 serials」这种运行时错误。
 */
export type BatchRequest =
  | { action: 'screenshot'; serials: string[] }
  | { action: 'install'; serials: string[]; apkPath: string }
  | { action: 'push'; serials: string[]; files: string[]; dstDir: string }
  | { action: 'shell'; serials: string[]; command: string }

/** 结果汇总（界面显示「N 成功 / M 失败」）。 */
export function summarizeBatch(results: readonly BatchItemResult[]): {
  ok: number
  failed: number
  total: number
} {
  let ok = 0
  for (const item of results) if (item.ok) ok += 1
  return { ok, failed: results.length - ok, total: results.length }
}

/**
 * 按 **UTF-8 字节数**截断一段文本（R8）。
 *
 * 为什么按字节而不是按字符：IPC 载荷与终端输出的成本都按字节算，
 * 一个汉字 3 字节，按字符截到 512 会让实际载荷变成 1.5 KB。
 *
 * 为什么不能切在半个码点中间：切成孤立代理对会变成 U+FFFD，
 * 而「截断」这个动作本身不该制造乱码。这里按码点遍历，只整码点外放。
 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: text !== '' }
  let bytes = 0
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (bytes + size > maxBytes) return { text: out, truncated: true }
    bytes += size
    out += ch
  }
  return { text: out, truncated: false }
}

/* ============ 总览页的展示数据（规格 §9.3） ============ */

/**
 * 电量数值：**没有数据就返回 null，绝不编造**。
 *
 * DeviceSession.battery 是可选的，而当前唯一数据来源是 adb devices -l（不含电量），
 * 所以真实运行中它总是 undefined。界面显示占位符，而不是 0% / 100%。
 */
export function batteryPercent(battery: number | undefined): number | null {
  if (battery === undefined) return null
  if (!Number.isFinite(battery)) return null
  if (battery < 0 || battery > 100) return null
  return battery
}

/** 存储条展示态：占比（画条用）与「已用 / 总量 GB」标签。没有数据返回 null。 */
export function storageView(
  storage: { usedKb: number; totalKb: number } | undefined,
): { percent: number; label: string } | null {
  if (storage === undefined) return null
  const { usedKb, totalKb } = storage
  if (!Number.isFinite(usedKb) || !Number.isFinite(totalKb)) return null
  if (totalKb <= 0 || usedKb < 0) return null
  const percent = Math.min(100, Math.max(0, (usedKb / totalKb) * 100))
  const usedGb = usedKb / 1024 / 1024
  const totalGb = totalKb / 1024 / 1024
  // 标签只含数字与单位（GB），不带中文：文案外壳由界面拼
  return { percent, label: usedGb.toFixed(0) + ' / ' + totalGb.toFixed(0) + ' GB' }
}

/** 该设备是否还有排队/进行中的传输任务（「N 任务」列）。 */
export function activeTaskCount(
  tasks: ReadonlyArray<{ serial: string; status: string }>,
  serial: string,
): number {
  let count = 0
  for (const task of tasks) {
    if (task.serial !== serial) continue
    if (task.status === 'running' || task.status === 'queued') count += 1
  }
  return count
}

/**
 * 成功项在结果矩阵里显示什么（i18n key + 占位参数）。
 *
 * 为什么主进程的 detail 是「语言中立的数据」（任务 id / 文件数 / 命令输出）
 * 而这里才拼文案：主进程不该输出用户可见的中文（裁决 3 要求文案集中在 i18n），
 * 但它必须把「是哪个任务 / 几个文件 / 输出了什么」这些事实原样带上来。
 * 两边的分工在这一个函数交界，也就能被单测钉住。
 *
 * 返回 null 表示「成功但没有附加信息」，界面显示「空闲」占位。
 */
export function batchDetailKey(
  action: BatchActionKind,
  item: BatchItemResult,
): { key: string; params: Record<string, string> } | null {
  if (!item.ok) return null
  switch (action) {
    case 'screenshot':
      // 截图的 detail 是传输任务 id：真正的下载在队列里跑
      return { key: 'batch.result.queued', params: {} }
    case 'install':
      return { key: 'batch.result.installed', params: {} }
    case 'push':
      // 推送的 detail 是已入队的文件数
      return { key: 'batch.result.filesQueued', params: { count: item.detail ?? '0' } }
    case 'shell':
      // 执行命令的 detail 是 stdout 摘要（可能为空：命令本身没输出）
      return item.detail === undefined || item.detail === ''
        ? { key: 'batch.result.noOutput', params: {} }
        : { key: 'batch.shellOutput', params: { text: item.detail } }
    default:
      return null
  }
}

/** 批量动作 → i18n key（界面按钮文案）。 */
export function batchActionLabelKey(action: BatchActionKind): string {
  switch (action) {
    case 'screenshot': return 'batch.screenshot'
    case 'install': return 'batch.install'
    case 'push': return 'batch.push'
    case 'shell': return 'batch.shell'
    default: return 'batch.actions'
  }
}
