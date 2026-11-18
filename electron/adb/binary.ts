import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'

export type AdbSource = 'custom' | 'env' | 'bundled' | 'path'
export interface Candidate { path: string; source: AdbSource }

/** 候选路径都不存在（含 PATH 里没有 adb 的情况）。 */
export const E_ADB_NOT_FOUND = 'E_ADB_NOT_FOUND'
/** 文件存在但起不来：无执行权限、不是可执行镜像、spawn 同步抛错（含 Windows 的 EINVAL）。 */
export const E_ADB_NOT_EXECUTABLE = 'E_ADB_NOT_EXECUTABLE'
/** 进程起来了，但输出里解析不出任何 adb 版本行（或超时无输出）。 */
export const E_ADB_BAD_OUTPUT = 'E_ADB_BAD_OUTPUT'
/** 候选是 .cmd/.bat 批处理 shim，Node 24+ 直接 spawn 会抛 EINVAL，一律拒绝并继续试下一个。 */
export const E_ADB_SHIM_UNSUPPORTED = 'E_ADB_SHIM_UNSUPPORTED'

export type AdbErrorCode =
  | typeof E_ADB_NOT_FOUND
  | typeof E_ADB_NOT_EXECUTABLE
  | typeof E_ADB_BAD_OUTPUT
  | typeof E_ADB_SHIM_UNSUPPORTED

export interface CandidateInput {
  /** 用户自定义路径（最高优先级）。 */
  custom?: string
  /** 环境变量（如 ADB_PATH）给出的路径。 */
  env?: string
  /** Electron 的 process.resourcesPath，用于拼内置 platform-tools。 */
  resourcesPath: string
  /**
   * 仅用于注入/测试：覆盖用于解析 'path' 候选的 PATH 字符串。
   * 不传则读 process.env.PATH（Windows 上部分启动方式给出 'Path'，两个都认）；
   * 显式传空串表示「PATH 里什么都没有」。
   */
  pathEnv?: string
  /** 仅用于注入/测试：覆盖 Windows 的 PATHEXT。 */
  pathext?: string
}

/** 已成功解析的 adb。 */
export interface ResolvedAdb {
  path: string
  source: AdbSource
  version: string
  build: string
}

/** 单个候选的探测结果；成功时 code 为 undefined。 */
export interface ResolveAttempt {
  path: string
  source: AdbSource
  ok: boolean
  code?: AdbErrorCode
}

export interface ResolveResult {
  /** 第一个通过的候选；全部失败为 null。 */
  resolved: ResolvedAdb | null
  /** 按顺序记录每个候选的结论，供界面提示「试过哪些、为什么不行」。 */
  attempts: ResolveAttempt[]
}

export type ProbeResult =
  | { ok: true; version: string; build: string }
  | { ok: false; code: AdbErrorCode }

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000
/** Windows 默认 PATHEXT；环境变量缺失时用它兜底。 */
export const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * 把裸名（如 'adb'）在 PATH 里解析成绝对路径。
 *
 * 为什么非做不可：spawn 会自己走 PATH，但那样拿回来的进程可能来自一个 .cmd shim，
 * 而 shim 必须在 spawn 之前就识别出来（Node 24+ 对它抛 EINVAL，Node 22 会真的执行批处理）。
 * 先解析成带扩展名的绝对路径，扩展名才可见，isShimPath 才有得判。
 */
function resolveOnPath(name: string, pathEnv: string | undefined, pathext: string): string {
  // 缺省必须回到真实 PATH：否则 'path' 候选会退回裸名交给 spawn，
  // 而 spawn 自己走 PATH 时拿不到扩展名，.cmd shim 就永远拦不住。
  const raw = pathEnv ?? process.env.PATH ?? process.env.Path ?? ''
  const dirs = raw.split(path.delimiter).filter(Boolean)
  const exts = process.platform === 'win32'
    ? [''].concat(pathext.split(';').filter(Boolean))
    : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // 该目录不可读或文件不存在：继续找下一个
      }
    }
  }
  // 解析不到就退回裸名：交给 spawn，由它给出 ENOENT
  return name
}

/**
 * 按 custom > env > bundled > path 的顺序给出候选。
 * path 候选在这里仍是裸名 'adb'，由 resolveAdb 在探测前解析成绝对路径 ——
 * 只有拿到扩展名，.cmd/.bat shim 才能在 spawn 之前被识别并拒绝。
 */
export function buildCandidates(input: CandidateInput): Candidate[] {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb'
  const list: Candidate[] = []
  if (input.custom) list.push({ path: input.custom, source: 'custom' })
  if (input.env) list.push({ path: input.env, source: 'env' })
  list.push({ path: path.join(input.resourcesPath, 'platform-tools', exe), source: 'bundled' })
  list.push({ path: 'adb', source: 'path' })
  return list
}

/**
 * 解析 adb version 输出。两种格式都兼容，缺哪个字段就返回空串，绝不抛错：
 * 老版：`Android Debug Bridge version 1.0.41`
 * 新版：单独一行 `Version 35.0.2-12147458`
 * 注意正则区分大小写：老版那行是小写 version，不能被 build 的正则吃掉。
 */
export function parseVersion(stdout: string): { version: string; build: string } {
  const v = /Android Debug Bridge version ([\d.]+)/.exec(stdout)?.[1] ?? ''
  const b = /Version ([\w.\-]+)/.exec(stdout)?.[1] ?? ''
  return { version: v, build: b }
}

/** 是否是 .cmd/.bat shim。扩展名判断大小写无关。 */
export function isShimPath(adbPath: string): boolean {
  const ext = path.extname(adbPath).toLowerCase()
  return ext === '.cmd' || ext === '.bat'
}

/**
 * 真的执行一次 `adb version` 并解析输出，作为自检的唯一真实证据。
 * 不做任何重试：候选筛选靠上层 resolveAdb 逐个试。
 */
export async function probe(
  adbPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<ProbeResult> {
  // 1) shim 必须先于 spawn 拦下：Windows 上 .cmd/.bat 由 cmd.exe 解释，
  //    Node 24+ 为修 CVE-2024-27980 直接抛 EINVAL，Node 22 则会真执行一个批处理脚本 —— 两种都不能接受。
  if (isShimPath(adbPath)) {
    return { ok: false, code: E_ADB_SHIM_UNSUPPORTED }
  }

  // 2) 带路径分隔符的候选可以在 spawn 前判存在性，错误码更准确；
  //    裸名（'adb'）必须交给 spawn 走 PATH 解析，不能在这里判文件存在。
  if (path.isAbsolute(adbPath) || adbPath.includes('/') || adbPath.includes('\\')) {
    let stat
    try {
      stat = statSync(adbPath)
    } catch {
      return { ok: false, code: E_ADB_NOT_FOUND }
    }
    if (!stat.isFile()) return { ok: false, code: E_ADB_NOT_EXECUTABLE }
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS

  return new Promise<ProbeResult>((resolve) => {
    let child
    try {
      child = spawn(adbPath, ['version'], { windowsHide: true })
    } catch {
      // Windows 上「文件存在但不是可执行镜像」会同步抛错（code 可能是 UNKNOWN / EINVAL）
      resolve({ ok: false, code: E_ADB_NOT_EXECUTABLE })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }

    // setEncoding 走 StringDecoder，避免多字节字符跨 chunk 被切成 U+FFFD
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (text: string) => { stdout += text })
    child.stderr?.on('data', (text: string) => { stderr += text })

    child.on('error', (err: NodeJS.ErrnoException) => {
      const code = err.code === 'ENOENT' ? E_ADB_NOT_FOUND : E_ADB_NOT_EXECUTABLE
      finish({ ok: false, code })
    })

    child.on('close', () => {
      const parsed = parseVersion(stdout + stderr)
      // 两种格式任一对上就算成功：新版输出可能只有 Version 行、没有 Android Debug Bridge version 行
      if (parsed.version === '' && parsed.build === '') {
        finish({ ok: false, code: E_ADB_BAD_OUTPUT })
        return
      }
      finish({ ok: true, version: parsed.version, build: parsed.build })
    })

    timer = setTimeout(() => {
      // adb version 是毫秒级命令；超时只可能是候选挂了，按「无法用于自检」处理
      child.kill()
      finish({ ok: false, code: E_ADB_BAD_OUTPUT })
    }, timeoutMs)
  })
}

/**
 * 逐个探测候选，返回第一个可用者。
 * 关键约束：不可用的候选只标记、不抛错，继续试下一个 —— 用户的 custom 路径常常是失效的 scoop/npm shim。
 */
export async function resolveAdb(
  input: CandidateInput,
  opts: { timeoutMs?: number } = {},
): Promise<ResolveResult> {
  const attempts: ResolveAttempt[] = []
  for (const candidate of buildCandidates(input)) {
    // 'path' 候选是裸名：先解析成绝对路径，shim 才可能在 spawn 前被拦下
    const target = candidate.source === 'path'
      ? resolveOnPath(candidate.path, input.pathEnv, input.pathext ?? DEFAULT_PATHEXT)
      : candidate.path
    const result = await probe(target, opts)
    if (result.ok) {
      attempts.push({ path: target, source: candidate.source, ok: true })
      return {
        resolved: {
          path: target,
          source: candidate.source,
          version: result.version,
          build: result.build,
        },
        attempts,
      }
    }
    attempts.push({ path: target, source: candidate.source, ok: false, code: result.code })
  }
  return { resolved: null, attempts }
}
