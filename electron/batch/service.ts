import { statSync } from 'node:fs'
import type { DeviceSession } from '../../src/shared/types'
import type { BatchItemResult, BatchRunData } from '../../src/shared/batch'
import {
  createStdoutBudget,
  DETAIL_LIMIT_BYTES,
  SHELL_STDOUT_LIMIT_BYTES,
  truncateUtf8,
} from '../../src/shared/batch'
import {
  E_ADB_NOT_FOUND,
  E_BAD_ARGS,
  E_BAD_COMMAND,
  E_BATCH_PARAM,
  E_DEVICE_OFFLINE,
  E_NO_PERMISSION,
  E_NO_SPACE,
  E_NOT_A_DIRECTORY,
  E_NOT_FOUND,
  E_OP_FAILED,
  E_PROTECTED_PATH,
  E_SYNC_FAILED,
  toErrorCode,
} from '../../src/shared/errors'
import { checkRemotePath, isProtectedTransferDirectory } from '../../src/shared/path-guard'
import { E_STDOUT_LIMIT } from '../adb/client'
import { shellQuote } from '../adb/shellsafe'
import type { ShellRunner } from '../fs/remote'
import { checkLocalAccess } from '../fs/local'
import type { EnqueueIntent } from '../transfer/service'
import type { TransferTask } from '../../src/shared/transfer'
import { runBatch } from './runner'

/**
 * 批量动作服务层（任务 10）。
 *
 * ===== 这一层为什么存在 =====
 * IPC handler 不该知道「离线设备要先跳过」「apk 要先校验一次再发给 N 台」
 * 「截图必须经传输队列而不是读 stdout」这些规则；runBatch 也不该知道 adb。
 * 把「一次意图 → N 台设备 → 每台一条结果」的编排收在这里，规则只有一处实现，
 * 于是它能被一组假 client 测试完整覆盖（tests/batch-service.test.ts）。
 *
 * ===== 裁决落点（都能在本文件里指出来）=====
 * R1 截图：screencap 写到 SHOT_TEMP_DIR 的临时文件 → transfer.enqueue(pull)
 *          → 任务进入终态后 rm -f 清理；入队就失败时在 finally 里立即清。
 *          绝不读 stdout：electron/adb/client.ts 是 setEncoding('utf8')，
 *          二进制跨 chunk 会被 StringDecoder 拼坏（任务 2 修过的 Critical）。
 * R2 推送：只对每台设备 enqueue 任务就返回「已加入队列」，不自己管并发。
 * R3 runBatch（并发 3）只用于 screenshot / install / shell。
 * R5 离线/未授权：status !== 'device' 的设备在**发命令之前**就产生结果，零 adb 命令。
 * R7 参数错：apk 不存在 / 目标目录非法 / 命令为空 —— 在 runBatch 之前校验一次，
 *    整批失败，而不是让 N 台设备各报一次同样的错。
 * R8 输出截断：流式封顶 8 KB（复审 I3），矩阵 detail 512 字节。
 *
 * ===== 复审后的两个结构性变化 =====
 * I1：截图临时文件的清理不再只依赖「任务进终态」这一个出口 ——
 *     每台设备截图前先扫掉陈旧残留，且 dispose() 会把未结算的登记全部执行。
 * I2：落点改成隐藏目录 /sdcard/.adbfm（闸门实测放行），用户翻不到。
 */

/** 执行命令超时（简报：shell 30s）。 */
export const SHELL_TIMEOUT_MS = 30_000
/** 安装超时（简报：install 120s，大 apk）。 */
export const INSTALL_TIMEOUT_MS = 120_000
/** 截图超时（简报：screencap 30s）。 */
export const SCREENSHOT_TIMEOUT_MS = 30_000

/**
 * 设备上的临时截图目录（隐藏目录）。
 *
 * 【与简报 R1 的偏差，理由在此】
 * R1 建议落在 /data/local/tmp（shell 可写的调试区），但传输通道的路径闸门
 * （src/shared/path-guard.ts 的 PROTECTED_REMOTE_SUBTREES）**拒绝 /data 整棵子树** ——
 * 那是任务 8 复审 C2 定下的安全边界：传输的路径完全来自渲染层入参，是最该严格的地方。
 * 真机实测：用 /data/local/tmp 时每一次截图都在入队那一步失败（E_PROTECTED_PATH），
 * 也就等于「截图功能永远不可用」。
 *
 * 【复审 I2】落点从 /sdcard/Download 改为 /sdcard/.adbfm：
 * 前者是用户可见的「下载」目录 —— 一旦清理失败（见 I1 的出口缺口），
 * 用户的下载目录里就会出现来路不明的 png。而隐藏目录：
 *   - 闸门实测同样放行（isProtectedTransferDirectory('/sdcard/.adbfm') === false）；
 *   - `ls` 不带 -a 看不到，用户不会翻到；
 *   - 即使残留也不污染用户的任何既有目录结构。
 * 目录由本服务在截图前 mkdir -p；建不出来时**静默回退** SHOT_FALLBACK_DIR ——
 * 用户要的是截图，不是一条「隐藏目录建不了」的报错。回退后的路径仍会进结果矩阵
 * （detail 是传输任务 id，任务源路径可在底栏看到），且临时文件照样会被清理。
 */
export const SHOT_TEMP_DIR = '/sdcard/.adbfm'

/** 隐藏目录建不出来时的回退落点（设备上必然存在，闸门也放行）。 */
export const SHOT_FALLBACK_DIR = '/sdcard/Download'

/** 临时文件名前缀（陈旧残留清扫靠它识别，改名会破坏清理）。 */
export const SHOT_PREFIX = 'adbfm-shot-'

/** 批量动作服务依赖（全部注入，测试可用假 client / 假传输）。 */
export interface BatchServiceDeps {
  /** 主进程会话表：在线判定在它上面（R5 / R6）。 */
  devices: { get(serial: string): DeviceSession | undefined }
  /** 按 serial 造 client（AdbClient 满足 ShellRunner）。 */
  clientFor: (serial: string) => ShellRunner
  /**
   * 传输队列的入队面。
   *
   * 只依赖这一条方法：批量层对队列的职责就是「产生任务」，
   * 取消/重试/快照都是界面的活（R2）。
   */
  transfer: { enqueue(input: EnqueueIntent): Promise<TransferTask> }
  /** 当前本地根目录（用户选定的那个；本地访问闸门要用）。 */
  localRoot: () => string
  /** 当前 adb 路径；空串表示还没定位到。 */
  adbPath: () => string
  /** 时钟注入（截图临时文件名用；测试可固定）。 */
  now?: () => number
  /**
   * 让用户挑一个本地目录（批量截图的目标目录）。
   *
   * 【复审 I5】这条链路修前是死的：通道/preload/schema 都登记了，渲染层从不调用。
   * 现在界面点「批量截图」时先调它拿目录（见 OverviewPage.handleScreenshot），
   * 于是它有了真实消费者，也让用户能自己决定截图存哪。
   *
   * 为什么必须在主进程：渲染层没有 node 能力也没有 dialog，
   * 而 <input type=file> 在 Electron 里拿不到真实绝对路径。
   * 取消返回空串（与 pickFiles / pickRoot 的约定一致：取消不是错误）。
   */
  pickDirectory: () => Promise<string>
  /** 让用户挑一个 .apk 文件；取消返回空串。界面「批量安装」按钮会先调它。 */
  pickApk: () => Promise<string>
  /**
   * 传输任务结束后的回调登记（截图临时文件清理用）。
   *
   * 【复审 M7】修前它是**可选**的：漏传时 cleanupTemp 会退回「立即删除」，
   * 于是 pull 还在读源文件时它就被删了 —— 一条只在注释里禁止的路径。
   * 现在是必填依赖：漏传是编译错误，而不是运行期的数据竞争。
   */
  onTaskSettled: (taskId: string, callback: () => void) => void
}

/** 批量请求入参（四个动作共用的外壳）。 */
export interface BatchSerialsInput {
  serials: readonly string[]
}

/** 批量推送入参。 */
export interface BatchPushInput extends BatchSerialsInput {
  files: readonly string[]
  dstDir: string
}

/**
 * 在 runBatch 的 worker 里表示「这一台失败」。
 *
 * 为什么用抛错而不是返回一个 { ok:false } 对象：runBatch 的契约是
 * 「worker 正常返回 = 这台成功；抛错 = 这台失败」。把失败编码进返回值就有两种
 * 互相矛盾的表达方式，而结果数组每台只有一个槽位 —— 谁最后写谁赢，
 * 失败会被静默吞成成功。toErrorCode 能从异常消息里取出错误码，所以只需把码抛出去。
 */
function failWith(code: string): never {
  throw new Error(code)
}

/**
 * 单台设备的「能不能发命令」判定（R5）。
 *
 * 必须在发命令之前判：adb -s <offline> shell 会挂到 30s 超时，
 * 批量 3 台就是 90s 的假死，而用户看到的是按钮一直不恢复。
 *
 * 返回 undefined 表示可以发命令。
 */
export function precheck(session: DeviceSession | undefined): string | undefined {
  if (session === undefined) return E_BAD_ARGS
  if (session.status === 'device') return undefined
  // 未授权与离线的用户动作完全不同：一个要去手机上点「允许」，一个是插好线
  if (session.status === 'unauthorized') return E_NO_PERMISSION
  return E_DEVICE_OFFLINE
}

/**
 * 整批参数错的统一出口（R7）。
 *
 * 长度按 serials 给：界面要按设备逐行标注「这一台没做，因为整批参数不对」。
 * 只返回一条错误会让另外 N-1 行凭空消失，用户会以为它们成功了。
 */
function failAll(serials: readonly string[], code: string): BatchRunData {
  return { results: serials.map((serial) => ({ serial, ok: false, code })) }
}

/** serial 里可能有 ':' 这类字符，落成文件名前换成 '_'（不改变唯一性：时间戳在前）。 */
export function sanitizeSerial(serial: string): string {
  return serial.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * shell 失败的归类。
 *
 * 为什么不用 toErrorCode(stderr)：adb shell 的 stderr 是设备侧程序的原文
 * （"ls: /x: No such file or directory"），里面根本没有我们的错误码。
 * 这里按已知文案归类，认不出就 E_OP_FAILED —— 但**绝不**编一个成功。
 */
export function classifyShellFailure(stderr: string, code: number | null): string {
  const text = stderr.toLowerCase()
  if (text.includes('permission denied')) return E_NO_PERMISSION
  if (text.includes('no such file or directory')) return E_NOT_FOUND
  if (text.includes('no space left')) return E_NO_SPACE
  if (text.includes('read-only file system')) return E_PROTECTED_PATH
  // code 为 null = 被信号终止（超时 kill），与「设备掉线」同一类不可解释失败
  if (text.includes('timeout') || code === null) return E_SYNC_FAILED
  return E_OP_FAILED
}

/** install 失败的归类（adb install 的失败文案是固定的几种）。 */
export function classifyInstallFailure(text: string): string {
  const lower = text.toLowerCase()
  if (lower.includes('insufficient_storage')) return E_NO_SPACE
  if (lower.includes('no such file')) return E_NOT_FOUND
  return E_OP_FAILED
}

/** 一次待结算的临时文件清理。 */
interface PendingCleanup {
  /** 发 rm 的动作（失败只记日志）。 */
  run: () => void
}

export class BatchService {
  /**
   * 尚未结算的清理登记（taskId → 清理动作）。
   *
   * 【复审 I1】修前这些回调只挂在 main.ts 的一张表里，而 TransferManager.dispose()
   * 对**排队中**的任务既不取消也不 emit —— 应用退出时它们永远等不到终态，
   * 设备上就留下 adbfm-shot-*.png（审查真机复现 LEFTOVER_AFTER_QUIT=1）。
   * 现在登记表在本服务里，dispose() 会把它们全部执行掉。
   */
  private pending = new Map<string, PendingCleanup>()
  /** dispose 之后不再登记新清理（退出竞态下直接执行）。 */
  private disposed = false

  constructor(private readonly deps: BatchServiceDeps) {}

  /**
   * 退出收尾（复审 I1）：把所有未结算的临时文件清理立刻执行掉。
   *
   * 幂等；由 main.ts 的 before-quit 调用（与 transfer.dispose() 同一处）。
   */
  dispose(): void {
    this.disposed = true
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) {
      try {
        entry.run()
      } catch {
        // 退出路径上不能抛：主结果与进程收尾比一次 rm 更重要
      }
    }
  }

  /**
   * 弹目录选择框（批量截图的目标目录）。
   *
   * 【复审 I5】这不是死代码：渲染层的「批量截图」按钮在没选过目录时会先调它，
   * 所以通道 → preload → handler → 这里 → dialog 是一条有真实消费者的链。
   */
  async pickScreenshotDir(): Promise<string> {
    return this.deps.pickDirectory()
  }

  /** 弹文件选择框挑一个 .apk；取消返回空串。 */
  async pickApk(): Promise<string> {
    return this.deps.pickApk()
  }

  /** 当前未结算的清理数（诊断/测试用；退出后必须为 0）。 */
  get pendingCleanups(): number {
    return this.pending.size
  }

  /**
   * 批量截图（R1 / I1 / I2）。
   *
   * 每台设备：
   *   1. mkdir -p 隐藏临时目录（失败回退 /sdcard/Download）；
   *   2. **扫掉该目录里的陈旧残留**（I1：覆盖进程被 kill / 崩溃的出口）；
   *   3. screencap -p 到临时文件；
   *   4. transfer.enqueue(pull, 该路径, 用户目录)；
   *   5. 任务进终态后 rm -f 临时文件（失败只记日志，不覆盖主结果）。
   *
   * 为什么结果标「已加入队列」（detail 是任务 id）而不是「已完成」：
   * 真正的下载在队列里跑，批量层返回时文件还没落地。
   */
  async screenshot(input: BatchSerialsInput, dstDir: string): Promise<BatchRunData> {
    if (dstDir.trim() === '') return failAll(input.serials, E_BATCH_PARAM)
    // R7：目标目录先校验一次（越界 / 不存在 → 整批失败，不让 N 台各报一次）
    const dirAccess = await checkLocalAccess(this.deps.localRoot(), dstDir)
    if (!dirAccess.ok) return failAll(input.serials, dirAccess.code)
    let isDir = false
    try {
      isDir = statSync(dirAccess.path).isDirectory()
    } catch {
      return failAll(input.serials, E_NOT_FOUND)
    }
    if (!isDir) return failAll(input.serials, E_NOT_A_DIRECTORY)

    const results = await runBatch(input.serials, async (serial): Promise<BatchItemResult | void> => {
      const blocked = precheck(this.deps.devices.get(serial))
      // R5：离线/未授权 → 零命令，直接把这台记为失败
      if (blocked !== undefined) failWith(blocked)

      const adb = this.deps.adbPath()
      if (adb === '') failWith(E_ADB_NOT_FOUND)

      const client = this.deps.clientFor(serial)
      const dir = await this.prepareTempDir(client, adb)
      // I1：截图前先把陈旧残留扫掉（这是唯一能覆盖「进程被强杀」的出口）
      await this.sweepStaleShots(client, adb, dir)

      const stamp = (this.deps.now ?? (() => Date.now()))()
      const remotePath = dir + '/' + SHOT_PREFIX + stamp + '-' + sanitizeSerial(serial) + '.png'
      let taskId: string | undefined
      try {
        const shot = await client.run(
          ['shell', 'screencap -p ' + shellQuote(remotePath)],
          { adbPath: adb, timeoutMs: SCREENSHOT_TIMEOUT_MS },
        )
        if (shot.code !== 0) failWith(classifyShellFailure(shot.stderr, shot.code))
        /*
         * R1：走传输队列拉回来（二进制绝不经过 stdout）。
         *
         * dstDir 传**用户原样给的目录**，不传 realpath 后的路径：
         * 队列自己会用同一个根再做一次闸门判定，两次判定的基准必须一致
         * （Windows 8.3 短名与长名混用会把「同一个目录」判成根外，实测 E_OUTSIDE_ROOT）。
         */
        const task = await this.deps.transfer.enqueue({
          serial,
          direction: 'pull',
          src: remotePath,
          dstDir,
        })
        taskId = task.id
        return { serial, ok: true, detail: task.id }
      } finally {
        /*
         * 无论成败都尝试清理（R1）。顺序很关键：
         *   - 入队成功 → 等任务进终态再删（否则 pull 还没读，源文件就没了）；
         *   - 入队失败 / 截图失败 → 没有任务会读它，立即删。
         * 清理本身单独 try：它失败绝不能覆盖主结果。
         */
        this.registerCleanup(client, adb, remotePath, taskId)
      }
    })

    return { results }
  }

  /**
   * 准备（并返回）临时目录。
   *
   * I2：优先用隐藏目录；建不出来（权限 / 厂商限制）时回退到下载目录 ——
   * 宁可让临时文件落在用户可见处，也不能让截图功能整个不可用。
   */
  private async prepareTempDir(client: ShellRunner, adb: string): Promise<string> {
    try {
      const made = await client.run(
        ['shell', 'mkdir -p ' + shellQuote(SHOT_TEMP_DIR)],
        { adbPath: adb, timeoutMs: SCREENSHOT_TIMEOUT_MS },
      )
      if (made.code === 0) return SHOT_TEMP_DIR
    } catch {
      // 落到下面的回退
    }
    return SHOT_FALLBACK_DIR
  }

  /**
   * 扫掉本服务留下的陈旧截图（I1）。
   *
   * 为什么需要它：清理还有三条主动路径覆盖不到的出口 —— 进程被强杀、崩溃、
   * 或上一个版本的残留。前缀固定就是为这一步设计的。
   * 命令形如 rm -f '<dir>'/adbfm-shot-*.png：目录过 shellQuote，通配符**不加引号**
   * （加了就成了字面量，什么也删不掉）。
   */
  private async sweepStaleShots(client: ShellRunner, adb: string, dir: string): Promise<void> {
    try {
      await client.run(
        ['shell', 'rm -f ' + shellQuote(dir) + '/' + SHOT_PREFIX + '*.png'],
        { adbPath: adb, timeoutMs: SCREENSHOT_TIMEOUT_MS },
      )
    } catch {
      // 清扫失败不该让截图失败：下一次任务终态清理还会再试
    }
  }

  /**
   * 登记一次临时文件清理。
   *
   * 四条出口（复审 I1 后）：
   *   1. 入队成功 → 等任务进终态（onTaskSettled）；
   *   2. 入队失败 / 截图失败 → 立即删；
   *   3. 应用退出 → dispose() 执行所有未结算登记；
   *   4. 进程被强杀 → 下一次截图前 sweepStaleShots 兜底。
   */
  private registerCleanup(
    client: ShellRunner,
    adb: string,
    remotePath: string,
    taskId: string | undefined,
  ): void {
    const run = (): void => {
      void client
        .run(['shell', 'rm -f ' + shellQuote(remotePath)], { adbPath: adb, timeoutMs: SCREENSHOT_TIMEOUT_MS })
        .catch(() => { console.warn('[batch] 临时截图清理失败：' + remotePath) })
    }
    if (taskId === undefined) {
      // 没有任务会读它：立即删
      run()
      return
    }
    if (this.disposed) {
      // 退出竞态：现在不删就再也没机会了（dispose 之后不再有事件）
      run()
      return
    }
    this.pending.set(taskId, { run })
    this.deps.onTaskSettled(taskId, () => {
      // 终态到达：从登记表取走（幂等：dispose 可能已经执行过）
      if (!this.pending.delete(taskId)) return
      run()
    })
  }

  /**
   * 批量安装（adb install -r）。
   *
   * R7：apk 路径在 runBatch 之前校验一次（不存在 / 是目录 / 空文件 → 整批失败），
   * 而不是让 3 台设备各跑一次注定失败的 install。
   */
  async install(input: BatchSerialsInput, apkPath: string): Promise<BatchRunData> {
    if (apkPath === '') return failAll(input.serials, E_BATCH_PARAM)
    const access = await checkLocalAccess(this.deps.localRoot(), apkPath)
    if (!access.ok) return failAll(input.serials, access.code)
    let size = 0
    try {
      const info = statSync(access.path)
      if (!info.isFile()) return failAll(input.serials, E_NOT_A_DIRECTORY)
      size = info.size
    } catch {
      return failAll(input.serials, E_NOT_FOUND)
    }
    // 空文件不可能是有效 apk：让他去挑一个真的包，而不是 N 台各失败一次
    if (size === 0) return failAll(input.serials, E_BATCH_PARAM)

    const results = await runBatch(input.serials, async (serial): Promise<BatchItemResult | void> => {
      const blocked = precheck(this.deps.devices.get(serial))
      if (blocked !== undefined) failWith(blocked)
      const adb = this.deps.adbPath()
      if (adb === '') failWith(E_ADB_NOT_FOUND)

      const run = await this.deps
        .clientFor(serial)
        .run(['install', '-r', access.path], { adbPath: adb, timeoutMs: INSTALL_TIMEOUT_MS })

      /*
       * adb install 的成败在 **stdout** 上（"Success" / "Failure [INSTALL_FAILED_...]"），
       * 退出码不可靠（部分版本返回 0 但输出 Failure）。两处都要看。
       */
      const text = run.stdout + run.stderr
      if (run.code !== 0 || /Failure|Error/i.test(text)) failWith(classifyInstallFailure(text))
      return undefined
    })

    return { results }
  }

  /**
   * 批量推送（R2）。
   *
   * 批量层职责只有「对 N 台各产生任务」，然后立刻返回结果矩阵；
   * 并发控制完全交给队列（它已有单设备 1 / 全局 3）。
   *
   * 因此这里**不用 runBatch**（R3）：入队本身是同步 IO，套并发没有意义。
   */
  async push(input: BatchPushInput): Promise<BatchRunData> {
    if (input.dstDir.trim() === '') return failAll(input.serials, E_BATCH_PARAM)
    if (input.files.length === 0) return failAll(input.serials, E_BATCH_PARAM)

    // R7：目标目录先过一次远程闸门（与 transfer 的严格语义一致）
    const verdict = checkRemotePath(input.dstDir)
    if (!verdict.ok) return failAll(input.serials, verdict.code)
    if (isProtectedTransferDirectory(verdict.path)) return failAll(input.serials, E_PROTECTED_PATH)

    /*
     * R7：每个本地文件先校验一次（不存在 → 整批失败）。
     *
     * 校验用 checkLocalAccess 的 realpath 结果（唯一能看穿符号链接的判定），
     * 但入队时传**用户给的原串**：队列会用同一个根再判一次，
     * 若两边写法不同（Windows 8.3 短名 vs 长名），同一个目录会被判成根外。
     */
    const sources: string[] = []
    for (const file of input.files) {
      const access = await checkLocalAccess(this.deps.localRoot(), file)
      if (!access.ok) return failAll(input.serials, access.code)
      try {
        if (!statSync(access.path).isFile()) return failAll(input.serials, E_NOT_A_DIRECTORY)
      } catch {
        return failAll(input.serials, E_NOT_FOUND)
      }
      sources.push(file)
    }

    // R4：结果按下标回填，顺序与入参一致
    const results: BatchItemResult[] = new Array(input.serials.length)
    for (let index = 0; index < input.serials.length; index += 1) {
      const serial = input.serials[index]
      const blocked = precheck(this.deps.devices.get(serial))
      if (blocked !== undefined) {
        results[index] = { serial, ok: false, code: blocked }
        continue
      }
      /*
       * 逐台逐文件入队。某台设备的某个文件入队失败只影响这一台；
       * 这一台已入队的任务保留 —— 用户能在底栏看到并取消，比整体回滚更可解释。
       */
      let queued = 0
      let failure: string | undefined
      for (const src of sources) {
        try {
          await this.deps.transfer.enqueue({ serial, direction: 'push', src, dstDir: verdict.path })
          queued += 1
        } catch (err) {
          failure = toErrorCode(err)
          break
        }
      }
      results[index] = failure === undefined
        ? { serial, ok: true, detail: String(queued) }
        : { serial, ok: false, code: failure, detail: String(queued) }
    }
    return { results }
  }

  /**
   * 批量执行命令（R8 / I3）。
   *
   * 【复审 I3】截断从「事后」改成「流式」：
   * 修前是拿到完整 run.stdout 之后再 truncateUtf8 —— 截断只保护了 IPC 载荷，
   * 主进程内存在命令运行期间仍随输出线性增长（审查实测 27.4 MB / 堆 +25.1 MB）。
   * 现在把 maxStdoutBytes 交给 AdbClient，它在收流过程中就封顶并中止进程树；
   * 已经收到的部分由 createStdoutBudget 攒着，作为「被截断的结果」返回。
   */
  async shell(input: BatchSerialsInput, command: string): Promise<BatchRunData> {
    const trimmed = command.trim()
    if (trimmed === '') return failAll(input.serials, E_BATCH_PARAM)
    // 换行会把一条 shell 命令切成多条：用户看到「执行成功」，实际多跑了几条
    if (command.includes('\n') || command.includes('\r')) return failAll(input.serials, E_BAD_COMMAND)

    const results = await runBatch(input.serials, async (serial): Promise<BatchItemResult | void> => {
      const blocked = precheck(this.deps.devices.get(serial))
      if (blocked !== undefined) failWith(blocked)
      const adb = this.deps.adbPath()
      if (adb === '') failWith(E_ADB_NOT_FOUND)

      const budget = createStdoutBudget(SHELL_STDOUT_LIMIT_BYTES)
      let run: Awaited<ReturnType<ShellRunner['run']>>
      try {
        run = await this.deps.clientFor(serial).run(['shell', command], {
          adbPath: adb,
          timeoutMs: SHELL_TIMEOUT_MS,
          maxStdoutBytes: SHELL_STDOUT_LIMIT_BYTES,
          onStdout: (chunk) => { budget.push(chunk) },
        })
      } catch (err) {
        /*
         * 输出超限是**预期内**的结果，不是失败：用户要的就是「前 N 字节 + 已截断」。
         * 其它异常（超时 / 掉线）仍然按失败折算。
         */
        if (err instanceof Error && err.message.includes(E_STDOUT_LIMIT)) {
          const detail = truncateUtf8(budget.text(), DETAIL_LIMIT_BYTES)
          return { serial, ok: true, detail: detail.text, truncated: true }
        }
        throw err
      }
      if (run.code !== 0) failWith(classifyShellFailure(run.stderr, run.code))
      /*
       * 命令正常结束后仍可能已触发封顶（进程在被杀之前把输出写完了）：
       * 以 budget 为准 —— 它是「我们真正收下的字节」，比 run.stdout 更权威。
       */
      const detail = truncateUtf8(budget.text(), DETAIL_LIMIT_BYTES)
      return { serial, ok: true, detail: detail.text, truncated: budget.overflowed() || detail.truncated }
    })

    return { results }
  }
}
