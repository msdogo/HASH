import { statSync, existsSync } from 'node:fs'
import { cleanupPartFile, makePartPath, promotePartFile } from './atomic'
import { AdbClient, E_ABORTED, type RunResult } from '../adb/client'
import { E_INVALID_PATH, shellQuote } from '../adb/shellsafe'
import { E_ADB_NOT_FOUND, E_NO_PERMISSION, E_NOT_FOUND, E_SYNC_FAILED, E_TIMEOUT } from '../../src/shared/errors'
import { joinPath } from '../fs/remote'
import type { Direction } from '../../src/shared/transfer'
import { parseTransferSummary } from '../../src/shared/transfer'

/**
 * 传输执行层：把「一个任务」真正跑成 adb 命令（裁决 1 / 5 / 9）。
 *
 * ===== 裁决 1 的真机事实（决定了这里的每一个设计选择）=====
 * adb 1.0.41 的 push/pull **不输出百分比**：全程 stderr 里只有结束时的一行汇总。
 * 真机抓到的原始字节，例如
 *   big-400r.bin: 1 file pushed, 0 skipped. 27.0 MB/s (419430400 bytes in 14.835s)CRLF
 * —— 一个 14.8 秒、400MB 的传输，从头到尾就只有这一行。
 *
 * 所以本模块的进度来源是：
 *   1. **主通道：轮询目标文件大小**。push 轮询【设备上】的文件（走 shell stat），
 *      pull 轮询【本地】正在写的文件（走 fs.statSync）。实测 0.5s 一次能拿到
 *      单调递增的真实字节数（31ms→2MB、607ms→23MB…），足够画出可信进度条。
 *   2. **校正通道：汇总行**。传输结束时解析汇总行拿权威字节数，
 *      用它把最终 doneBytes 校正到精确值 —— 轮询总有最后一次采样滞后。
 *
 * 不做的事（明确记录，避免后来者以为漏了）：
 *   - **不做断点续传**（ADR-04：adb 协议不支持）。cancel/retry 一律从头再来，
 *     所以这里没有任何 offset / seek / resume 的残余接口。
 *   - 不用 -q：汇总行是唯一的权威字节数来源，禁掉它我们就只剩估算。
 */

/** 轮询间隔（毫秒）。实测 500ms 既够画进度条，又不会把 adb 通道挤满。 */
export const PROGRESS_POLL_MS = 500

/** 传输命令的超时：大文件（数 GB）在低速 USB 上可能跑几十分钟，这里给足。 */
export const TRANSFER_TIMEOUT_MS = 6 * 60 * 60 * 1000

/** 执行所需的依赖。 */
export interface RunnerDeps {
  /**
   * 取【当前】adb 绝对路径，**每次执行时现取**。
   *
   * 【审查 C1】这里原来是一个 string，由构造函数取值固化。
   * 生产装配（main.ts）在模块顶层就 new TransferService，那一刻 adb 自检还是
   * checking，getter 返回 ''，于是 runner 里永久存着 ''；
   * 之后自检成功也再没人更新它 → spawn('') 抛 ERR_INVALID_ARG_VALUE
   * → 被 catch 吞成 E_SYNC_FAILED → **真实应用里每一次传输都必然失败**。
   * 单测全部注入了 runner 或直接用 createTransferRunner，恰好绕开了这条路径。
   *
   * 改成 getter 后，「构造时未就绪、执行时已就绪」能正常工作。
   * 注释里原本就写着这个意图，但代码没做到 —— 现在代码与注释一致。
   */
  adbPath: () => string
  /**
   * 按 serial 造 client。
   * 单独注入而不是直接收一个 client，是为了让一个 runner 服务多台设备。
   */
  clientFor: (serial: string) => AdbClient
  /** 轮询间隔（测试可缩短）。 */
  pollMs?: number
  /** 等待实现（测试可替换，避免真计时）。 */
  sleep?: (ms: number) => Promise<void>
}

/** 一次传输的输入。 */
export interface TransferRun {
  /**
   * 任务 id。
   *
   * 执行层**不拿它改状态**（状态只由调度层持有），它只用于关联日志/诊断，
   * 以及让可注入的假执行器能对上是哪一个任务（并发测试要靠它断言顺序）。
   */
  id: string
  serial: string
  direction: Direction
  /** push 时是本地路径；pull 时是远程路径。 */
  src: string
  /** push 时是远程路径；pull 时是本地路径。 */
  dst: string
  totalBytes: number | null
}

/** 进度回调；totalBytes 为 null 表示不确定态（裁决 5）。 */
export type ProgressSink = (doneBytes: number, totalBytes: number | null) => void

/** 执行结果。 */
export type RunOutcome =
  | { ok: true; bytes: number; overwrote: boolean }
  | { ok: false; code: string }

/** 执行环境（由 manager 提供）。 */
export interface RunContext {
  /** 取消信号：abort 时 AdbClient 会 killTree 并 reject E_ABORTED（裁决 2/3）。 */
  signal: AbortSignal
  onProgress: ProgressSink
}

/**
 * 把 stat 输出（或任意数字串）解析成字节数。
 *
 * 为什么不能直接 Number()：超过 MAX_SAFE_INTEGER 时 Number 会**静默丢精度**
 * （9007199254740993 变成 9007199254740992），据此算出的百分比是错的。
 * 这种大小在手机上不可能出现，但裁决 5 要求「不能溢出」，所以这里显式判掉，
 * 返回 null 走不确定态 —— 宁可显示「大小未知」，也不显示一个错的百分比。
 */
export function parseByteCount(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null
    if (!Number.isSafeInteger(value)) return null
    return value
  }
  if (typeof value !== 'string') return null
  const text = value.replace(/[\r\n]/g, '').trim()
  if (text === '' || !/^\d+$/.test(text)) return null
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed)) return null
  return parsed
}

/**
 * 按退出码 + stderr 归类失败原因。
 *
 * 真机 stderr 实测样本（均来自 adb 1.0.41）：
 *   adb: error: failed to stat remote object '/sdcard/x.bin': No such file or directory
 *   adb: error: failed to copy: ... Permission denied
 * 返回 null 表示成功（退出码 0）。
 */
export function classifyTransferError(code: number | null, stderr: string): string | null {
  if (code === 0) return null
  if (/permission denied/i.test(stderr)) return E_NO_PERMISSION
  if (/no such file or directory/i.test(stderr)) return E_NOT_FOUND
  return E_SYNC_FAILED
}

/**
 * 默认 sleep。
 *
 * 【刻意不 unref】最初这里调了 timer.unref()（想「别挂住进程退出」），实测直接
 * 造成假死：unref 的定时器不算「有待办」，事件循环在轮询等待期间没有任何被引用的
 * handle 时进程会直接退出（tsx 下表现为 "unsettled top-level await"）。
 * 真正的退出安全由调用方保证 —— 轮询循环由 polling 标志明确终止，且 run() 在
 * 返回前一定 await 了 pollingPromise，不存在「挂着定时器不让退出」的情况。
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 设备侧单个路径的大小（走 shell stat）。拿不到返回 null。 */
async function remoteSize(client: AdbClient, adbPath: string, remotePath: string): Promise<number | null> {
  let quoted: string
  try {
    quoted = shellQuote(remotePath)
  } catch {
    return null
  }
  try {
    const result = await client.run(['shell', 'stat -c %s -- ' + quoted], { adbPath, timeoutMs: 15_000 })
    if (result.code !== 0) return null
    return parseByteCount(result.stdout)
  } catch {
    // 轮询失败不能影响传输本身：拿不到就是不确定态
    return null
  }
}

/** 本地文件大小。拿不到（还不存在 / 已删除）返回 null。 */
function localSize(localPath: string): number | null {
  try {
    if (!existsSync(localPath)) return null
    const info = statSync(localPath)
    if (!info.isFile()) return null
    return parseByteCount(info.size)
  } catch {
    return null
  }
}

/**
 * 远程路径是否已存在（覆盖提示用，裁决 7）。
 * 探测失败返回 false —— 不能因为探测不出来就阻止传输。
 */
async function remoteExists(client: AdbClient, adbPath: string, remotePath: string): Promise<boolean> {
  let quoted: string
  try {
    quoted = shellQuote(remotePath)
  } catch {
    return false
  }
  try {
    const result = await client.run(['shell', 'test -e ' + quoted + ' && echo yes'], {
      adbPath,
      timeoutMs: 15_000,
    })
    return result.stdout.includes('yes')
  } catch {
    return false
  }
}

/** 传输执行器。 */
export class TransferRunner {
  constructor(private readonly deps: RunnerDeps) {}

  /**
   * 组一个 push 任务（远程目标是完整路径）。
   * totalBytes 必须由调用方给出（push 走本地 stat，调用方知道的比执行层早）。
   */
  createPush(id: string, serial: string, localPath: string, remotePath: string, totalBytes: number | null): TransferRun {
    return { id, serial, direction: 'push', src: localPath, dst: remotePath, totalBytes }
  }

  /** 组一个 pull 任务（本地目标是完整路径）。 */
  createPull(id: string, serial: string, remotePath: string, localPath: string, totalBytes: number | null): TransferRun {
    return { id, serial, direction: 'pull', src: remotePath, dst: localPath, totalBytes }
  }

  /**
   * 预先取 totalBytes（裁决 5）。
   * push 用本地 stat；pull 用远程 stat。拿不到就返回 null（界面走不确定态）。
   */
  async resolveTotalBytes(direction: Direction, src: string, serial: string): Promise<number | null> {
    if (direction === 'push') return localSize(src)
    return remoteSize(this.deps.clientFor(serial), this.deps.adbPath(), src)
  }

  /**
   * 跑完一个传输。
   *
   * 关键点：
   * - 取消只走 ctx.signal；AdbClient 在 abort 时会 killTree 并 reject E_ABORTED，
   *   所以这里不自己持 child 句柄（免得两处都能杀进程、责任含糊）。
   * - 进度轮询与 adb 命令并行跑，互不阻塞。
   * - 结束后用汇总行的字节数校正最终值。
   */
  async run(task: TransferRun, ctx: RunContext): Promise<RunOutcome> {
    const client = this.deps.clientFor(task.serial)
    // 【审查 C1】每次 run 现取，绝不在构造时固化：
    // 服务在 adb 自检完成之前就构造好了，那一刻路径还是空串。
    const adbPath = this.deps.adbPath()
    if (adbPath === '') {
      // 明确失败而不是让 spawn('') 抛 ERR_INVALID_ARG_VALUE 再被吞成 E_SYNC_FAILED：
      // 「adb 还没就绪」与「传输失败」对用户是两件事，错误码必须能区分。
      return { ok: false, code: E_ADB_NOT_FOUND }
    }
    const pollMs = this.deps.pollMs ?? PROGRESS_POLL_MS
    const sleep = this.deps.sleep ?? defaultSleep

    // 路径必须能表达成 shell 单词（含 \n / \r / \0 直接判非法）
    try {
      shellQuote(task.src)
      shellQuote(task.dst)
    } catch {
      return { ok: false, code: E_INVALID_PATH }
    }

    /*
     * 【审查 I2】一律先写临时文件，成功后再原子改名到目标名。
     *
     * 修前直接写目标名，而 adb 是「先截断目标再写」：
     * 取消/中断会留下一个同名截断文件；若原来是覆盖已有文件，
     * **旧文件已经被截断**，等于既没传完又把原文件毁了（数据丢失级）。
     * 现在目标文件在传输成功之前完全不会被碰。
     */
    const partPath = makePartPath(task.dst)

    // 覆盖提示（裁决 7）：默认覆盖，但要告诉用户覆盖了。
    // 探测失败一律当「不存在」，绝不因为探测问题阻止传输。
    // 探测的是【最终目标】而不是临时文件 —— 用户关心的是会不会盖掉他的东西。
    const preexisting =
      task.direction === 'push'
        ? await remoteExists(client, adbPath, task.dst)
        : existsSync(task.dst)

    // 传输写到临时路径
    const args = task.direction === 'push'
      ? ['push', task.src, partPath]
      : ['pull', task.src, partPath]

    let polling = true
    let lastDone = 0

    const pollLoop = async (): Promise<void> => {
      while (polling) {
        await sleep(pollMs)
        if (!polling) return
        // 轮询的是【临时文件】：内容先落到 .adbfm-part，改名之后才叫目标名。
        // 盯错对象会让进度一直读到旧目标文件的大小（甚至读到 0）。
        const size = task.direction === 'push'
          ? await remoteSize(client, adbPath, partPath)
          : localSize(partPath)
        if (size === null) continue
        // 单调：轮询偶尔会读到旧值（缓存/延迟），回退会让进度条来回跳
        if (size < lastDone) continue
        lastDone = size
        ctx.onProgress(size, task.totalBytes)
      }
    }

    const pollingPromise = pollLoop()

    let result: RunResult
    try {
      result = await client.run(args, {
        adbPath,
        timeoutMs: TRANSFER_TIMEOUT_MS,
        signal: ctx.signal,
      })
    } catch (err) {
      polling = false
      await pollingPromise
      // 【审查 I2】取消/失败：只删临时文件，目标文件保持原样
      await this.discardPart(client, adbPath, task.direction, partPath)
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes(E_ABORTED)) return { ok: false, code: E_ABORTED }
      if (message.includes(E_TIMEOUT)) return { ok: false, code: E_TIMEOUT }
      return { ok: false, code: E_SYNC_FAILED }
    } finally {
      polling = false
    }
    await pollingPromise

    const failed = classifyTransferError(result.code, result.stderr)
    if (failed !== null) {
      await this.discardPart(client, adbPath, task.direction, partPath)
      return { ok: false, code: failed }
    }

    /*
     * 传输成功 → 把临时文件原子改名成目标名。
     *
     * 这是 I2 的另一半：正因为写的是临时名，这里改名才是「一次性生效」的，
     * 用户永远看不到「目标文件只写了一半」的中间态。
     */
    const promoted = await this.promote(client, adbPath, task.direction, partPath, task.dst)
    if (!promoted) {
      await this.discardPart(client, adbPath, task.direction, partPath)
      return { ok: false, code: E_SYNC_FAILED }
    }

    // 汇总行在 stderr（真机实测），不在 stdout
    const summary = parseTransferSummary(result.stderr)
    const bytes = summary?.bytes ?? task.totalBytes ?? lastDone
    ctx.onProgress(bytes, task.totalBytes)

    return { ok: true, bytes, overwrote: preexisting }
  }

  /**
   * 把临时文件改名为目标文件。
   *
   * push：设备侧改名，走 adb shell mv。必须用 shellQuote —— 文件名可以有中文、
   *       空格、括号，不转义会被 shell 拆成多个单词。
   * pull：本地改名，fs.renameSync 在同一文件系统上是原子的。
   *
   * 返回是否成功。失败时调用方负责清理临时文件。
   */
  private async promote(
    client: AdbClient,
    adbPath: string,
    direction: Direction,
    partPath: string,
    targetPath: string,
  ): Promise<boolean> {
    if (direction === 'pull') {
      try {
        promotePartFile(partPath, targetPath)
        return true
      } catch {
        return false
      }
    }
    try {
      // -f：目标已存在时直接覆盖（这正是裁决 7 的「默认覆盖」）
      const result = await client.run(
        ['shell', 'mv -f -- ' + shellQuote(partPath) + ' ' + shellQuote(targetPath)],
        { adbPath, timeoutMs: 60_000 },
      )
      return result.code === 0
    } catch {
      return false
    }
  }

  /**
   * 丢弃临时文件（取消 / 失败路径）。
   *
   * 红线：**只删临时文件，绝不碰目标文件**。这是 I2 的核心不变量 ——
   * 覆盖场景下目标就是用户的原文件，删了就真没了。
   *
   * 这里刻意用独立的 adb 命令而不是 ctx.signal 上的那个进程：
   * 传输进程已经被 abort 杀掉了，清理必须另起一条（且不带 signal）。
   */
  private async discardPart(
    client: AdbClient,
    adbPath: string,
    direction: Direction,
    partPath: string,
  ): Promise<void> {
    if (direction === 'pull') {
      cleanupPartFile(partPath)
      return
    }
    try {
      await client.run(['shell', 'rm -f -- ' + shellQuote(partPath)], {
        adbPath,
        timeoutMs: 30_000,
      })
    } catch {
      // 清理失败不该覆盖掉真正的失败原因：残留的 .adbfm-part 有固定后缀，
      // 既会被下次传输覆盖，也能被用户/诊断识别出来。
    }
  }
}

/**
 * 造一个 runner（clientFor 缺省用 AdbClient）。
 *
 * adbPath 既接受 string 也接受 getter：传 string 是最常见的便利写法，
 * 内部包成常量 getter —— 但**生产代码必须传 getter**，
 * 否则就退回 C1 那个「构造时固化空路径」的坑。
 */
export function createTransferRunner(deps: {
  adbPath: string | (() => string)
  clientFor?: (serial: string) => AdbClient
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}): TransferRunner {
  const resolvePath = typeof deps.adbPath === 'function' ? deps.adbPath : () => deps.adbPath as string
  return new TransferRunner({
    adbPath: resolvePath,
    clientFor: deps.clientFor ?? ((serial: string) => new AdbClient(serial)),
    pollMs: deps.pollMs,
    sleep: deps.sleep,
  })
}

/** 把「目录 + 名字」拼成完整目标路径（复用 fs/remote 的路径归一化）。 */
export function transferTargetPath(dir: string, name: string): string {
  return joinPath(dir, name)
}
