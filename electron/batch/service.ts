import { statSync } from 'node:fs'
import type { DeviceSession } from '../../src/shared/types'
import type { BatchItemResult, BatchRunData } from '../../src/shared/batch'
import { truncateUtf8 } from '../../src/shared/batch'
import {
  E_ADB_NOT_FOUND,
  E_BAD_ARGS,
  E_BATCH_PARAM,
  E_DEVICE_OFFLINE,
  E_INVALID_PATH,
  E_NO_PERMISSION,
  E_NO_SPACE,
  E_NOT_A_DIRECTORY,
  E_NOT_FOUND,
  E_OP_FAILED,
  E_PROTECTED_PATH,
  E_SYNC_FAILED,
  toErrorCode,
} from '../../src/shared/errors'
import {
  checkRemotePath,
  isProtectedTransferDirectory,
} from '../../src/shared/path-guard'
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
 * R1 截图：screencap 写到 /data/local/tmp 的临时文件 → transfer.enqueue(pull)
 *          → 任务进入终态后 rm -f 清理；入队就失败时在 finally 里立即清。
 *          绝不读 stdout：electron/adb/client.ts 是 setEncoding('utf8')，
 *          二进制跨 chunk 会被 StringDecoder 拼坏（任务 2 修过的 Critical）。
 * R2 推送：只对每台设备 enqueue 任务就返回「已加入队列」，不自己管并发。
 * R3 runBatch（并发 3）只用于 screenshot / install / shell。
 * R5 离线/未授权：status !== 'device' 的设备在**发命令之前**就产生结果，零 adb 命令。
 * R7 参数错：apk 不存在 / 目标目录非法 / 命令为空 —— 在 runBatch 之前校验一次，
 *    整批失败，而不是让 N 台设备各报一次同样的错。
 * R8 输出截断：单台 stdout 8 KB、矩阵 detail 512 字节，均按 UTF-8 字节数截。
 */

/** 单台 shell 命令的 stdout 上限（R8）。 */
export const SHELL_STDOUT_LIMIT_BYTES = 8 * 1024
/** 结果矩阵里 detail 的上限（R8：只放前 512 字节摘要）。 */
export const DETAIL_LIMIT_BYTES = 512

/** 执行命令超时（简报：shell 30s）。 */
export const SHELL_TIMEOUT_MS = 30_000
/** 安装超时（简报：install 120s，大 apk）。 */
export const INSTALL_TIMEOUT_MS = 120_000
/** 截图超时（简报：screencap 30s）。 */
export const SCREENSHOT_TIMEOUT_MS = 30_000

/**
 * 设备上的临时截图目录。
 *
 * 【与简报 R1 的偏差，理由在此】
 * R1 建议落在 /data/local/tmp（shell 可写的调试区），但传输通道的路径闸门
 * （src/shared/path-guard.ts 的 PROTECTED_REMOTE_SUBTREES）**拒绝 /data 整棵子树** ——
 * 那是复审 C2 定下的安全边界：传输的路径完全来自渲染层入参，是最该严格的地方。
 *
 * 真机实测：用 /data/local/tmp 时每一次截图都在入队那一步失败（E_PROTECTED_PATH），
 * 也就是「截图功能永远不可用」。改为落在 /sdcard/Download：
 *   - 它在传输闸门里是允许的（用户存储区的普通子目录）；
 *   - 它是设备上必然存在的目录（不必先 mkdir）；
 *   - 临时文件带 adbfm-shot- 前缀，任务进终态后立刻 rm -f。
 *
 * 明确的取舍：为什么不放宽闸门或给截图开个后门 —— 那等于为了一个调试目录
 * 在所有传输路径上开一条通往 /data 的口子，代价远大于收益。
 * 也不落在 /sdcard 根本身：那会让用户在存储根看到一个一闪而过的 png，
 * 而且任何「存储根条目数」的观察都会被这个临时文件干扰（真机上实测到过）。
 */
export const SHOT_TEMP_DIR = '/sdcard/Download'

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
   * 为什么必须在主进程：渲染层没有 node 能力也没有 dialog，
   * 而 <input type=file> 在 Electron 里拿不到真实绝对路径。
   * 取消返回空串（与 pickFiles / pickRoot 的约定一致：取消不是错误）。
   */
  pickDirectory: () => Promise<string>
  /** 让用户挑一个 .apk 文件；取消返回空串。 */
  pickApk: () => Promise<string>
  /**
   * 传输任务结束后的回调登记（截图临时文件清理用）。
   *
   * 缺省实现「立即调用」—— 那只适用于任务已经结束的场景；
   * 生产里由 main.ts 注入「等到终态再调」，否则 pull 还没跑就把源文件删了。
   */
  onTaskSettled?: (taskId: string, callback: () => void) => void
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
 * 单台设备的「能不能发命令」判定（R5）。
 *
 * 必须在发命令之前判：adb -s <offline> shell 会挂到 30s 超时，
 * 批量 3 台就是 90s 的假死，而用户看到的是按钮一直不恢复。
 *
 * 返回 undefined 表示可以发命令。
 */
/**
 * 在 runBatch 的 worker 里表示「这一台失败」。
 *
 * 为什么用抛错而不是返回一个 { ok:false } 对象：runBatch 的契约是
 * 「worker 正常返回 = 这台成功；抛错 = 这台失败」，把失败编码进返回值就会有两种
 * 互相矛盾的表达方式，而 out[index] 只能写一种 —— 谁最后写谁赢，失败会被静默吞掉。
 * toErrorCode 能从消息里取出错误码，所以这里只需把码抛出去。
 */
function failWith(code: string): never {
  throw new Error(code)
}

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

export class BatchService {
  constructor(private readonly deps: BatchServiceDeps) {}

  /**
   * 弹目录选择框（批量截图的目标目录）。
   *
   * 为什么选择框走 service 而不是 handler 直接调 dialog：
   * 「选目录 → 校验 → 逐台截图」是一条链，目录的语义（必须在本地根内）
   * 与截图的目标路径是同一件事，放在两个文件里迟早漂移。
   * 测试也能用假 picker 覆盖「用户取消」这条路径（返回空串，不是错误）。
   */
  async pickScreenshotDir(): Promise<string> {
    return this.deps.pickDirectory()
  }

  /** 弹文件选择框挑一个 .apk；取消返回空串。 */
  async pickApk(): Promise<string> {
    return this.deps.pickApk()
  }

  /**
   * 批量截图（R1）。
   *
   * 每台设备：
   *   1. screencap -p 到 /data/local/tmp/adbfm-shot-<ts>-<serial>.png；
   *   2. transfer.enqueue(pull, 该路径, 用户目录)；
   *   3. 任务进入终态后 rm -f 临时文件（失败只记日志，不覆盖主结果）。
   *
   * 为什么结果标「已加入队列」（detail 是任务 id）而不是「已完成」：
   * 真正的下载在队列里跑，批量层返回时文件还没落地。
   * 谎称完成会让用户去目录里找一张不存在的图。
   */
  async screenshot(input: BatchSerialsInput): Promise<BatchRunData> {
    // 目标目录只能由主进程弹框问用户（渲染层拿不到绝对路径）
    const dstDir = await this.deps.pickDirectory()
    // 取消选择：什么都不做，也不是错误（结果为空数组，界面据此保持空闲）
    if (dstDir === '') return { results: [] }

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

      const stamp = (this.deps.now ?? (() => Date.now()))()
      const remotePath = SHOT_TEMP_DIR + '/adbfm-shot-' + stamp + '-' + sanitizeSerial(serial) + '.png'
      const client = this.deps.clientFor(serial)
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
         * dstDir 传**用户原样选的目录**，不传 realpath 后的路径：
         * 队列自己会用同一个根再做一次闸门判定，而两次判定的基准必须一致
         * （真机上 Windows 8.3 短名与长名混用会让「同一个目录」判成根外，
         * 实测报 E_OUTSIDE_ROOT）。判定用 realpath 是判断，传参用原串是执行 ——
         * 这两件事在传输层各自负责。
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
         * 无论成败都尝试清理（R1）。
         *
         * 顺序很关键：
         *   - 入队成功 → 等任务进终态再删（否则 pull 还没读，源文件就没了）；
         *   - 入队失败 / 截图失败 → 没有任务会读它，立即删（避免设备上留垃圾）。
         * 清理本身单独 try：它失败绝不能覆盖主结果 —— 用户的截图可能已经拿到了。
         */
        this.cleanupTemp(client, adb, remotePath, taskId)
      }
    })

    return { results }
  }

  /**
   * 登记一次临时文件清理。
   *
   * 单独抽出来是为了让「等任务结束」与「立即删」在**同一个函数**里二选一，
   * 避免两个调用点各写一遍（漏一处就是设备上永久残留）。
   */
  private cleanupTemp(client: ShellRunner, adb: string, remotePath: string, taskId: string | undefined): void {
    const remove = (): void => {
      void client
        .run(['shell', 'rm -f ' + shellQuote(remotePath)], { adbPath: adb, timeoutMs: SCREENSHOT_TIMEOUT_MS })
        .catch(() => { console.warn('[batch] 临时截图清理失败：' + remotePath) })
    }
    if (taskId !== undefined && this.deps.onTaskSettled !== undefined) {
      this.deps.onTaskSettled(taskId, remove)
      return
    }
    remove()
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
      // R5：离线/未授权 → 零命令
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
   * 因此这里**不用 runBatch**（R3）：入队本身是同步 IO，套并发没有意义，
   * 用 runBatch 反而会让结果矩阵看起来像「并发执行结果」。
   */
  async push(input: BatchPushInput): Promise<BatchRunData> {
    if (input.dstDir === '') return failAll(input.serials, E_BATCH_PARAM)
    if (input.files.length === 0) return failAll(input.serials, E_BATCH_PARAM)

    // R7：目标目录先过一次远程闸门（与 transfer 的严格语义一致）
    const verdict = checkRemotePath(input.dstDir)
    if (!verdict.ok) return failAll(input.serials, verdict.code)
    if (isProtectedTransferDirectory(verdict.path)) return failAll(input.serials, E_PROTECTED_PATH)

    /*
     * R7：每个本地文件先校验一次（不存在 → 整批失败）。
     *
     * 校验用 checkLocalAccess 的 realpath 结果（那是唯一能看穿符号链接的判定），
     * 但入队时传**用户给的原串**：队列会用同一个根再判一次，
     * 若两边拿到的写法不同（Windows 8.3 短名 vs 长名），同一个目录会被判成根外。
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
   * 批量执行命令（R8）。
   *
   * 输出截断分两层：单台 8 KB（stdout 本身），矩阵里的 detail 前 512 字节。
   * 理由：adb shell cat /dev/urandom 之类会把 IPC 撑爆。
   */
  async shell(input: BatchSerialsInput, command: string): Promise<BatchRunData> {
    if (command.trim() === '') return failAll(input.serials, E_BATCH_PARAM)
    // 换行会把一条命令切成多条：用户看到「执行成功」，实际多跑了几条
    if (command.includes('\n') || command.includes('\r')) return failAll(input.serials, E_INVALID_PATH)

    const results = await runBatch(input.serials, async (serial): Promise<BatchItemResult | void> => {
      const blocked = precheck(this.deps.devices.get(serial))
      if (blocked !== undefined) failWith(blocked)
      const adb = this.deps.adbPath()
      if (adb === '') failWith(E_ADB_NOT_FOUND)

      const run = await this.deps
        .clientFor(serial)
        .run(['shell', command], { adbPath: adb, timeoutMs: SHELL_TIMEOUT_MS })
      if (run.code !== 0) failWith(classifyShellFailure(run.stderr, run.code))
      const clipped = truncateUtf8(run.stdout, SHELL_STDOUT_LIMIT_BYTES)
      const detail = truncateUtf8(clipped.text, DETAIL_LIMIT_BYTES)
      return {
        serial,
        ok: true,
        detail: detail.text,
        // 任一层的截断都要标注（否则用户会以为命令只输出了这么点）
        truncated: clipped.truncated || detail.truncated,
      }
    })

    return { results }
  }
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
