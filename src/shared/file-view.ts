import type { FileEntry } from './types'
import { E_LINK_CYCLE, E_LINK_UNRESOLVED, E_INVALID_PATH } from './errors'

/**
 * 文件页的纯逻辑（裁决 1/2/4/5/6/7 + 审查轮 1 的 C1/I1/I2/I4/I5/I7）。
 *
 * 为什么放在 src/shared：测试工程 import 不了 src/ 下非 shared 的目录（TS6307），
 * 而 jsdom 会破坏 tsconfig 的工程划分。所以「排序 / 过滤 / 路径 / 提示条 / 视图状态机 /
 * 加载协调器 / 分片模型」全部抽成这里的纯函数与纯类，用 node 环境直接测；
 * React 组件（FileTable / Breadcrumb / FilesPage）只负责渲染与把事件转成 action。
 *
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块。
 */

/* ============ 行高（裁决 4：estimateSize 与 CSS 必须同源） ============ */

/**
 * 虚拟滚动的固定行高（px）。
 *
 * 必须只有一个来源：组件里 estimateSize 用它、行的 style.height 也用它。
 * 两处各写一个数字是「滚动条越滚越抖」的最常见成因。
 */
export const ROW_HEIGHT = 34

/* ============ 路径运算（裁决 6：面包屑与地址栏） ============ */

/** 含换行/回车/NUL 的路径无法表达成 adb shell 命令，直接判非法。 */
function inexpressible(text: string): boolean {
  return text.includes('\n') || text.includes('\r') || text.includes('\0')
}

/**
 * 归一化绝对路径：折叠重复斜杠、消掉 '.'、把 '..' 回退一级并在根处夹住，去掉尾斜杠。
 * 相对写法补前导斜杠。空串归一为根。
 */
export function normalizePath(input: string): string {
  const segments: string[] = []
  for (const seg of input.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      segments.pop() // 空数组时 pop() 无副作用：'..' 在根处被吞掉，绝不逃出根
      continue
    }
    segments.push(seg)
  }
  return '/' + segments.join('/')
}

/** 面包屑的一段：显示名 + 点击要跳到的路径。 */
export interface PathSegment {
  name: string
  path: string
}

/**
 * 把路径切成面包屑的每一段（从根开始）。
 * 每段自带可跳转的绝对路径 —— 任意一层都能直接点回去（裁决 6）。
 */
export function segmentsOf(path: string): PathSegment[] {
  const normalized = normalizePath(path)
  const out: PathSegment[] = [{ name: '/', path: '/' }]
  if (normalized === '/') return out
  let current = ''
  for (const name of normalized.slice(1).split('/')) {
    current = current + '/' + name
    out.push({ name, path: current })
  }
  return out
}

/** 拼接目录与名字（名字是绝对路径时直接采用）。 */
export function joinEntryPath(base: string, name: string): string {
  if (name.startsWith('/')) return normalizePath(name)
  return normalizePath(normalizePath(base) + '/' + name)
}

/** 上一层目录；根没有上一层（返回 null，界面据此禁用「上一级」）。 */
export function parentOf(path: string): string | null {
  const normalized = normalizePath(path)
  if (normalized === '/') return null
  const idx = normalized.lastIndexOf('/')
  return idx <= 0 ? '/' : normalized.slice(0, idx)
}

/** 地址栏输入路径的解析结果：成功给出可跳转路径，失败给出错误码（行内报错用）。 */
export type TypedPath = { ok: true; path: string } | { ok: false; code: typeof E_INVALID_PATH }

/**
 * 解析地址栏手输的路径（裁决 6）。
 * 空串/纯空白/含控制字符 → E_INVALID_PATH；其余归一化成绝对路径。
 * 注意：这里只做【语法】校验，路径是否真实存在要等 fs:list 的结果 ——
 * 地址栏不该因为「没权限」就判非法，那是另一条提示。
 */
export function parseTypedPath(input: string): TypedPath {
  const trimmed = input.trim()
  if (trimmed === '' || inexpressible(trimmed)) return { ok: false, code: E_INVALID_PATH }
  return { ok: true, path: normalizePath(trimmed) }
}

/* ============ 点目录与隐藏文件（裁决 5） ============ */

/** ls -A 通常不含 . 与 ..，但不同 toybox 可能带上；前端一律过滤（裁决 5）。 */
export function isDotEntry(name: string): boolean {
  return name === '.' || name === '..'
}

/** '.' 开头的普通项（.nomedia、.thumbnails）；. 与 .. 不算隐藏项，它们根本不该出现。 */
export function isHiddenName(name: string): boolean {
  // '..' 也是 '.' 开头且长度 2，必须显式排除，否则它会被当成隐藏项而漏过 isDotEntry 的过滤顺序
  return name.length > 1 && name.startsWith('.') && !isDotEntry(name)
}

export interface FilterOptions {
  /** 是否显示隐藏项；默认关闭。 */
  showHidden: boolean
}

/**
 * 过滤掉 . / .. 与（可选的）隐藏项。
 * 无论后端是否返回点目录，这里都会拦住 —— 用户不该在手机文件列表里看到 '.'
 * （而且那个条目根本点不开，点进去就是死循环）。
 */
export function filterEntries(entries: readonly FileEntry[], options: FilterOptions): FileEntry[] {
  const out: FileEntry[] = []
  for (const entry of entries) {
    if (isDotEntry(entry.name)) continue
    if (!options.showHidden && isHiddenName(entry.name)) continue
    out.push(entry)
  }
  return out
}

/* ============ metaKnown（裁决 1） ============ */

/**
 * 该条目的元数据是否可信。
 *
 * 为什么必须走这个函数而不是直接读 size/mtime：
 * 真机上大量系统项的 mtime 是 1970-01-01 08:00（设备时区 +08:00），换算是【正好 0】，
 * 与「解析不出时为 0」数值完全重合。任务 5 用 metaKnown 区分二者，
 * 缺省视为 true（来自真实 ls/stat 输出），只有降级补齐也失败时才为 false。
 */
export function isMetaKnown(entry: FileEntry): boolean {
  return entry.metaKnown !== false
}

/* ============ 格式化 ============ */

/** 1024 进制单位；GB 之后还有 TB（手机不太会有，但格式化函数不该有断档）。 */
const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const

/**
 * 大小显示。未知元数据返回 null（由界面显示「未知」，裁决 1）。
 *
 * 目录的「大小」没有意义，调用方（FileTable）对目录显示占位符而不调本函数。
 */
export function formatSize(entry: FileEntry): string | null {
  if (!isMetaKnown(entry)) return null
  const bytes = entry.size
  if (!Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return bytes + ' B'
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return value.toFixed(1) + ' ' + SIZE_UNITS[unitIndex]
}

/** 两位补零。 */
function pad2(value: number): string {
  return value < 10 ? '0' + value : String(value)
}

/**
 * 修改时间显示为「YYYY-MM-DD HH:mm」，按【设备时区】换算。
 *
 * 参数 tzOffsetMinutes 来自 fs:list 的返回（设备 date +%z），不是宿主时区 ——
 * 否则宿主在 UTC 时，刚拍的照片会显示成 8 小时后（任务 5 已踩过这个坑）。
 * 未知元数据返回 null（界面显示「未知」而不是 1970-01-01，裁决 1）。
 */
export function formatMtime(entry: FileEntry, tzOffsetMinutes: number): string | null {
  if (!isMetaKnown(entry)) return null
  if (!Number.isFinite(entry.mtime)) return null
  // 用 UTC 取值器读「设备本地挂钟时间」：把偏移加回时间戳，再按 UTC 拆字段
  const shifted = new Date(entry.mtime + tzOffsetMinutes * 60_000)
  if (Number.isNaN(shifted.getTime())) return null
  return (
    String(shifted.getUTCFullYear()) + '-' +
    pad2(shifted.getUTCMonth() + 1) + '-' +
    pad2(shifted.getUTCDate()) + ' ' +
    pad2(shifted.getUTCHours()) + ':' +
    pad2(shifted.getUTCMinutes())
  )
}

/* ============ 排序（裁决 1 + I1） ============ */

export type SortKey = 'name' | 'size' | 'time'
export type SortDir = 'asc' | 'desc'

/**
 * 名称比较器：中文按拼音、数字按自然序（file2 在 file10 之前）、大小写不敏感。
 *
 * 用模块级缓存的 Intl.Collator 而不是每次 localeCompare：
 * 后者在万级条目下每次比较都要重建排序规则，10k 排序会从几十毫秒涨到几百毫秒。
 */
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

export function compareByName(a: string, b: string): number {
  const diff = collator.compare(a, b)
  if (diff !== 0) return diff
  // Collator 在 sensitivity:base 下把 'a' 与 'A' 视为相等；
  // 再用原始码位兜底，保证排序结果确定（否则同分项顺序随引擎实现漂移）。
  return a < b ? -1 : a > b ? 1 : 0
}

/** 分组权重：目录恒在文件之前（与升降序无关，用户心智固定）。 */
function groupOf(entry: FileEntry): number {
  return entry.isDir ? 0 : 1
}

/**
 * 比较两个条目。
 *
 * 【审查轮 1 / I1】两套规则必须分开，不能拿 metaKnown 一刀切：
 * - 按【名称】排序：名字永远是已知的，metaKnown 与排序无关 ——
 *   修前把「未知项置后」放在主键之前，导致一个未知的 a.bin 被排到所有已知文件之后
 *   （a.bin 跑到了 z.txt 后面），明显违反排序直觉。
 * - 按【大小/时间】排序：未知项恒排最后，且与升降序无关 ——
 *   「未知」不是「很小」或「很老」，不能因为值是 0 就挤到最前。
 */
function compareEntries(a: FileEntry, b: FileEntry, sort: SortKey, dir: SortDir): number {
  // 1) 目录恒在前
  const group = groupOf(a) - groupOf(b)
  if (group !== 0) return group

  // 2) 名称排序：只比名字，metaKnown 完全不参与
  if (sort === 'name') {
    const byName = compareByName(a.name, b.name)
    return dir === 'asc' ? byName : -byName
  }

  // 3) 大小/时间排序：未知项恒排最后（与方向无关）
  const aKnown = isMetaKnown(a)
  const bKnown = isMetaKnown(b)
  if (aKnown !== bKnown) return aKnown ? -1 : 1

  // 4) 主键
  const primary = sort === 'size' ? a.size - b.size : a.mtime - b.mtime
  if (primary !== 0) return dir === 'asc' ? primary : -primary

  // 5) 同主键时用名称升序兜底：排序必须确定，否则每次重渲染行序会跳
  return compareByName(a.name, b.name)
}

/**
 * 排序（返回新数组，不修改入参）。
 * 直接 sort 会被调用方当成「原地排序」误用，而 store 里的数组可能正被 React 渲染。
 */
export function sortEntries(
  entries: readonly FileEntry[],
  sort: SortKey,
  dir: SortDir,
): FileEntry[] {
  return [...entries].sort((a, b) => compareEntries(a, b, sort, dir))
}

/**
 * 列表最终展示的条目：过滤 + 排序。
 *
 * 组件里必须把它包在 useMemo 里（依赖 entries / sort / sortDir / showHidden），
 * 绝不能放在渲染函数里每次重算 —— 万级条目下每次滚动都排序会直接掉帧（裁决 4）。
 */
export function visibleEntries(
  entries: readonly FileEntry[],
  options: FilterOptions & { sort: SortKey; sortDir: SortDir },
): FileEntry[] {
  return sortEntries(filterEntries(entries, options), options.sort, options.sortDir)
}

/** 列表底部统计：目录数 / 文件数 / 总数。 */
export function summarizeEntries(entries: readonly FileEntry[]): {
  dirs: number
  files: number
  total: number
} {
  let dirs = 0
  for (const entry of entries) if (entry.isDir) dirs += 1
  return { dirs, files: entries.length - dirs, total: entries.length }
}

/* ============ I4：条目点击后的导航目标（链接目录与防环） ============ */

/**
 * 允许跟随的符号链接层数上限。
 *
 * 为什么不靠「只跟一层」：真机上 /sdcard -> /storage/self/primary -> /mnt/user/0/primary
 * 这种两级链接很常见，只跟一层会让第二层点不开。用「跳数上限 + 已访问轨迹」双重防护。
 */
export const MAX_LINK_HOPS = 8

/** 点击一个条目之后该做什么。 */
export type OpenTarget =
  | { kind: 'enter'; path: string; followedLink: boolean }
  | { kind: 'noop'; reason: 'file' }
  | { kind: 'error'; code: string }

/**
 * 计算「点这个条目该跳到哪」（I4）。
 *
 * 任务 5 裁决 4 定的是「链接的 isDir 恒为 false，由调用方决定是否跟随」——
 * 文件页就是那个调用方。修前这里直接 if (!entry.isDir) return，
 * 于是 /sdcard、/storage/self/primary 这类真机最常见的入口全都点不开且无任何提示。
 *
 * 规则：
 * 1. 普通目录 → join(cwd, name)；
 * 2. 链接且 linkTargetResolved 可用 → 进入解析后的绝对路径（打 followedLink 标记）；
 * 3. 链接但目标解析不出来 → E_LINK_UNRESOLVED（界面给明确提示，不静默）；
 * 4. 目标已在 trail 里、或等于当前目录、或 trail 已达上限 → E_LINK_CYCLE（防环）；
 * 5. 普通文件 → noop（双击文件不改目录，留给任务 9 的「打开/下载」）。
 */
export function openTarget(
  entry: FileEntry,
  cwd: string,
  trail: readonly string[],
): OpenTarget {
  if (!entry.isLink) {
    if (!entry.isDir) return { kind: 'noop', reason: 'file' }
    return { kind: 'enter', path: joinEntryPath(cwd, entry.name), followedLink: false }
  }

  const target = entry.linkTargetResolved
  if (target === undefined || target === '') {
    return { kind: 'error', code: E_LINK_UNRESOLVED }
  }
  const resolved = normalizePath(target)
  // 防环三件套：走到上限、指回已走过的目录、指回当前目录
  if (trail.length >= MAX_LINK_HOPS) return { kind: 'error', code: E_LINK_CYCLE }
  if (resolved === normalizePath(cwd)) return { kind: 'error', code: E_LINK_CYCLE }
  if (trail.some((visited) => normalizePath(visited) === resolved)) {
    return { kind: 'error', code: E_LINK_CYCLE }
  }
  return { kind: 'enter', path: resolved, followedLink: true }
}

/* ============ I7：键盘命令 ============ */

/** 导航级快捷键的语义（组件只做「把 event.key 翻成命令」这一步）。 */
export type NavKeyCommand =
  | { kind: 'up'; path: string }
  | { kind: 'refresh' }
  | { kind: 'none' }

/**
 * 把按键翻成导航命令（I7：规格 9.5 要求 Enter 打开 / Backspace 上级 / F5 刷新）。
 *
 * 只认 Backspace 与 F5：Enter 在行上（打开条目）由 isOpenKey 处理，
 * 方向键留给列表自身滚动 —— 组件吞掉它们会破坏原生滚动与未来多选的键位。
 */
export function navKeyCommand(key: string, cwd: string): NavKeyCommand {
  if (key === 'Backspace') {
    const parent = parentOf(cwd)
    return parent === null ? { kind: 'none' } : { kind: 'up', path: parent }
  }
  if (key === 'F5') return { kind: 'refresh' }
  return { kind: 'none' }
}

/** 行上的「打开」键：Enter（空格留给未来的多选切换）。 */
export function isOpenKey(key: string): boolean {
  return key === 'Enter'
}
/* ============ 降级提示（裁决 3） ============ */

/** fs:list 里与「提示条」相关的字段（与 shared/types 的 FsListData 对齐）。 */
export interface ListDegradeInput {
  degraded: boolean
  unparsed: number
  usedFallback: boolean
  exitCode: number | null
}

/** 列表顶部的提示条内容。 */
export interface ListNotice extends ListDegradeInput {}

/**
 * 由一次 fs:list 的结果算出「要不要显示提示条」。
 *
 * 两种情况要提示、且都【不是错误】（列表照常显示）：
 * 1. degraded：部分条目解析失败 / 走了 stat 兜底 → 「部分条目无法读取（N 项）」；
 * 2. exitCode 非 0：/proc 这类半可读目录，个别子项无权限，条目却拿到了。
 * 完全失败（零条目 + 错误码）走错误态与重试按钮，不在这里。
 */
export function noticeFromList(input: ListDegradeInput): ListNotice | null {
  const badExit = input.exitCode !== null && input.exitCode !== 0
  if (!input.degraded && !badExit) return null
  return {
    degraded: input.degraded,
    unparsed: input.unparsed,
    usedFallback: input.usedFallback,
    exitCode: input.exitCode,
  }
}

/* ============ 视图状态机（裁决 2 / 7 + C1 / I2） ============ */

/** 默认目录（规格：进入文件页先停在 /sdcard）。 */
export const DEFAULT_CWD = '/sdcard'

export type ViewStatus = 'idle' | 'loading' | 'ready' | 'error'

/**
 * 单台设备的文件页状态。
 *
 * 为什么把 loading / generation / 滚动位置 / 选中项全放进这里：
 * - generation 是「过期响应丢弃」的唯一依据（裁决 2）；
 * - scrollTop 与 selected 放在 store 里，切设备回来才能恢复（裁决 7）；
 * - 后续任务 9 的「本地双栏」只需再加一个 pane 分片，不用改这一层的语义。
 */
export interface FileViewState {
  /**
   * 当前【已确认可读】的目录（已归一化的绝对路径）。
   *
   * 【C1】它只在 fs:list 成功后才提交 —— 用户跳转到一个不存在/无权限的目录时，
   * cwd 不前移，列表也不清空，只在地址栏行内报错。
   */
  cwd: string
  /** 正在请求中的目标目录；null 表示没有待确认的跳转。 */
  pendingCwd: string | null
  sort: SortKey
  sortDir: SortDir
  showHidden: boolean
  /** 最近一次成功列举的条目（原始顺序；展示顺序由 visibleEntries 算）。 */
  entries: FileEntry[]
  status: ViewStatus
  /** 整页错误码（首次加载就失败）；有内容时失败只写 addressError。 */
  error: string | null
  /** 行内错误码（地址栏非法输入、跳转失败、链接环/无法解析）。 */
  addressError: string | null
  /** 降级/退出码提示条内容；null 表示无需提示。 */
  notice: ListNotice | null
  /** 本次加载的提示条是否被用户关掉。 */
  noticeDismissed: boolean
  /** 本次列举使用的设备时区偏移（分钟），用于时间显示。 */
  tzOffsetMinutes: number
  /**
   * 请求代次。每发起一次加载就 +1，响应回来时代次不符一律丢弃。
   *
   * 为什么是代次而不是 AbortController：fs:list 走 IPC + adb 子进程，
   * 渲染层 abort 并不能真正杀掉落地的 ls（主进程已经没有取消通道），
   * 而「丢弃过期结果」才是用户能感知的正确行为，且实现上零竞态。
   */
  generation: number
  /** 选中项的名字（任务 9 的文件操作要用）。 */
  selected: string[]
  /** 列表滚动位置（切设备回来要恢复）。 */
  scrollTop: number
  /** 本次会话里跟随过的链接目标（防环用；换目录成功后按新目录重置）。 */
  linkTrail: string[]
  /** 是否已经成功加载过至少一次（区分「首次就失败=整页错误」与「有内容时失败=行内提示」）。 */
  loadedOnce: boolean
}

/**
 * FilesPage 实际订阅的字段（**故意不含 generation / scrollTop / pendingCwd / linkTrail**）。
 *
 * 为什么收窄类型而不是给全量状态：
 * - scrollTop 每帧都会变，订阅它就等于每帧整页重渲染（裁决 4）；
 * - generation 是实现细节，页面拿到的永远是默认值 0 —— 后来者写
 *   current.generation === x 做竞态判断会静默失效。
 * 用 Omit 把这两个字段挡在类型层外面，误用直接编译报错（审查轮 1 的提示项）。
 */
export type FileViewSlice = Omit<
  FileViewState,
  'generation' | 'scrollTop' | 'pendingCwd' | 'linkTrail'
>

/** fs:list 的返回数据（只取视图需要的字段，避免 store 依赖主进程实现细节）。 */
export interface ListResultData {
  dir: string
  entries: FileEntry[]
  degraded: boolean
  unparsed: number
  usedFallback: boolean
  exitCode: number | null
  tzOffsetMinutes: number
}

export type FileViewAction =
  /** 请求跳转（进入子目录 / 面包屑 / 地址栏 / 上一级）：只登记目标，成功后由 resolve 提交 cwd。 */
  | { type: 'navigate'; cwd: string }
  /** 重新加载当前目录（刷新）：保留条目、选中与滚动位置，只推进代次。 */
  | { type: 'beginLoad' }
  /** 加载成功；generation 不符即为过期响应，整个状态原样返回。 */
  | { type: 'resolve'; generation: number; data: ListResultData }
  /** 加载失败；generation 不符同样丢弃。跳转失败时保留当前目录与列表（C1）。 */
  | { type: 'fail'; generation: number; code: string }
  /** 列头点击排序：同列切升降，换列回到升序。 */
  | { type: 'setSort'; sort: SortKey }
  | { type: 'setShowHidden'; value: boolean }
  /** 点选条目；additive 对应 Ctrl/Shift 多选。 */
  | { type: 'select'; name: string; additive: boolean }
  | { type: 'setScrollTop'; value: number }
  /** 行内错误（地址栏非法输入 / 链接无法进入）：只写提示，不动当前目录。 */
  | { type: 'addressError'; code: string }
  | { type: 'dismissNotice' }

/** 每台设备的默认视图。 */
export function createFileView(): FileViewState {
  return {
    cwd: DEFAULT_CWD,
    pendingCwd: null,
    sort: 'name',
    sortDir: 'asc',
    showHidden: false,
    entries: [],
    status: 'idle',
    error: null,
    addressError: null,
    notice: null,
    noticeDismissed: false,
    tzOffsetMinutes: 0,
    generation: 0,
    selected: [],
    scrollTop: 0,
    linkTrail: [],
    loadedOnce: false,
  }
}

/** 选中项与新条目求交集（I2：刷新后不对看不见的条目执行操作）。 */
function intersectSelected(selected: readonly string[], entries: readonly FileEntry[]): string[] {
  if (selected.length === 0) return selected as string[]
  const alive = new Set(entries.map((entry) => entry.name))
  const kept = selected.filter((name) => alive.has(name))
  // 没有变化时保留原数组引用，避免无谓的重渲染
  if (kept.length === selected.length && kept.every((name, index) => name === selected[index])) {
    return selected as string[]
  }
  return kept
}

/**
 * 单设备视图的 reducer。
 *
 * 纯函数：同样的 (state, action) 永远得到同样的结果，且无变化时返回【同一个 state 引用】，
 * 让 zustand/React 能跳过无谓重渲染（裁决 2 的测试会断言这一点）。
 */
export function fileViewReducer(state: FileViewState, action: FileViewAction): FileViewState {
  switch (action.type) {
    case 'navigate':
      // 【C1】只登记目标：不清空 entries，不动 cwd / selected / scrollTop。
      // 用户打错一个字母时，当前目录与列表必须原样还在（裁决 6 的「不要整页替换」）。
      return {
        ...state,
        pendingCwd: normalizePath(action.cwd),
        status: 'loading',
        error: null,
        addressError: null,
        noticeDismissed: false,
        generation: state.generation + 1,
      }
    case 'beginLoad':
      return {
        ...state,
        // 刷新不清空内容：先让用户看到旧内容，新结果到了再替换（不闪白）
        status: 'loading',
        error: null,
        addressError: null,
        noticeDismissed: false,
        generation: state.generation + 1,
      }
    case 'resolve': {
      // 裁决 2：过期响应必须丢弃。返回原引用，连重渲染都不会发生。
      if (action.generation !== state.generation) return state
      const data = action.data
      const dir = normalizePath(data.dir)
      // 目录是否变了决定 selected / scrollTop 的处置（I2）
      const sameDir = dir === state.cwd
      return {
        ...state,
        cwd: dir,
        pendingCwd: null,
        entries: data.entries,
        status: 'ready',
        error: null,
        addressError: null,
        tzOffsetMinutes: data.tzOffsetMinutes,
        notice: noticeFromList(data),
        noticeDismissed: false,
        // 换目录：选中清空、滚动归零、链接轨迹重置；同目录刷新：只把消失的选中项剔除
        selected: sameDir ? intersectSelected(state.selected, data.entries) : [],
        scrollTop: sameDir ? state.scrollTop : 0,
        linkTrail: sameDir ? state.linkTrail : [],
        loadedOnce: true,
      }
    }
    case 'fail': {
      if (action.generation !== state.generation) return state
      // 【C1】跳转失败：cwd / entries / selected / scrollTop 全部保持不变，只写行内/顶部提示。
      // 从未成功加载过（首次进入就失败）才显示整页错误态 —— 否则用户会丢掉当前目录。
      // 区分两种失败：navigate 失败走地址栏行内错误（C1 的核心），refresh 失败走顶部提示条。
      const wasNavigate = state.pendingCwd !== null
      if (state.loadedOnce || state.entries.length > 0) {
        return {
          ...state,
          // 失败后不再处于 loading：列表停在原内容上
          status: state.status === 'loading' ? 'ready' : state.status === 'error' ? 'ready' : state.status,
          pendingCwd: null,
          error: wasNavigate ? null : action.code,
          addressError: wasNavigate ? action.code : null,
        }
      }
      return {
        ...state,
        status: 'error',
        pendingCwd: null,
        error: action.code,
        addressError: action.code,
        entries: [],
      }
    }
    case 'setSort': {
      if (state.sort === action.sort) {
        return { ...state, sortDir: state.sortDir === 'asc' ? 'desc' : 'asc' }
      }
      return { ...state, sort: action.sort, sortDir: 'asc' }
    }
    case 'setShowHidden':
      return state.showHidden === action.value ? state : { ...state, showHidden: action.value }
    case 'select': {
      if (!action.additive) {
        return { ...state, selected: [action.name] }
      }
      const exists = state.selected.includes(action.name)
      return {
        ...state,
        selected: exists
          ? state.selected.filter((name) => name !== action.name)
          : [...state.selected, action.name],
      }
    }
    case 'setScrollTop':
      // 像素级抖动不需要进 store；只有整行级变化才值得一次重渲染
      return Math.abs(state.scrollTop - action.value) < 1 ? state : { ...state, scrollTop: action.value }
    case 'addressError':
      return { ...state, addressError: action.code }
    case 'dismissNotice':
      return state.noticeDismissed ? state : { ...state, noticeDismissed: true }
    default:
      return state
  }
}

/* ============ 按 serial 分片（裁决 7） ============ */

/** serial → 该设备的视图状态。 */
export type FileViews = Record<string, FileViewState>

/** 带设备归属的 action。 */
export type ScopedViewAction = FileViewAction & { serial: string }

/** 取某台设备的视图（不存在时给默认值，不写入）。 */
export function viewOf(views: FileViews, serial: string): FileViewState {
  return views[serial] ?? createFileView()
}

/**
 * 把「部分字段」补成完整 slice。
 *
 * 为什么需要它：FilesPage 用 useShallow 只订阅影响渲染的字段（不订阅 scrollTop，
 * 否则每帧滚动都会让整页重渲染）。这样拿到的对象是**字段不全**的，
 * 直接当 FileViewState 用会让 entries 变成 undefined —— 首帧就炸 entries is not iterable。
 *
 * 【审查轮 1】返回类型收窄成 FileViewSlice：generation / scrollTop 这些「未订阅、永远是默认值」
 * 的字段**不在返回类型里**，后来者若写 current.generation 会直接编译报错，
 * 而不是静默拿到 0 去做错的竞态判断。
 */
export function viewFromPartial(partial: Partial<FileViewSlice> | undefined): FileViewSlice {
  const base = createFileView()
  // 逐个字段合并，而不是 Object.assign：null 也是「有值」（error/notice 的合法取值），
  // 必须保留；只有 undefined 才回落默认值。
  return {
    cwd: partial?.cwd ?? base.cwd,
    sort: partial?.sort ?? base.sort,
    sortDir: partial?.sortDir ?? base.sortDir,
    showHidden: partial?.showHidden ?? base.showHidden,
    entries: partial?.entries ?? base.entries,
    status: partial?.status ?? base.status,
    error: partial?.error === undefined ? base.error : partial.error,
    addressError: partial?.addressError === undefined ? base.addressError : partial.addressError,
    notice: partial?.notice === undefined ? base.notice : partial.notice,
    noticeDismissed: partial?.noticeDismissed ?? base.noticeDismissed,
    tzOffsetMinutes: partial?.tzOffsetMinutes ?? base.tzOffsetMinutes,
    selected: partial?.selected ?? base.selected,
    loadedOnce: partial?.loadedOnce ?? base.loadedOnce,
  }
}

/**
 * 按 serial 分片的 reducer。
 *
 * 两台设备各自维护 cwd / 条目 / 选中项 / 滚动位置 —— 切回各自恢复到原处（裁决 7）。
 * 用 Record 而不是 Map：zustand 的浅比较与 React 的依赖追踪都按对象身份走，
 * 每次更新只替换目标 serial 的那一个分片，其它分片的引用保持不变。
 */
export function fileViewsReducer(views: FileViews, action: ScopedViewAction): FileViews {
  const current = views[action.serial]
  const next = fileViewReducer(current ?? createFileView(), action)
  if (current !== undefined && next === current) {
    // 无变化（例如过期响应被丢弃）：整份 views 引用原样返回
    return views
  }
  return { ...views, [action.serial]: next }
}

/* ============ 加载协调器（裁决 2 + I5 去重键修正） ============ */

/** 一次 fs:list 请求的身份。 */
export interface ListRequest {
  serial: string
  dir: string
}

/** fs:list 的返回（与 IpcResult<FsListData> 结构兼容：成功时多出的 serial 字段无妨）。 */
export type ListResponse = { ok: true; data: ListResultData } | { ok: false; error: string }

/** 协调器依赖（注入以便脱离 window.api 单测）。 */
export interface LoadCoordinatorDeps {
  /** 读某台设备的当前视图。 */
  get: (serial: string) => FileViewState
  /** 把 action 派发到该设备的分片。 */
  dispatch: (serial: string, action: FileViewAction) => void
  /** 真正发起列举（store 里包一层 window.api.fs.list）。 */
  fetch: (request: ListRequest) => Promise<ListResponse>
  /** 异常 → 错误码；缺省 E_UNKNOWN。 */
  toCode?: (err: unknown) => string
}

/** 加载协调器：把「什么时候发请求、结果该不该落地」收敛到一处。 */
export interface LoadCoordinator {
  /** 为指定设备加载当前请求目标（pendingCwd ?? cwd）。幂等：同 serial + 同目录的在飞请求复用。 */
  load: (serial: string) => Promise<void>
  /** 当前在飞请求数（测试与调试用）。 */
  inflight: () => number
  /** 丢弃在飞记录（设备断开/重连时调用）。 */
  reset: (serial?: string) => void
}

/**
 * 造一个加载协调器。
 *
 * 两个职责，缺一不可（裁决 2 / I5）：
 * 1. **in-flight 去重**：去重键是 **serial + dir**，不是 serial + generation。
 *    修前用 generation 做键，而刷新本身就会推进 generation —— 于是「连点三次刷新」
 *    每次键都不同、每次都发一条 ls（用户看到的是一串重复请求）。
 *    按目录去重后，同一目录的进行中请求直接复用；不同目录才真的发新请求。
 * 2. **过期结果丢弃**：请求发出时把 generation 抓在闭包里，落地前比对；
 *    旧目录的晚到结果不会覆盖新目录内容（reducer 里还有第二道防线）。
 */
export function createLoadCoordinator(deps: LoadCoordinatorDeps): LoadCoordinator {
  const pending = new Map<string, Promise<void>>()
  const codeOf = deps.toCode ?? ((err: unknown): string => 'E_UNKNOWN')

  const load = (serial: string): Promise<void> => {
    const view = deps.get(serial)
    // 【C1】加载的是「待确认的目标」，没有待确认目标时才是刷新当前目录
    const dir = view.pendingCwd ?? view.cwd
    const generation = view.generation
    const key = serial + '\u0001' + dir

    const existing = pending.get(key)
    if (existing !== undefined) return existing

    const promise = (async (): Promise<void> => {
      let response: ListResponse
      try {
        response = await deps.fetch({ serial, dir })
      } catch (err) {
        // 任何异常都收敛成错误码：协调器绝不向外抛，否则调用方会漏掉 catch
        response = { ok: false, error: codeOf(err) }
      }
      // 落地前再确认一次「目标还是同一个目录」：
      // 用户中途切走就必须丢弃这条结果（裁决 2）；但只是刷新（代次推进、目标没变）
      // 时这条结果仍然有效 —— 用目录而不是代次判断，否则连点刷新会把有效结果一起丢掉。
      const latest = deps.get(serial)
      if ((latest.pendingCwd ?? latest.cwd) !== dir) return
      if (response.ok) {
        deps.dispatch(serial, { type: 'resolve', generation: latest.generation, data: response.data })
      } else {
        deps.dispatch(serial, { type: 'fail', generation: latest.generation, code: response.error })
      }
    })()

    pending.set(key, promise)
    // 完成后清掉在飞记录，让后续刷新能真正重新发请求。
    // 用 finally 而不是 await 后的语句：调用方不 await 时也要清理，否则会永久占位。
    void promise.finally(() => {
      if (pending.get(key) === promise) pending.delete(key)
    })
    return promise
  }

  return {
    load,
    inflight: () => pending.size,
    reset: (serial) => {
      if (serial === undefined) {
        pending.clear()
        return
      }
      for (const key of [...pending.keys()]) {
        if (key.startsWith(serial + '\u0001')) pending.delete(key)
      }
    },
  }
}

/* ============ 分片模型（I5 / I6：forget、tombstone、LRU） ============ */

/** 默认保留的设备分片数上限（超出按最近使用淘汰）。 */
export const MAX_VIEW_SERIALS = 16

export interface FileViewsModelDeps {
  fetch: (request: ListRequest) => Promise<ListResponse>
  /** 每次状态变化都通知（zustand 用它同步到 React）。 */
  onChange: (views: FileViews) => void
  /** 最多保留多少台设备的分片（LRU）；缺省 MAX_VIEW_SERIALS。 */
  maxSerials?: number
  toCode?: (err: unknown) => string
}

/** 分片模型：所有状态迁移的唯一入口（store 只是它的一层壳）。 */
export interface FileViewsModel {
  getViews: () => FileViews
  ensure: (serial: string) => void
  dispatch: (serial: string, action: FileViewAction) => void
  /** 请求跳转（成功后由 resolve 提交 cwd）。 */
  openDir: (serial: string, dir: string) => Promise<void>
  /** 刷新当前目录。 */
  refresh: (serial: string) => Promise<void>
  /** 加载当前请求目标。 */
  load: (serial: string) => Promise<void>
  /** 忘记某台设备（断开连接）：清掉分片并立 tombstone，迟到的响应不许复活它。 */
  forget: (serial: string) => void
  /** 当前保留的 serial（按最近使用排序，测试用）。 */
  serials: () => string[]
  inflight: () => number
  /** 设备列表变化时同步：新出现的 ensure，消失的 forget。 */
  syncDevices: (serials: readonly string[]) => void
}

/**
 * 造一个分片模型。
 *
 * 【审查轮 1 / I5 / I6】修前的三个问题：
 * 1. forget() 没有任何调用方 —— 设备拔掉后分片永远留着（每台存完整 entries）；
 * 2. 已在飞的请求在 forget 后仍会把分片**重新建出来**（实测 views 里设备会「复活」）；
 * 3. 分片数量无上限，插拔多台设备后内存单调增长。
 *
 * 现在：forget 会立 tombstone 拦住迟到响应；分片数超过 maxSerials 按 LRU 淘汰；
 * syncDevices 把 deviceStore 的设备表变化接到 ensure/forget 上。
 */
export function createFileViewsModel(deps: FileViewsModelDeps): FileViewsModel {
  let views: FileViews = {}
  let order: string[] = []
  const tombstones = new Set<string>()
  const maxSerials = Math.max(1, deps.maxSerials ?? MAX_VIEW_SERIALS)

  const publish = (): void => {
    deps.onChange(views)
  }

  const touch = (serial: string): void => {
    order = [serial, ...order.filter((s) => s !== serial)]
  }

  /** 超过上限就淘汰最久未使用的分片（正在显示的设备由调用方通过 ensure 刷新顺序）。 */
  const evict = (): void => {
    while (order.length > maxSerials) {
      const victim = order[order.length - 1]
      order = order.slice(0, -1)
      const next = { ...views }
      delete next[victim]
      views = next
    }
  }

  const coordinator = createLoadCoordinator({
    get: (serial) => viewOf(views, serial),
    dispatch: (serial, action) => {
      // 【I5】tombstone 拦的是「forget 之后迟到的响应」：不许把分片复活
      if (tombstones.has(serial)) return
      const next = fileViewsReducer(views, { ...action, serial })
      if (next === views) return
      views = next
      publish()
    },
    fetch: deps.fetch,
    toCode: deps.toCode,
  })

  const model: FileViewsModel = {
    getViews: () => views,
    ensure: (serial) => {
      // 设备重新出现：清掉 tombstone，之后可以正常加载
      tombstones.delete(serial)
      if (views[serial] !== undefined) {
        touch(serial)
        return
      }
      views = fileViewsReducer(views, { serial, type: 'setShowHidden', value: false })
      touch(serial)
      evict()
      publish()
    },
    dispatch: (serial, action) => {
      if (tombstones.has(serial)) return
      const next = fileViewsReducer(views, { ...action, serial })
      if (next === views) return
      views = next
      touch(serial)
      publish()
    },
    openDir: (serial, dir) => {
      if (tombstones.has(serial)) return Promise.resolve()
      const normalized = normalizePath(dir)
      const view = viewOf(views, serial)
      model.dispatch(serial, { type: 'navigate', cwd: normalized })
      // 目标与当前目录相同且已加载过：不必再请求（点面包屑的当前层是常见操作）
      if (normalized === view.cwd && view.loadedOnce) return Promise.resolve()
      return coordinator.load(serial)
    },
    refresh: (serial) => {
      if (tombstones.has(serial)) return Promise.resolve()
      model.dispatch(serial, { type: 'beginLoad' })
      return coordinator.load(serial)
    },
    load: (serial) => (tombstones.has(serial) ? Promise.resolve() : coordinator.load(serial)),
    forget: (serial) => {
      // 先立 tombstone，再删分片：在飞请求的响应回来时会被它拦住
      tombstones.add(serial)
      coordinator.reset(serial)
      order = order.filter((s) => s !== serial)
      if (views[serial] !== undefined) {
        const next = { ...views }
        delete next[serial]
        views = next
        publish()
      }
    },
    serials: () => order,
    inflight: () => coordinator.inflight(),
    syncDevices: (serials) => {
      const alive = new Set(serials)
      for (const serial of serials) model.ensure(serial)
      for (const serial of Object.keys(views)) {
        if (!alive.has(serial)) model.forget(serial)
      }
    },
  }

  return model
}