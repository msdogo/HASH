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
  hops = 0,
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
  // 防环三件套（N2：三条都真的能生效，trail 与 hops 由 navigate 真正累加）：
  // 1. 跳数上限；2. 指回当前目录（自引用）；3. 目标已在走过轨迹里（A→B→A 这种多跳环）
  if (hops >= MAX_LINK_HOPS) return { kind: 'error', code: E_LINK_CYCLE }
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
  /**
   * 区间选择（Shift 点击）的起点：最近一次普通点击 / Ctrl 点击落下的那一行。
   *
   * 【多选增强 / 问题 2】为什么单独存一个字段，而不是从 selected[0] 推：
   * 区间选择期间 anchor 必须【一动不动】—— 否则连按 Shift 点击时，第二次点击
   * 会把起点重置成上一次的终点，区间永远扩不出去（也就缩不回来）。
   * 全选 / 清空**不动** anchor，与 Windows 资源管理器一致：
   * 起点永远是「用户最后一次点过的那一行」。
   */
  anchor: string | null
  /** 列表滚动位置（切设备回来要恢复）。 */
  scrollTop: number
  /**
   * 本次链接跟随链上走过的路径（防环用）。
   *
   * 【审查轮 2 / N2】上一轮只声明、从没写入 —— 于是「轨迹检查」和「跳数上限」都是死代码，
   * 真机上 A→B→A 两跳环会被完整放行。现在由 navigate action 的 linkTarget 真正写入：
   * 每次跟随链接都把「出发目录 + 目标」追加进来，导航到普通目录时清空。
   */
  linkTrail: string[]
  /** 连续跟随链接的跳数（防环第二道；导航到普通目录时归零）。 */
  linkHops: number
  /**
   * 待提交的链接跟随（M1）。
   *
   * 为什么需要「待提交」而不是在 navigate 里直接写轨迹：
   * 修前 navigate 无条件 append，而 fail 分支不回滚 —— 同一目录**连点 N 次打不开的链接**
   * （真机 /adb_keys 这类误双击很常见）会把跳数堆到 MAX_LINK_HOPS、轨迹堆到 2N，
   * 于是紧接着一个**合法**链接被误判成 E_LINK_CYCLE，界面还说「指向了自己或走过的目录」。
   * 修死代码修出了新的误拦。
   *
   * 现在：navigate 只登记 pendingLink，**成功 resolve 时才**把「出发 + 目标」提交进轨迹；
   * fail 直接丢弃（不需要回滚，因为压根没写进去）。
   */
  pendingLink: { from: string; to: string } | null
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
  'generation' | 'scrollTop' | 'pendingCwd' | 'linkTrail' | 'linkHops' | 'pendingLink'
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

/* ============ 多选（问题 2）：三态选中 + 区间 + 全选 ============ */

/**
 * 一次点击的选中语义。
 *
 * 修改历史：修前是布尔 additive，于是 Shift 被当成「再加一项」——
 * 用户按住 Shift 点第 10 行，期望的是「第 1 行到第 10 行」，实际只多选了那一行。
 */
export type SelectMode = 'replace' | 'toggle' | 'range'

/** 修饰键的最小面（只取渲染事件里够用的三个布尔量，便于脱离 DOM 单测）。 */
export interface SelectModifiers {
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

/**
 * 把修饰键翻成选中语义。优先级：Shift > Ctrl/Cmd > 无。
 *
 * 为什么 Shift 最高：Windows / macOS 资源管理器里 Shift 点击就是「选一段」，
 * 即使同时按着 Ctrl 也不改变这个直觉（Ctrl 只影响「要不要保留原有选择」）。
 */
export function selectModeOf(modifiers: SelectModifiers): SelectMode {
  if (modifiers.shiftKey === true) return 'range'
  if (modifiers.ctrlKey === true || modifiers.metaKey === true) return 'toggle'
  return 'replace'
}

/** 键盘选中命令的语义（Ctrl/Cmd+A 全选、Esc 清空）。 */
export type SelectionKeyCommand =
  | { kind: 'selectAll' }
  | { kind: 'clear' }
  | { kind: 'none' }

/**
 * 把按键翻成「选中命令」（问题 2 的 Ctrl+A / Esc）。
 *
 * 为什么抽成纯函数而不是写在组件的 keydown 里：
 * 本工程没有 jsdom，SSR（renderToStaticMarkup）拿不到事件回调，
 * 组件里的按键分支只能靠「看代码」保证 —— 那正是本项目已经吃过多次亏的假护栏。
 * 抽出来之后，键位判定有真正可复现的行为断言，组件只负责转发。
 *
 * 入参是「事件的形状」而不是 DOM 事件：KeyboardEvent 天然满足它（结构子类型），
 * 测试可以直接传字面量。
 */
/**
 * 从事件目标里取 tagName。
 *
 * 为什么参数是 unknown 而不是 HTMLElement：这个模块是 src/shared，
 * 同时被渲染层与主进程编译（后者没有 DOM lib）。用 unknown + 结构收窄，
 * 两个工程都能编译，而 KeyboardEvent<HTMLElement> 也能直接传进来（结构子类型）。
 */
function tagNameOf(target: unknown): string | undefined {
  if (typeof target !== 'object' || target === null) return undefined
  if (!('tagName' in target)) return undefined
  const value = target.tagName
  return typeof value === 'string' ? value : undefined
}

export function keyToSelectionAction(event: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  target?: unknown
}): SelectionKeyCommand {
  /*
   * 焦点在输入控件里时一律不拦截：
   * 地址栏（input）里按 Ctrl+A 必须选中输入框里的文本，Esc 也不该清掉文件选中项。
   * 判定放在这里而不是组件里，测试才能覆盖到「输入框保护」这一条。
   */
  const tagName = tagNameOf(event.target)
  if (tagName === 'INPUT' || tagName === 'TEXTAREA') return { kind: 'none' }

  // 大小写兼容：A 与 a（CapsLock / 大小写状态）都要认
  if (event.key === 'a' || event.key === 'A') {
    if (event.ctrlKey === true || event.metaKey === true) return { kind: 'selectAll' }
    return { kind: 'none' }
  }
  if (event.key === 'Escape' || event.key === 'Esc') return { kind: 'clear' }
  return { kind: 'none' }
}

/**
 * 区间选择：在【展示顺序】里取 anchor 到 name 之间（含两端）的全部名字。
 *
 * 三个必须点（都有用例）：
 * 1. 顺序来自展示数组（过滤+排序后），不是 entries 原始顺序 ——
 *    用原始顺序会出现「界面上连着的一大段，选中的却是散落几项」；
 * 2. anchor 或目标不在当前展示列表里（刷新后消失 / 翻到了别的目录）→ 退化成「只选目标」；
 * 3. 反向拖（从下往上 Shift 点击）同样要正确，所以按两端下标排序后切片。
 */
export function rangeNames(
  displays: readonly string[],
  anchor: string | null,
  target: string,
): string[] {
  if (anchor === null) return [target]
  const from = displays.indexOf(anchor)
  const to = displays.indexOf(target)
  // 起点已经不在当前列表里（刷新后被删 / 换了目录）：退化成单选，绝不产生空选择
  if (from < 0 || to < 0) return [target]
  const start = Math.min(from, to)
  const end = Math.max(from, to)
  return displays.slice(start, end + 1)
}

export type FileViewAction =
  /**
   * 请求跳转（进入子目录 / 面包屑 / 地址栏 / 上一级）：只登记目标，成功后由 resolve 提交 cwd。
   *
   * linkTarget 只在「跟随符号链接」时给：它是解析后的目标路径，
   * 用于把「出发目录 + 目标」真正写进 linkTrail（N2：轨迹与跳数必须由这里累加）。
   */
  | { type: 'navigate'; cwd: string; linkTarget?: string }
  /** 重新加载当前目录（刷新）：保留条目、选中与滚动位置，只推进代次。 */
  | { type: 'beginLoad' }
  /** 加载成功；generation 不符即为过期响应，整个状态原样返回。 */
  | { type: 'resolve'; generation: number; data: ListResultData }
  /** 加载失败；generation 不符同样丢弃。跳转失败时保留当前目录与列表（C1）。 */
  | { type: 'fail'; generation: number; code: string }
  /** 列头点击排序：同列切升降，换列回到升序。 */
  | { type: 'setSort'; sort: SortKey }
  | { type: 'setShowHidden'; value: boolean }
  /**
   * 点选条目。mode 是这次点击的语义（由修饰键决定，见 selectModeOf）：
   * - replace：普通点击，只选它；anchor 移到它；
   * - toggle：Ctrl/Cmd 点击，按存在与否增删；anchor 移到它；
   * - range：Shift 点击，从 anchor 到它在【展示顺序】上的一段；anchor 不动。
   */
  | { type: 'select'; name: string; mode: SelectMode }
  /**
   * 全选（Ctrl/Cmd+A）。
   *
   * 为什么把「可见条目的名字」当参数传进来，而不是让 reducer 自己算：
   * reducer 里虽然有 entries / sort / showHidden，但「用户看到的列表」是
   * FilesPage 用 useMemo 算出来的那一个（与虚拟列表同源）。让调用方把那份
   * 结果传进来，才不会出现「reducer 算出 12 项、界面只显示 10 项」的分叉。
   */
  | { type: 'selectAll'; names: readonly string[] }
  /** 清空选择（Esc）。 */
  | { type: 'clearSelection' }
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
    anchor: null,
    scrollTop: 0,
    linkTrail: [],
    linkHops: 0,
    pendingLink: null,
    loadedOnce: false,
  }
}

/**
 * 把「出发目录 + 链接目标」追加进轨迹（N2）。
 *
 * 为什么要存【出发目录】而不只是目标：A→B→A 这种两跳环里，
 * 第二次站在 B 上点一个指回 A 的链接时，「A」必须已经在轨迹里才拦得住。
 * 只存目标的话，第一跳只记下 B，回到 A 时无从判断。
 *
 * 上限：保留最近 MAX_LINK_HOPS*2 条，避免长会话里数组无限增长；
 * 超出后从头部丢最旧的（旧轨迹已不可能再被走到）。
 */
function appendLinkTrail(trail: readonly string[], from: string, to: string): string[] {
  const next = [...trail, normalizePath(from), normalizePath(to)]
  return next.length > MAX_LINK_HOPS * 2 ? next.slice(next.length - MAX_LINK_HOPS * 2) : next
}

/**
 * 当前展示顺序（过滤 + 排序后）的名字列表。
 *
 * 区间选择必须按这个顺序取段：entries 是 ls 的原始顺序，用户看到的却是排序后的列表。
 * 直接复用 visibleEntries，保证和 FilesPage 里渲染列表用的是同一套规则（不会分叉）。
 */
function displayOrder(state: FileViewState): string[] {
  return visibleEntries(state.entries, {
    showHidden: state.showHidden,
    sort: state.sort,
    sortDir: state.sortDir,
  }).map((entry) => entry.name)
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
    case 'navigate': {
      const target = normalizePath(action.cwd)

      /*
       * 【N1】目标就是当前目录（且已加载过）→ 什么都不做，原样返回。
       *
       * 修前的 bug：这里先把 status 置成 loading 再让调用方早退不发请求，
       * 于是没有任何 resolve/fail 来落状态 —— 点当前层面包屑或地址栏输入当前路径后，
       * 刷新图标会一直转、列表永远停在 loading（真机实测 4-5 秒后仍如此）。
       * 现在在 reducer 里就短路：引用都不变，连重渲染都不会发生。
       */
      if (target === state.cwd && state.loadedOnce) return state

      // 【C1】只登记目标：不清空 entries，不动 cwd / selected / scrollTop。
      // 用户打错一个字母时，当前目录与列表必须原样还在（裁决 6 的「不要整页替换」）。
      //
      // 【N2 / M1】跟随链接时只登记 pendingLink，**轨迹与跳数等成功才提交**；
      // 导航到普通目录（面包屑、子目录、地址栏）则立刻重置轨迹与跳数。
      const following = action.linkTarget !== undefined
      return {
        ...state,
        pendingCwd: target,
        status: 'loading',
        error: null,
        addressError: null,
        noticeDismissed: false,
        generation: state.generation + 1,
        pendingLink: following ? { from: normalizePath(state.cwd), to: target } : null,
        linkTrail: following ? state.linkTrail : [],
        linkHops: following ? state.linkHops : 0,
      }
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
      /*
       * 【多选增强】刷新后 anchor 必须与 selected 一起收敛：
       * 区间起点若已被删掉，anchor 也要同步失效 —— 否则下一次 Shift 点击
       * 会拿一个列表里已不存在的名字当起点，静默退化成单选（用户看到的就是「区间没了」）。
       * 存活判据与 intersectSelected 完全一致：名字仍在这次返回的条目里。
       */
      const survived = new Set(data.entries.map((entry) => entry.name))
      const nextAnchor = sameDir && state.anchor !== null && survived.has(state.anchor) ? state.anchor : null
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
        // 换目录：选中清空、滚动归零；同目录刷新：只把消失的选中项剔除。
        // 注意：链接轨迹【不在这里重置】—— 它由 navigate action 管理（跟随链接时追加、
        // 普通导航时清空）；若在 resolve 里按「目录变了」清空，刚追加进去的轨迹会被立即抹掉，
        // 防环又变回死代码（这正是审查轮 2 / N2 报的问题）。
        selected: sameDir ? intersectSelected(state.selected, data.entries) : [],
        anchor: sameDir ? nextAnchor : null,
        scrollTop: sameDir ? state.scrollTop : 0,
        // 【M1】跟随成功才提交轨迹与跳数（失败路径见 fail 分支：直接丢弃 pendingLink）
        linkTrail: state.pendingLink === null
          ? state.linkTrail
          : appendLinkTrail(state.linkTrail, state.pendingLink.from, state.pendingLink.to),
        linkHops: state.pendingLink === null ? state.linkHops : state.linkHops + 1,
        pendingLink: null,
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
          // 【M1】失败即丢弃待提交的链接跟随：轨迹与跳数一点都不该变
          pendingLink: null,
          error: wasNavigate ? null : action.code,
          addressError: wasNavigate ? action.code : null,
        }
      }
      return {
        ...state,
        status: 'error',
        pendingCwd: null,
        pendingLink: null,
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
      // replace：只选它，anchor 落到它身上
      if (action.mode === 'replace') {
        return { ...state, selected: [action.name], anchor: action.name }
      }
      // toggle：Ctrl/Cmd 点击，按存在与否增删；anchor 同样落到它（与资源管理器一致）
      if (action.mode === 'toggle') {
        const exists = state.selected.includes(action.name)
        return {
          ...state,
          selected: exists
            ? state.selected.filter((name) => name !== action.name)
            : [...state.selected, action.name],
          anchor: action.name,
        }
      }
      /*
       * range：Shift 点击。区间取【展示顺序】（过滤 + 排序后），与用户看到的一致。
       * anchor 保持不变 —— 连续 Shift 点击才能「先扩大再缩小」；
       * 若这里也跟着移动，第二次点击的起点就变成上一次的终点，区间永远只是一格。
       */
      const displayed = displayOrder(state)
      return {
        ...state,
        selected: rangeNames(displayed, state.anchor, action.name),
      }
    }
    case 'selectAll': {
      // 全选 = 当前可见的全部条目（入参由 FilesPage 用同一个 useMemo 结果给），不动 anchor
      if (action.names.length === 0) return state.selected.length === 0 ? state : { ...state, selected: [] }
      const same =
        action.names.length === state.selected.length &&
        action.names.every((name, index) => name === state.selected[index])
      return same ? state : { ...state, selected: [...action.names] }
    }
    case 'clearSelection': {
      // Esc 清空：只清选中项，不动 anchor（起点仍是用户最后点过的那一行）
      if (state.selected.length === 0) return state
      return { ...state, selected: [] }
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
    anchor: partial?.anchor === undefined ? base.anchor : partial.anchor,
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
  /**
   * 请求跳转（成功后由 resolve 提交 cwd）。
   *
   * linkTarget 只在跟随符号链接时传（N2）：它让 reducer 把轨迹与跳数真正累加起来。
   */
  openDir: (serial: string, dir: string, linkTarget?: string) => Promise<void>
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

  /** 当前仍然在线的设备（由 syncDevices 维护；用于淘汰时保护，裁决 7 的「切回各自恢复」）。 */
  let online = new Set<string>()

  /**
   * 超过上限就淘汰最久未使用的分片。
   *
   * 【审查轮 2 / N3】修前两个问题：
   * 1. evict 不立 tombstone、也不 reset 协调器 —— 被淘汰分片的在飞响应回来时
   *    会把它**重新建出来**（实测 views 有三个键而 serials() 只有两个）。
   * 2. 淘汰不区分在线设备 —— 超过上限时可能把「仍然在线」的分片挤掉，
   *    与裁决 7「切回各自恢复」直接冲突。
   *
   * 现在：淘汰 = forget（含 tombstone + reset 协调器）；且**在线设备优先保留**，
   * 只有当「非在线」的候选都淘汰完、仍超限时，才退而淘汰最久未用的在线分片。
   */
  const evict = (): void => {
    while (order.length > maxSerials) {
      // 只淘汰【非在线】分片：在线设备的视图状态必须保留（裁决 7「切回各自恢复」）。
      // 若超限的全是在线设备，宁可不淘汰 —— 内存让位于正确性，
      // 这些分片会在设备断开时由 syncDevices → forget 释放。
      let victimIndex = -1
      for (let i = order.length - 1; i >= 0; i--) {
        if (!online.has(order[i])) { victimIndex = i; break }
      }
      if (victimIndex < 0) return
      const victim = order[victimIndex]
      order = [...order.slice(0, victimIndex), ...order.slice(victimIndex + 1)]
      // 与 forget 同款处理：立 tombstone，迟到响应不许复活
      tombstones.add(victim)
      coordinator.reset(victim)
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
    openDir: (serial, dir, linkTarget) => {
      if (tombstones.has(serial)) return Promise.resolve()
      const normalized = normalizePath(dir)
      const view = viewOf(views, serial)
      // 【N1】目标就是当前目录且已加载过：什么都不做（不置 loading、不发请求）。
      // reducer 里也会短路，这里提前返回是为了不走到 coordinator.load。
      if (normalized === view.cwd && view.loadedOnce) return Promise.resolve()
      model.dispatch(serial, {
        type: 'navigate',
        cwd: normalized,
        // 【N2】跟随链接时把目标交给 reducer，由它写轨迹与跳数
        ...(linkTarget === undefined ? {} : { linkTarget: normalizePath(linkTarget) }),
      })
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
      // 【N3】先更新在线集合，再 ensure（ensure 里的 evict 要据此保护在线设备）
      online = alive
      for (const serial of serials) model.ensure(serial)
      for (const serial of Object.keys(views)) {
        if (!alive.has(serial)) model.forget(serial)
      }
    },
  }

  return model
}