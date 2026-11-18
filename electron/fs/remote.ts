import type { FileEntry } from '../../src/shared/types'
import type { RunResult } from '../adb/client'
import { E_INVALID_PATH, shellQuote } from '../adb/shellsafe'
import { STAT_FORMAT, baseName, parseLsLongWithStats, parseStatWithFormat } from '../adb/list-parser'

/**
 * 远程目录的读取与路径运算。
 *
 * 三条硬约束（都来自真机踩坑，见 task-5-report.md）：
 * 1. 所有动态路径必须经 shellQuote 转义；含 \n / \r / \0 的路径直接判非法，
 *    因为 adb shell 是单行文本协议，这类字符根本无法表达。
 * 2. 解析失败不是异常而是常态，必须降级：先解析 ls -lA，解析率过低时
 *    回退到 ls -1A + stat 逐项补齐；只有连降级都拿不到任何条目才抛错。
 * 3. 路径拼接必须防目录穿越：'..' 在根处夹住，绝不产生根以外的路径。
 */

export { E_INVALID_PATH }

/** 目录不存在或不是目录。 */
export const E_NOT_FOUND = 'E_NOT_FOUND'
/** 设备侧权限不足。 */
export const E_NO_PERMISSION = 'E_NO_PERMISSION'
/** 连降级都凑不出任何条目：目录内容完全无法解读。 */
export const E_PARSE_DEGRADED = 'E_PARSE_DEGRADED'
/** ls 以非零码退出，但 stderr 里认不出已知原因。 */
export const E_LIST_FAILED = 'E_LIST_FAILED'

/** 未解析行占比超过这个阈值就触发降级。 */
export const PARSE_DEGRADE_RATIO = 0.2

/** listDir 的命令超时：大目录（上万条目）在低速 USB 上也可能要十几秒。 */
export const LIST_TIMEOUT_MS = 60_000

/** stat 批量补齐时单条命令的最大路径数与小节字符预算。 */
const STAT_BATCH_COUNT = 64
const STAT_BATCH_CHARS = 3_000

/**
 * listDir 依赖的最小客户端契约（AdbClient 满足它）。
 * 单独抽出来是为了让测试可以注入假 adb，而不必起真进程。
 */
export interface ShellRunner {
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

/** ls 的目录操作数：整体归一化后补尾斜杠，操作数本身是符号链接时才能列出目录内容。 */
function lsOperand(normalized: string): string {
  return normalized === '/' ? '/' : normalized + '/'
}

function classifyError(stderr: string): string {
  if (/permission denied/i.test(stderr)) return E_NO_PERMISSION
  if (/no such file or directory|not a directory/i.test(stderr)) return E_NOT_FOUND
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

/**
 * 降级补齐：用 ls -1A 拿全量名字，用 stat -c 拿元数据。
 * 任一环节失败都返回 undefined —— 降级是「尽力而为」，不是必须成功的新依赖。
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
  if (namesResult.code !== 0) return undefined
  const names = uniqueNames(namesResult.stdout)
  if (names.length === 0) return undefined

  const byName = new Map<string, FileEntry>()
  for (const batch of chunkNames(names, dir)) {
    const cmd = 'LC_ALL=C stat -c ' + shellQuote(STAT_FORMAT) + ' -- ' + batch.map(shellQuote).join(' ')
    const result = await client.run(['shell', cmd], { adbPath, timeoutMs: LIST_TIMEOUT_MS })
    if (result.code !== 0) return undefined
    for (const entry of parseStatWithFormat(result.stdout)) {
      byName.set(baseName(entry.name), entry)
    }
  }
  return names.map((name) => {
    const found = byName.get(name)
    // stat 给的 name 是完整路径，列表里必须是裸名字
    if (found !== undefined) return { ...found, name }
    // stat 也拿不到：给一个字段保守的占位，名字必须是对的（列表能打开比字段齐全重要）
    return { name, isDir: false, isLink: false, size: 0, mtime: 0, mode: '', owner: '', group: '' }
  })
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
 * 列举远程目录。
 * 返回降级标志，让界面能提示「该目录部分内容可能不完整」，而不是直接打不开。
 */
export async function listDirDetailed(
  client: ShellRunner,
  adbPath: string,
  dir: string,
): Promise<ListResult> {
  const normalized = normalizeDir(dir)

  const listResult = await client.run(
    ['shell', 'LC_ALL=C ls -lA -- ' + shellQuote(lsOperand(normalized))],
    { adbPath, timeoutMs: LIST_TIMEOUT_MS },
  )
  if (listResult.code !== 0) {
    throw new Error(classifyError(listResult.stderr))
  }

  const parsed = parseLsLongWithStats(listResult.stdout, { dir: normalized })
  const total = parsed.entries.length + parsed.unparsed
  if (total === 0) {
    return { entries: [], degraded: false, unparsed: 0, usedFallback: false }
  }

  const ratio = parsed.unparsed / total
  if (ratio <= PARSE_DEGRADE_RATIO) {
    return { entries: parsed.entries, degraded: false, unparsed: parsed.unparsed, usedFallback: false }
  }

  // 裁决 2：解析率过低时不抛错，先尝试逐项补齐；补不齐就把已解析的部分返回并带 degraded。
  const filled = await fallbackList(client, adbPath, normalized)
  if (filled === undefined) {
    if (parsed.entries.length === 0) throw new Error(E_PARSE_DEGRADED)
    return { entries: parsed.entries, degraded: true, unparsed: parsed.unparsed, usedFallback: true }
  }

  // ls -lA 已解析出的条目字段最全（stat 版丢了 linkTarget 等），同名条目以它为准
  const parsedByName = new Map(parsed.entries.map((entry) => [entry.name, entry]))
  const merged: FileEntry[] = filled.map((entry) => parsedByName.get(entry.name) ?? entry)
  const filledNames = new Set(filled.map((entry) => entry.name))
  for (const entry of parsed.entries) {
    if (!filledNames.has(entry.name)) merged.push(entry)
  }
  if (merged.length === 0) throw new Error(E_PARSE_DEGRADED)
  return { entries: merged, degraded: true, unparsed: parsed.unparsed, usedFallback: true }
}

/**
 * 列举远程目录（只要条目）。
 * 降级策略见 listDirDetailed；只有完全无法解读时才抛 E_PARSE_DEGRADED。
 */
export async function listDir(client: ShellRunner, adbPath: string, dir: string): Promise<FileEntry[]> {
  return (await listDirDetailed(client, adbPath, dir)).entries
}
