import type { FileEntry } from '../../src/shared/types'
import type { RunResult } from '../adb/client'
import { E_INVALID_PATH, shellQuote } from '../adb/shellsafe'
import {
  STAT_FORMAT,
  baseName,
  parseLsLongWithStats,
  parseStatWithFormat,
  unknownEntry,
} from '../adb/list-parser'

/**
 * 远程目录的读取与路径运算。
 *
 * 四条硬约束（都来自真机踩坑，见 task-5-report.md）：
 * 1. 所有动态路径必须经 shellQuote 转义；含 \n / \r / \0 的路径直接判非法，
 *    因为 adb shell 是单行文本协议，这类字符根本无法表达。
 * 2. 解析失败不是异常而是常态，必须降级：先解析 ls -lA，解析率过低时
 *    回退到 ls -1A + stat 逐项补齐；只有连降级都拿不到任何条目才抛错。
 * 3. 路径拼接必须防目录穿越：'..' 在根处夹住，绝不产生根以外的路径。
 * 4. **ls 退出码非 0 不等于目录打不开**：/proc/1 这类目录里个别子项无权限时
 *    仍会输出几十行合法条目、退出码却是 1。必须「先解析 stdout，再看退出码」，
 *    否则用户会看到「无权限」空页，整条降级链也一起失效。
 */

export { E_INVALID_PATH }

/** 目录不存在（且一个条目都没拿到）。 */
export const E_NOT_FOUND = 'E_NOT_FOUND'
/**
 * 路径存在，但不是目录（且一个条目都没拿到）。
 *
 * 【审查轮 3 / M2】修前与 E_NOT_FOUND 合并 —— 内核的 stderr 明明能区分
 * （"Not a directory" vs "No such file or directory"），合并后界面就无法区分
 * 「指向文件的快捷方式」与「断链」，只能一律猜「是文件」，文案必然说错。
 */
export const E_NOT_A_DIRECTORY = 'E_NOT_A_DIRECTORY'
/** 整个目录读不了（零条目 + 权限拒绝）。 */
export const E_NO_PERMISSION = 'E_NO_PERMISSION'
/** 连降级都凑不出任何条目：目录内容完全无法解读。 */
export const E_PARSE_DEGRADED = 'E_PARSE_DEGRADED'
/** ls 以非零码退出、零条目，且 stderr 里认不出已知原因。 */
export const E_LIST_FAILED = 'E_LIST_FAILED'

/** 未解析行占比超过这个阈值就触发降级。 */
export const PARSE_DEGRADE_RATIO = 0.2

/** listDir 的命令超时：大目录（上万条目）在低速 USB 上也可能要十几秒。 */
export const LIST_TIMEOUT_MS = 60_000

/** stat 批量补齐时单条命令的最大路径数与小节字符预算。 */
const STAT_BATCH_COUNT = 64
const STAT_BATCH_CHARS = 3_000

/** 单次 readlink 批量补齐的上限：链接很多时不再逐个回退，直接保留 isLink 无目标。 */
const READLINK_BATCH_COUNT = 64

/** 设备时区查询命令：输出形如 +0800。 */
export const TZ_COMMAND = 'date +%z'

/** 宿主时区偏移（分钟，东为正）。仅在拿不到设备时区时兜底。 */
function hostOffsetMinutes(): number {
  return -new Date().getTimezoneOffset()
}

/** 把 `date +%z` 的输出解析成分钟偏移；解析不出来返回 undefined。 */
export function parseTzOffset(text: string): number | undefined {
  const m = /^\s*([+-])(\d{2}):?(\d{2})\s*$/.exec(text)
  if (!m) return undefined
  const sign = m[1] === '-' ? -1 : 1
  const hours = Number(m[2])
  const minutes = Number(m[3])
  if (hours > 14 || minutes > 59) return undefined
  return sign * (hours * 60 + minutes)
}

/**
 * listDir 依赖的最小客户端契约（AdbClient 满足它）。
 * 单独抽出来是为了让测试可以注入假 adb，而不必起真进程。
 */
export interface ShellRunner {
  /** 设备 serial（AdbClient 有）。时区缓存按 serial 分桶，避免多设备串味。 */
  readonly serial?: string
  run(args: string[], opts: { adbPath: string; timeoutMs?: number }): Promise<RunResult>
}

export interface ListResult {
  entries: FileEntry[]
  /** 是否发生了降级（解析率过低、或走了 ls -1A + stat 兜底）。 */
  degraded: boolean
  /** ls -lA 里解析失败的条数。 */
  unparsed: number
  /** 是否真的执行了 ls -1A + stat 兜底。 */
  usedFallback: boolean
  /** ls 的退出码。非 0 但有条目属于「部分可读」，不是错误。 */
  exitCode: number | null
  /** 本次列举使用的设备时区偏移（分钟）。 */
  tzOffsetMinutes: number
}

/** 设备时区运行期不变，按「adb 路径 + serial」缓存，避免每次列目录都多跑一条命令。 */
const tzCache = new Map<string, number>()

/**
 * 取设备本地时区偏移（分钟，东为正）。
 * 查询失败时退回宿主偏移（产品上二者通常一致，且总比按 UTC 解释更接近真相）。
 */
export async function resolveDeviceTz(
  client: ShellRunner,
  adbPath: string,
): Promise<number> {
  const key = client.serial ?? adbPath
  const cached = tzCache.get(key)
  if (cached !== undefined) return cached
  try {
    const result = await client.run(['shell', TZ_COMMAND], { adbPath, timeoutMs: 10_000 })
    const parsed = parseTzOffset(result.stdout)
    if (parsed !== undefined) {
      tzCache.set(key, parsed)
      return parsed
    }
  } catch {
    // 取不到时区不是致命错误：退回宿主偏移，时间最多不准，目录照样能打开
  }
  return hostOffsetMinutes()
}

/** 清空时区缓存（测试用）。 */
export function clearDeviceTzCache(): void {
  tzCache.clear()
}

/**
 * 只清掉某台设备的时区缓存（裁决 6 / 任务 5 N1）。
 *
 * 调用时机：设备掉线或重连。设备时区运行期一般不变，但用户完全可能在拔插之间
 * 改掉设备的日期/时区 —— 不失效就会一直按旧偏移解释 ls 的时间列，列表时间整体偏移。
 * 缓存键是 serial（无 serial 时退化成 adbPath），所以这里按 serial 前缀清。
 */
export function clearDeviceSerialTzCache(serial: string): void {
  if (serial === '') return
  tzCache.delete(serial)
}

/** 拒收无法表达成 shell 单词的路径字符。 */
function assertExpressible(value: string): void {
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    throw new Error(E_INVALID_PATH)
  }
}

/** 折叠重复斜杠、消掉 '.' 与 '..'；'..' 在根处被夹住，不会逃出根。 */
function normalizeSegments(input: string): string {
  const segments: string[] = []
  for (const seg of input.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      segments.pop()
      continue
    }
    segments.push(seg)
  }
  return '/' + segments.join('/')
}

/**
 * 归一化一个目录路径：相对写法补前导斜杠、折叠重复斜杠、去掉尾斜杠、消掉点段。
 * 空串/纯空白/含控制字符一律抛 E_INVALID_PATH。
 */
export function normalizeDir(dir: string): string {
  assertExpressible(dir)
  if (dir.trim() === '') throw new Error(E_INVALID_PATH)
  return normalizeSegments(dir)
}

/**
 * 拼接目录与名字（裁决 3）。
 * - name 是绝对路径时直接采用（浏览绝对路径的场景）；
 * - name 为 '' 或 '.' 时返回基目录本身；
 * - '..' 在根处被夹住：joinPath('/', '..') === '/'。
 */
export function joinPath(base: string, name: string): string {
  assertExpressible(base)
  assertExpressible(name)
  if (name.startsWith('/')) return normalizeSegments(name)
  return normalizeSegments(base + '/' + name)
}

/**
 * 把目录变成 ls 的【操作数】：归一化后补尾斜杠（根除外）。
 *
 * ⚠️ 必须用它，不要自己拼路径：
 * `/sdcard`、`/storage/self/primary` 这些是**符号链接**。不带尾斜杠时
 * `ls -lA -- /sdcard` 只输出链接自身一行（`lrw-r--r-- ... /sdcard -> /storage/self/primary`），
 * 目录内容一条都列不出来；补上尾斜杠才会解引用成目录。任务 7（文件页）若自己拼
 * ls 命令，同样必须走本函数，否则用户点最常见入口 /sdcard 只会看到一个空页。
 */
export function lsOperand(dir: string): string {
  const normalized = normalizeDir(dir)
  return normalized === '/' ? '/' : normalized + '/'
}

function classifyError(stderr: string): string {
  if (/permission denied/i.test(stderr)) return E_NO_PERMISSION
  // 顺序有讲究：「Not a directory」里不含 "no such file"，但两者经常同时出现于
  // 各种 toybox 版本的复合消息里，所以先判更具体的那个。
  if (/not a directory/i.test(stderr)) return E_NOT_A_DIRECTORY
  if (/no such file or directory/i.test(stderr)) return E_NOT_FOUND
  return E_LIST_FAILED
}

/** 去重保序：只用于把 ls -1A 的名字与已解析条目对齐。 */
function uniqueNames(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const name = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (name === '') continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** 按「每条命令路径数 + 字符预算」把名字切成若干批，避免命令串超长。 */
function chunkNames(names: string[], dir: string): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let chars = 0
  for (const name of names) {
    const full = joinPath(dir, name)
    if (current.length >= STAT_BATCH_COUNT || (current.length > 0 && chars + full.length > STAT_BATCH_CHARS)) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(full)
    chars += full.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * 给链接条目批量补 linkTarget。
 *
 * readlink 逐条调用太慢，批量调用的输出又是「跳过非链接」而非按位置对齐，
 * 因此这里只把**已知是链接**（stat 的 %A 首字符是 l）的名字一起传：
 * 全是链接时 readlink 恰好一行一条，可以按位置对齐；行数对不上一律放弃，
 * 宁可不填 target 也不填错。
 */
async function fillLinkTargets(
  client: ShellRunner,
  adbPath: string,
  dir: string,
  links: string[],
): Promise<Map<string, string>> {
  const targets = new Map<string, string>()
  for (let i = 0; i < links.length; i += READLINK_BATCH_COUNT) {
    const batch = links.slice(i, i + READLINK_BATCH_COUNT)
    const passed = batch.map((name) => shellQuote(joinPath(dir, name)))
    let result: RunResult
    try {
      result = await client.run(['shell', 'readlink -- ' + passed.join(' ')], {
        adbPath,
        timeoutMs: LIST_TIMEOUT_MS,
      })
    } catch {
      continue
    }
    const lines = result.stdout.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    if (lines.length !== batch.length) continue
    for (let j = 0; j < batch.length; j++) {
      if (lines[j] !== '') targets.set(batch[j], lines[j])
    }
  }
  return targets
}

/**
 * 降级补齐：用 ls -1A 拿全量名字，用 stat -c 拿元数据。
 * ls -1A 完全失败才返回 undefined；stat 部分失败时逐条容错（I4）：
 * 成功的用真实值、失败的用 metaKnown=false 的占位条目。
 */
async function fallbackList(
  client: ShellRunner,
  adbPath: string,
  dir: string,
): Promise<FileEntry[] | undefined> {
  const namesResult = await client.run(['shell', 'LC_ALL=C ls -1A -- ' + shellQuote(lsOperand(dir))], {
    adbPath,
    timeoutMs: LIST_TIMEOUT_MS,
  })
  // 同 C1：有 stdout 就先认，退出码只用来决定「完全没有输出」时的错误
  const names = uniqueNames(namesResult.stdout)
  if (names.length === 0) return undefined

  const byName = new Map<string, FileEntry>()
  for (const batch of chunkNames(names, dir)) {
    const cmd = 'LC_ALL=C stat -c ' + shellQuote(STAT_FORMAT) + ' -- ' + batch.map(shellQuote).join(' ')
    const result = await client.run(['shell', cmd], { adbPath, timeoutMs: LIST_TIMEOUT_MS })
    // 真机实测：一批里个别路径失败时 stat 仍会输出其它成功行，退出码却是 1。
    // 因此这里不看退出码，只认 stdout —— 丢掉可用数据才是真正的错误。
    for (const entry of parseStatWithFormat(result.stdout)) {
      byName.set(baseName(entry.name), entry)
    }
  }

  const linkNames = names.filter((name) => byName.get(name)?.isLink === true)
  const linkTargets = linkNames.length > 0
    ? await fillLinkTargets(client, adbPath, dir, linkNames)
    : new Map<string, string>()

  return names.map((name) => {
    const found = byName.get(name)
    if (found === undefined) {
      // stat 也拿不到：占位条目，名字必须对（列表能打开比字段齐全重要），metaKnown=false 标明不可信
      return unknownEntry(name)
    }
    const entry: FileEntry = { ...found, name }
    if (entry.isLink) {
      const target = linkTargets.get(name)
      if (target !== undefined) {
        entry.linkTarget = target
        entry.linkTargetResolved = joinPath(dir, target)
      }
    }
    return entry
  })
}

/**
 * 列举远程目录。
 * 返回降级标志，让界面能提示「该目录部分内容可能不完整」，而不是直接打不开。
 */
export async function listDirDetailed(
  client: ShellRunner,
  adbPath: string,
  dir: string,
): Promise<ListResult> {
  const normalized = normalizeDir(dir)
  const tzOffsetMinutes = await resolveDeviceTz(client, adbPath)

  const listResult = await client.run(
    ['shell', 'LC_ALL=C ls -lA -- ' + shellQuote(lsOperand(normalized))],
    { adbPath, timeoutMs: LIST_TIMEOUT_MS },
  )

  const parsed = parseLsLongWithStats(listResult.stdout, { dir: normalized, tzOffsetMinutes })
  const total = parsed.entries.length + parsed.unparsed

  // C1：先解析 stdout 再判退出码。/proc/1 这类半可读目录会「有 49 行 + 退出码 1」，
  // 只要拿到了条目就必须返回；只有零条目 + 非零退出才是真的读不了。
  if (listResult.code !== 0 && total === 0) {
    throw new Error(classifyError(listResult.stderr))
  }

  if (total === 0) {
    return { entries: [], degraded: false, unparsed: 0, usedFallback: false, exitCode: listResult.code, tzOffsetMinutes }
  }

  const ratio = parsed.unparsed / total
  if (ratio <= PARSE_DEGRADE_RATIO) {
    return {
      entries: parsed.entries,
      degraded: false,
      unparsed: parsed.unparsed,
      usedFallback: false,
      exitCode: listResult.code,
      tzOffsetMinutes,
    }
  }

  // 裁决 2：解析率过低时不抛错，先尝试逐项补齐；补不齐就把已解析的部分返回并带 degraded。
  const filled = await fallbackList(client, adbPath, normalized)
  if (filled === undefined) {
    if (parsed.entries.length === 0) throw new Error(E_PARSE_DEGRADED)
    return {
      entries: parsed.entries,
      degraded: true,
      unparsed: parsed.unparsed,
      usedFallback: true,
      exitCode: listResult.code,
      tzOffsetMinutes,
    }
  }

  // ls -lA 已解析出的条目字段最全（stat 版没有 linkTargetResolved 等），同名条目以它为准
  const parsedByName = new Map(parsed.entries.map((entry) => [entry.name, entry]))
  const merged: FileEntry[] = filled.map((entry) => parsedByName.get(entry.name) ?? entry)
  const filledNames = new Set(filled.map((entry) => entry.name))
  for (const entry of parsed.entries) {
    if (!filledNames.has(entry.name)) merged.push(entry)
  }
  if (merged.length === 0) throw new Error(E_PARSE_DEGRADED)
  return {
    entries: merged,
    degraded: true,
    unparsed: parsed.unparsed,
    usedFallback: true,
    exitCode: listResult.code,
    tzOffsetMinutes,
  }
}

/**
 * 列举远程目录（只要条目）。
 * 降级策略见 listDirDetailed；只有完全无法解读时才抛 E_PARSE_DEGRADED。
 */
export async function listDir(client: ShellRunner, adbPath: string, dir: string): Promise<FileEntry[]> {
  return (await listDirDetailed(client, adbPath, dir)).entries
}