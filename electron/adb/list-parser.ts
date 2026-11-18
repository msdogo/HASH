import type { FileEntry } from '../../src/shared/types'

/**
 * `ls -l` 长格式解析器。
 *
 * 为什么写得这么啰嗦：真机（DJI RC Plus 2 / adb 1.0.41）的输出与教科书写法有五处不一致，
 * 都被真机抓包证实（见 tests/fixtures/real-ls.ts）：
 *   1. 字符设备/块设备行的 size 列是 `主,   次` 两段，中间还带对齐空格；
 *   2. 权限位会出现 s 位（drwxrws--x），不能只认 rwx-；
 *   3. 属主/属组可能是数字 UID，不能假设一定是名字；
 *   4. 名字里可以有空格、中文、括号、加号、顿号，**还包括前导空格**。
 *      ls 在时间列与名字之间只放一个分隔空格，所以「时间列后只吃一个空格」是硬要求：
 *      贪婪吃掉空白会把 ` lead.txt` 变成 `lead.txt`，属于静默数据错误。
 *   5. 符号链接的 `名字 -> 目标` 里，名字本身也可能含 ' -> '。
 *      单靠字符串切分必有歧义，这里借助 size 列（符号链接的 st_size 就是目标的**字节数**）
 *      来消歧：从右往左找第一个「右侧部分字节数正好等于 size」的切分点。
 * 解析失败不是「罕见异常」而是常态（目录条目权限不足、被截断等），
 * 所以这里同时返回未解析行数与样本，供上层决定是否降级。
 */

/** FileEntry 的扩展：链接目标的绝对路径（裁决 4）。 */
export interface ParsedLinkTarget {
  /** ls 原样输出的目标串（相对目标保持相对）。 */
  linkTarget?: string
  /** 相对目标按所在目录解析后的绝对路径；无法解析时 undefined。 */
  linkTargetResolved?: string
}

export interface ParseOptions {
  /** 该列表所属目录（绝对路径）。给了它才能把相对链接目标解析成绝对路径。 */
  dir?: string
  /**
   * 设备本地时间相对 UTC 的偏移，单位分钟（东八区 = 480）。
   *
   * 必须显式给：ls 输出的是**设备本地时间**，而 `new Date(y, mo, d, h, mi, s)` 按**宿主**时区解释。
   * 宿主在 UTC 时，同一份输出会整体平移 8 小时（产品后果：刚拍的照片显示成「8 小时后」）。
   * 缺省 0 表示「按 UTC 解释」——这是确定值，不是「跟随宿主」，因此结果与宿主时区无关。
   */
  tzOffsetMinutes?: number
}

export interface ParseStats {
  entries: FileEntry[]
  /** 非空、非 total 行里解析失败的条数。 */
  unparsed: number
  /** 未解析行原文样本（最多 20 条），用于诊断与降级决策。 */
  unparsedSamples: string[]
}

/** 未解析样本最多留这么多条：大目录下全留会白白吃内存。 */
const MAX_UNPARSED_SAMPLES = 20

/** 类型位 + 9 位权限位；后面可能跟 SELinux 的 '.' 或 ACL 的 '+'。 */
const MODE_RE = /^([-dlbcps][rwxsStT-]{9})(?:[.+])?[ \t]+/

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

/** 名字里不能再出现 NUL/换行：这类字符根本进不了 adb shell 命令串。 */
function isExpressible(name: string): boolean {
  return !name.includes('\n') && !name.includes('\r') && !name.includes('\0')
}

/** UTF-8 字节数（用来和符号链接的 st_size 对齐，不能用 .length）。 */
function utf8Length(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code < 0x10000) bytes += 3
    else bytes += 4
  }
  return bytes
}

/**
 * 归一化绝对路径：折叠重复斜杠、消掉 '.'、把 '..' 回退到父级并在根处夹住。
 * 绝不返回根以外的结果 —— 目录穿越必须止步于 '/'。
 */
export function normalizeAbsolutePath(input: string, base?: string): string {
  const start = base === undefined ? input : base + '/' + input
  const segments: string[] = []
  for (const seg of start.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      segments.pop() // 空数组时 pop() 无副作用：'..' 在根处被吞掉
      continue
    }
    segments.push(seg)
  }
  return '/' + segments.join('/')
}

/** 把相对目标按目录解析成绝对路径；无法解析（缺目录）时返回 undefined。 */
function resolveLinkTarget(target: string, dir?: string): string | undefined {
  if (!isExpressible(target)) return undefined
  if (target.startsWith('/')) return normalizeAbsolutePath(target)
  if (dir === undefined || dir === '') return undefined
  return normalizeAbsolutePath(target, dir)
}

/** 解析一行 ls -l 的时间列。返回 undefined 表示格式不认识。 */
function parseTimeColumn(rest: string): { dateMs: number; consumed: number } | undefined {
  // 1) ISO：2026-11-18 16:54 / 16:54:33（真机格式，日期与时间之间可能是多个空格）
  let m = /^(\d{4})-(\d{2})-(\d{2})[ \t]+(\d{1,2}):(\d{2})(?::(\d{2}))?[ \t]/.exec(rest)
  if (m) {
    const [, y, mo, d, h, mi, s] = m
    return { dateMs: utcMs(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0)), consumed: m[0].length }
  }
  // 2) 英文月名带时间（BSD/busybox 的「近期文件」写法）：Jan  5 11:10 —— 没有年份，按当年算
  m = /^([A-Za-z]{3})[ \t]+(\d{1,2})[ \t]+(\d{1,2}):(\d{2})[ \t]/.exec(rest)
  if (m) {
    const month = MONTHS[m[1].toLowerCase()]
    if (month === undefined) return undefined
    const now = new Date()
    return { dateMs: utcMs(now.getUTCFullYear(), month, Number(m[2]), Number(m[3]), Number(m[4]), 0), consumed: m[0].length }
  }
  // 3) 只有日期没有时间（部分 toybox 对老文件只给日期）：2023-01-15
  m = /^(\d{4})-(\d{2})-(\d{2})[ \t]/.exec(rest)
  if (m) {
    const [, y, mo, d] = m
    return { dateMs: utcMs(Number(y), Number(mo) - 1, Number(d), 0, 0, 0), consumed: m[0].length }
  }
  // 4) 英文月名带年份：Jan  5  2023
  m = /^([A-Za-z]{3})[ \t]+(\d{1,2})[ \t]+(\d{4})[ \t]/.exec(rest)
  if (m) {
    const month = MONTHS[m[1].toLowerCase()]
    if (month === undefined) return undefined
    return { dateMs: utcMs(Number(m[3]), month, Number(m[2]), 0, 0, 0), consumed: m[0].length }
  }
  return undefined
}

/** 按 UTC 拼出「设备本地挂钟时间」对应的毫秒值，再减去设备时区偏移换成真实时间戳。 */
function utcMs(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  const ms = Date.UTC(y, mo, d, h, mi, s)
  return Number.isFinite(ms) ? ms : 0
}

/** 把「设备本地挂钟时间」换算成真实时间戳；绝不用宿主时区。 */
function deviceLocalToEpochMs(localMs: number, tzOffsetMinutes: number): number {
  return localMs - tzOffsetMinutes * 60_000
}

/**
 * 把 `名字 -> 目标` 切成两部分。
 *
 * 难点：名字里可能含 ' -> '，目标里也可能含 ' -> '，纯字符串切分必有歧义。
 * 解法：符号链接的 st_size 就是目标的**字节数**，用它做校验 ——
 * 从右往左尝试每个 ' -> ' 切分点，取第一个「右侧字节数 === size」的；
 * 都对不上时退回最右切分点（ls 的语义是目标在最后）。
 */
export function splitLinkLine(rest: string, size: number): { name: string; target?: string } {
  let idx = rest.lastIndexOf(' -> ')
  let fallback = -1
  while (idx >= 0) {
    const target = rest.slice(idx + 4)
    if (fallback < 0) fallback = idx
    if (utf8Length(target) === size) {
      return { name: rest.slice(0, idx), target }
    }
    idx = idx === 0 ? -1 : rest.lastIndexOf(' -> ', idx - 1)
  }
  if (fallback < 0) return { name: rest }
  return { name: rest.slice(0, fallback), target: rest.slice(fallback + 4) }
}

/** 解析一行；解析不出来返回 undefined（由调用方计未解析）。 */
function parseLine(line: string, opts: ParseOptions): FileEntry | undefined {
  const modeMatch = MODE_RE.exec(line)
  if (!modeMatch) return undefined
  const mode = modeMatch[1]
  const typeChar = mode[0]
  let rest = line.slice(modeMatch[0].length)

  // 硬链接数
  const nlink = /^(\d+)[ \t]+/.exec(rest)
  if (!nlink) return undefined
  rest = rest.slice(nlink[0].length)

  // 属主、属组：可能是名字也可能是数字 UID，一律按 \S+ 收
  const owner = /^(\S+)[ \t]+/.exec(rest)
  if (!owner) return undefined
  rest = rest.slice(owner[0].length)
  const group = /^(\S+)[ \t]+/.exec(rest)
  if (!group) return undefined
  rest = rest.slice(group[0].length)

  // 尺寸：字符/块设备是「主, 次」，这里取主设备号（与 ls -l 第一列语义一致）
  let size = 0
  if (typeChar === 'c' || typeChar === 'b') {
    const dev = /^(\d+)[ \t]*,[ \t]*(\d+)[ \t]+/.exec(rest)
    if (!dev) return undefined
    size = Number(dev[1])
    rest = rest.slice(dev[0].length)
  } else {
    const sizeMatch = /^(\d+)[ \t]+/.exec(rest)
    if (!sizeMatch) return undefined
    size = Number(sizeMatch[1])
    rest = rest.slice(sizeMatch[0].length)
  }

  // 时间列：正则末尾只吃【一个】分隔空白，剩下的空白属于名字本身（前导空格名）
  const time = parseTimeColumn(rest)
  if (!time) return undefined
  rest = rest.slice(time.consumed)

  // 名字保持原样：不 trim —— 真机上允许前导空格与行尾空格的文件名。
  const name = rest
  if (name === '' || !isExpressible(name)) return undefined

  const isLink = typeChar === 'l'
  let finalName = name
  let linkTarget: string | undefined
  if (isLink) {
    const split = splitLinkLine(name, size)
    finalName = split.name
    linkTarget = split.target
    if (finalName === '') return undefined
  }

  const entry: FileEntry = {
    name: finalName,
    // 裁决 4：链接的 isDir 恒为 false，是否跟随由调用方决定
    isDir: typeChar === 'd',
    isLink,
    size,
    mtime: deviceLocalToEpochMs(time.dateMs, opts.tzOffsetMinutes ?? 0),
    mode,
    owner: owner[1],
    group: group[1],
    // 元数据来自真实 ls 输出，不是占位值
    metaKnown: true,
  }
  if (isLink && linkTarget !== undefined) {
    entry.linkTarget = linkTarget
    const resolved = resolveLinkTarget(linkTarget, opts.dir)
    if (resolved !== undefined) entry.linkTargetResolved = resolved
  }
  return entry
}

/**
 * 解析 `ls -lA` 的输出。
 * 表头 total 行、空白行被忽略；其余无法解析的行计进 unparsed，不会静默丢弃。
 */
export function parseLsLongWithStats(text: string, opts: ParseOptions = {}): ParseStats {
  const entries: FileEntry[] = []
  const unparsedSamples: string[] = []
  let unparsed = 0
  // 用 split('\n') 后逐行抹掉一个 \r：adb 在 Windows 上会把 \n 翻成 \r\n
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim() === '') continue
    // total 行可能带前导空白，也可能不是第一行（多操作数时每段都有一个）
    if (/^\s*total\s+\d+\s*$/.test(line)) continue
    const entry = parseLine(line, opts)
    if (entry === undefined) {
      unparsed += 1
      if (unparsedSamples.length < MAX_UNPARSED_SAMPLES) unparsedSamples.push(line)
      continue
    }
    entries.push(entry)
  }
  return { entries, unparsed, unparsedSamples }
}

export function parseLsLong(text: string, opts: ParseOptions = {}): FileEntry[] {
  return parseLsLongWithStats(text, opts).entries
}

/* ============ stat 降级路径的解析 ============ */

/** stat 命令使用的格式：前 5 段定长语义，最后一段是名字（可能含 '|'）。 */
export const STAT_FORMAT = '%A|%U|%G|%s|%Y|%n'

/**
 * 解析 `stat -c '%A|%U|%G|%s|%Y|%n'` 的输出。
 * 只按前 5 个分隔符切分：文件名里可能有 '|'，切多了会把名字截断。
 * 无法识别的行（如 stat 的报错行）直接跳过，不抛错 —— 降级路径本来就是在凑合。
 */
export function parseStatWithFormat(text: string): FileEntry[] {
  const out: FileEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim() === '') continue
    const parts = line.split('|')
    if (parts.length < 6) continue
    const mode = parts[0]
    if (!/^[-dlbcps][rwxsStT-]{9}/.test(mode)) continue
    const size = Number(parts[3])
    const seconds = Number(parts[4])
    const name = parts.slice(5).join('|')
    if (!Number.isFinite(size) || !Number.isFinite(seconds)) continue
    if (name === '' || !isExpressible(name)) continue
    out.push({
      name,
      isDir: mode[0] === 'd',
      // 裁决 4：链接的 isDir 恒为 false
      isLink: mode[0] === 'l',
      size,
      mtime: seconds * 1000,
      mode: mode.slice(0, 10),
      owner: parts[1],
      group: parts[2],
      metaKnown: true,
    })
  }
  return out
}

/** 取路径最后一段（stat 给的是完整路径，列表里要的是名字）。 */
export function baseName(fullPath: string): string {
  const trimmed = fullPath.endsWith('/') && fullPath !== '/' ? fullPath.slice(0, -1) : fullPath
  const idx = trimmed.lastIndexOf('/')
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** 元数据未知的占位条目：名字一定对，其余字段不可信（metaKnown=false）。 */
export function unknownEntry(name: string): FileEntry {
  return { name, isDir: false, isLink: false, size: 0, mtime: 0, mode: '', owner: '', group: '', metaKnown: false }
}
