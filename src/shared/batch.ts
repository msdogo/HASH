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
  | { action: 'screenshot'; serials: string[]; dstDir: string }
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

/* ============ 提交闸门（C1：从组件里抽出来的可测纯函数） ============ */

/** 决定「能不能点某个批量按钮」的全部输入。 */
export interface SubmitState {
  /** 有批量动作正在跑（简报：运行中禁用，避免重复提交）。 */
  running: boolean
  /** 已勾选且仍存在的设备数。 */
  pickedCount: number
  action: BatchActionKind
  /** 批量推送已选中的本地文件数。 */
  fileCount?: number
  /** 批量推送的目标目录（用户输入的原始串）。 */
  dstDir?: string
  /** 批量执行命令的内容。 */
  command?: string
}

/**
 * 该动作的按钮现在能不能点。
 *
 * 为什么做成纯函数（复审 C1）：这条规则原先只在 OverviewPage 的 JSX 里以
 * disabled={...} 的属性形式存在，而静态断言只能匹配源码文本 —— 把它改写成
 * 三目表达式或默认参数，断言照样绿。抽到 shared 之后就能用真实输入测出
 * 「运行中不可点」「没勾设备不可点」「推送没选文件不可点」「空命令不可点」。
 */
export function canSubmit(state: SubmitState): boolean {
  if (state.running) return false
  if (state.pickedCount <= 0) return false
  switch (state.action) {
    case 'push':
      // 没选文件 / 没写目标目录时点下去只会得到一条「参数不合法」
      return (state.fileCount ?? 0) > 0 && (state.dstDir ?? '').trim() !== ''
    case 'shell':
      return (state.command ?? '').trim() !== ''
    default:
      return true
  }
}

/* ============ 执行命令的输出预算（I3：流式截断，不让内存线性增长） ============ */

/** 单台命令的 stdout 上限（R8）。 */
export const SHELL_STDOUT_LIMIT_BYTES = 8 * 1024
/** 结果矩阵里 detail 的上限（R8：只放前 512 字节摘要）。 */
export const DETAIL_LIMIT_BYTES = 512

/** 一个按字节计预算的 stdout 收集器。 */
export interface StdoutBudget {
  /** 喂一个 chunk；返回 true 表示已经超出上限（调用方应中止命令）。 */
  push(chunk: string): boolean
  /** 已收集的文本（永不超过上限，且不切出半个码点）。 */
  text(): string
  /** 是否发生过截断。 */
  overflowed(): boolean
}

/**
 * 造一个 stdout 预算收集器。
 *
 * 【复审 I3】修前是把整条命令的输出全收进 run.stdout（AdbClient 内部
 * stdout += text），跑完才 truncateUtf8 —— 截断只作用于 IPC 载荷，
 * 主进程内存在命令运行期间仍随输出线性增长（审查实测一条命令 27.4 MB / 堆 +25.1 MB）。
 *
 * 现在改由本收集器在**收流的过程中**就封顶，并在超限时让调用方 abort 命令：
 * 缓冲占用恒定 <= 上限 + 一个 chunk，与命令输出总量无关。
 *
 * 用码点边界切：切成孤立代理对会变成 U+FFFD，而「截断」不该制造乱码。
 */
export function createStdoutBudget(maxBytes: number = SHELL_STDOUT_LIMIT_BYTES): StdoutBudget {
  let kept = ''
  let bytes = 0
  let overflow = false
  return {
    push(chunk) {
      if (overflow) return true
      for (const ch of chunk) {
        const code = ch.codePointAt(0) ?? 0
        const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
        if (bytes + size > maxBytes) {
          overflow = true
          return true
        }
        bytes += size
        kept += ch
      }
      return false
    },
    text() { return kept },
    overflowed() { return overflow },
  }
}

/* ============ 危险命令判定（规格 §9.6） ============ */

/**
 * 规格 §9.6 点名要二次确认的三类危险命令。
 *
 * 只认「这些词作为命令里的一个独立词」的形态：
 *   - kill-server 会中断用户其它调试工具（本应用自己也在用 adb，杀了会全线报错）；
 *   - reboot 会让勾选的所有设备同时重启；
 *   - root / unroot 会改变设备的安全状态。
 *
 * 判据刻意宽松到「词出现在命令任意位置」：用户可能写成 su -c reboot、
 * sh -c "reboot"、rm -rf /system && reboot。误报的代价是多一次确认；
 * 漏报的代价是同时重启一片设备 —— 取前者。
 */
const DANGEROUS_WORDS: readonly string[] = ['kill-server', 'reboot', 'root']

export function isDangerousCommand(command: string): boolean {
  const lower = command.toLowerCase()
  for (const word of DANGEROUS_WORDS) {
    // 前后不能紧邻字母数字或连字符，避免 rooted / reboot-x 之类误判
    const re = new RegExp('(^|[^a-z0-9_-])' + word + '($|[^a-z0-9_-])')
    if (re.test(lower)) return true
  }
  return false
}
