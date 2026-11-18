import type { FileEntry } from './types'

/**
 * 文件页的纯逻辑（裁决 1/2/4/5/6/7）。
 *
 * 为什么放在 src/shared：测试工程 import 不了 src/ 下非 shared 的目录（TS6307），
 * 而 jsdom 会破坏 tsconfig 的工程划分。所以「排序 / 过滤 / 路径 / 提示条 / 视图状态机」
 * 全部抽成这里的纯函数与纯 reducer，用 node 环境直接测；
 * React 组件（FileTable / Breadcrumb / FilesPage）只负责渲染与把事件转成 action。
 *
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块。
 */

/* ============ 行高（裁决 4：estimateSize 与 CSS 必须同源） ============ */

/**
 * 虚拟滚动的固定行高（px）。
 *
 * 必须只有一个来源：组件里 estimateSize 用它、行的 style.height 也用它。
 * 两处各写一个数字是我在评审里见过最常见的「滚动条越滚越抖」成因。
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
export type TypedPath = { ok: true; path: string } | { ok: false; code: 'E_INVALID_PATH' }

/**
 * 解析地址栏手输的路径（裁决 6）。
 * 空串/纯空白/含控制字符 → E_INVALID_PATH；其余归一化成绝对路径。
 * 注意：这里只做【语法】校验，路径是否真实存在要等 fs:list 的结果 ——
 * 地址栏不该因为「没权限」就判非法，那是另一条提示。
 */
export function parseTypedPath(input: string): TypedPath {
  const trimmed = input.trim()
  if (trimmed === '' || inexpressible(trimmed)) return { ok: false, code: 'E_INVALID_PATH' }
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

/* ============ 排序 ============ */

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

function compareEntries(a: FileEntry, b: FileEntry, sort: SortKey, dir: SortDir): number {
  // 1) 目录恒在前
  const group = groupOf(a) - groupOf(b)
  if (group !== 0) return group

  // 2) 元数据未知的条目恒排最后（裁决 1）：不能因为 size/mtime 恰好是 0 就挤到最前。
  //    这条与升降序无关 —— 「未知」不是「很小」或「很老」。
  const aKnown = isMetaKnown(a)
  const bKnown = isMetaKnown(b)
  if (aKnown !== bKnown) return aKnown ? -1 : 1

  // 3) 主键
  let primary = 0
  if (sort === 'size' && aKnown) primary = a.size - b.size
  else if (sort === 'time' && aKnown) primary = a.mtime - b.mtime
  else primary = compareByName(a.name, b.name)
  if (primary !== 0) return dir === 'asc' ? primary : -primary

  // 4) 同主键时用名称升序兜底：排序必须确定，否则每次重渲染行序会跳
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
  const filtered = filterEntries(entries, options)
  if (options.sort === 'name' && options.sortDir === 'asc') {
    // 默认视图也要排序：ls 的输出顺序在不同设备上不一样
    return sortEntries(filtered, 'name', 'asc')
  }
  return sortEntries(filtered, options.sort, options.sortDir)
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

/* ============ 视图状态机（裁决 2 / 7） ============ */

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
  /** 当前目录（已归一化的绝对路径）。 */
  cwd: string
  sort: SortKey
  sortDir: SortDir
  showHidden: boolean
  /** 最近一次成功列举的条目（原始顺序；展示顺序由 visibleEntries 算）。 */
  entries: FileEntry[]
  status: ViewStatus
  /** 整页错误码（零条目 + 失败）；有内容时失败只写在这里，不整页替换。 */
  error: string | null
  /** 地址栏行内错误码（非法输入），不影响当前目录。 */
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
}

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
  /** 跳转目录（进入子目录 / 面包屑 / 地址栏 / 上一级）。 */
  | { type: 'navigate'; cwd: string }
  /** 重新加载当前目录（刷新）：保留条目、选中与滚动位置，只推进代次。 */
  | { type: 'beginLoad' }
  /** 加载成功；generation 不符即为过期响应，整个状态原样返回。 */
  | { type: 'resolve'; generation: number; data: ListResultData }
  /** 加载失败；generation 不符同样丢弃。 */
  | { type: 'fail'; generation: number; code: string }
  /** 列头点击排序：同列切升降，换列回到升序。 */
  | { type: 'setSort'; sort: SortKey }
  | { type: 'setShowHidden'; value: boolean }
  /** 点选条目；additive 对应 Ctrl/Shift 多选。 */
  | { type: 'select'; name: string; additive: boolean }
  | { type: 'setScrollTop'; value: number }
  /** 地址栏非法输入：只写行内错误，不动当前目录。 */
  | { type: 'addressError'; code: string }
  | { type: 'dismissNotice' }

/** 每台设备的默认视图。 */
export function createFileView(): FileViewState {
  return {
    cwd: DEFAULT_CWD,
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
  }
}

/**
 * 单设备视图的 reducer。
 *
 * 纯函数：同样的 (state, action) 永远得到同样的结果，且无变化时返回【同一个 state 引用】，
 * 让 zustand/React 能跳过无谓重渲染（裁决 2 的测试会断言这一点）。
 */
export function fileViewReducer(state: FileViewState, action: FileViewAction): FileViewState {
  switch (action.type) {
    case 'navigate': {
      const cwd = normalizePath(action.cwd)
      return {
        ...state,
        cwd,
        entries: [],
        selected: [],
        // 换目录 = 新的一屏：滚动位置与提示条都要重置（裁决 7 只要求切设备时保留同目录的滚动位置）
        scrollTop: 0,
        status: 'loading',
        error: null,
        addressError: null,
        notice: null,
        noticeDismissed: false,
        generation: state.generation + 1,
      }
    }
    case 'beginLoad':
      return {
        ...state,
        // 刷新不清空内容：先让用户看到旧内容，新结果到了再替换（不闪白）
        status: 'loading',
        error: null,
        noticeDismissed: false,
        generation: state.generation + 1,
      }
    case 'resolve': {
      // 裁决 2：过期响应必须丢弃。返回原引用，连重渲染都不会发生。
      if (action.generation !== state.generation) return state
      const data = action.data
      return {
        ...state,
        cwd: normalizePath(data.dir),
        entries: data.entries,
        status: 'ready',
        error: null,
        addressError: null,
        tzOffsetMinutes: data.tzOffsetMinutes,
        notice: noticeFromList(data),
        noticeDismissed: false,
        generation: state.generation,
      }
    }
    case 'fail': {
      if (action.generation !== state.generation) return state
      // 已有内容时失败不整页变错误：保留列表，只在顶部提示（裁决 3 的同一条原则）
      if (state.entries.length > 0) {
        return { ...state, status: 'ready', error: action.code }
      }
      return { ...state, status: 'error', error: action.code, entries: [] }
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
 * 把「部分字段」补成完整视图。
 *
 * 为什么需要它：FilesPage 用 useShallow 只订阅影响渲染的字段（不订阅 scrollTop，
 * 否则每帧滚动都会让整页重渲染）。这样拿到的对象是**字段不全**的，
 * 直接当 FileViewState 用会让 entries 变成 undefined —— 首帧就炸「entries is not iterable」。
 * 这里统一补齐：缺的回落默认值，已有的原样保留。默认值仍然只在 createFileView 一处定义。
 */
export function viewFromPartial(partial: Partial<FileViewState> | undefined): FileViewState {
  const base = createFileView()
  if (partial === undefined) return base
  // 逐个字段合并，而不是 Object.assign：null 也是「有值」（error/notice 的合法取值），
  // 必须保留；只有 undefined 才回落默认值。
  return {
    cwd: partial.cwd ?? base.cwd,
    sort: partial.sort ?? base.sort,
    sortDir: partial.sortDir ?? base.sortDir,
    showHidden: partial.showHidden ?? base.showHidden,
    entries: partial.entries ?? base.entries,
    status: partial.status ?? base.status,
    error: partial.error === undefined ? base.error : partial.error,
    addressError: partial.addressError === undefined ? base.addressError : partial.addressError,
    notice: partial.notice === undefined ? base.notice : partial.notice,
    noticeDismissed: partial.noticeDismissed ?? base.noticeDismissed,
    tzOffsetMinutes: partial.tzOffsetMinutes ?? base.tzOffsetMinutes,
    generation: partial.generation ?? base.generation,
    selected: partial.selected ?? base.selected,
    scrollTop: partial.scrollTop ?? base.scrollTop,
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
/* ============ 加载协调器（裁决 2：in-flight 去重 + 过期丢弃） ============ */

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
  /**
   * 为指定设备加载当前 cwd。
   *
   * 幂等：同一 serial + 同一请求代次的重复调用（React StrictMode 双执行 effect、
   * 用户连点刷新）只会发一次 adb 命令。
   */
  load: (serial: string) => Promise<void>
  /** 当前在飞请求数（测试与调试用）。 */
  inflight: () => number
  /** 丢弃在飞记录（设备断开/重连时调用，之后同代次可以重新发起）。 */
  reset: (serial?: string) => void
}

/**
 * 造一个加载协调器。
 *
 * 两个职责，缺一不可（裁决 2）：
 * 1. **in-flight 去重**：同一代次的重复调用共享同一个 Promise —— 否则 StrictMode 下
 *    每个目录会被 ls 两遍（真机上万条目录会明显卡顿）。
 * 2. **过期结果丢弃**：响应落地前按代次比对，旧目录的晚到结果不会覆盖新目录内容。
 *    这一条其实由 fileViewReducer 兜底（generation 不符返回原 state），
 *    但在这里也把 generation 抓在闭包里，避免「发请求后又读 state」引入的时序错位。
 */
export function createLoadCoordinator(deps: LoadCoordinatorDeps): LoadCoordinator {
  const pending = new Map<string, Promise<void>>()
  const codeOf = deps.toCode ?? ((err: unknown): string => 'E_UNKNOWN')

  const load = (serial: string): Promise<void> => {
    const view = deps.get(serial)
    // 请求身份 = 设备 + 代次。代次在 navigate/beginLoad 时已经推进，
    // 所以「切了目录再加载」必然是新的 key，不会被误去重。
    const generation = view.generation
    const dir = view.cwd
    const key = serial + '\u0001' + String(generation)

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
      if (response.ok) {
        deps.dispatch(serial, { type: 'resolve', generation, data: response.data })
      } else {
        deps.dispatch(serial, { type: 'fail', generation, code: response.error })
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
