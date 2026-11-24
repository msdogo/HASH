import { statSync } from 'node:fs'
import path from 'node:path'
import type { DeviceSession } from '../../src/shared/types'
import type { TransferTask } from '../../src/shared/transfer'
import {
  CAPTURE_TIMEOUT_MS,
  RECORD_MAX_SECONDS,
  RECORD_START_TIMEOUT_MS,
  baseNameOf,
  classifyCaptureFailure,
  deviceFallbackShotDir,
  deviceShotDir,
  recordFileName,
  screenshotFileName,
  type CaptureResult,
  type RecordStarted,
} from '../../src/shared/capture'
import {
  E_ADB_NOT_FOUND,
  E_BAD_ARGS,
  E_DEVICE_OFFLINE,
  E_NO_PERMISSION,
  E_NO_SERIAL,
  E_NOT_A_DIRECTORY,
  E_NOT_FOUND,
  E_NOT_RECORDING,
  E_RECORD_ACTIVE,
  toErrorCode,
} from '../../src/shared/errors'
import { shellQuote } from '../adb/shellsafe'
import type { ShellRunner } from '../fs/remote'
import { resolveLocalPath } from '../fs/local'
import type { EnqueueIntent } from '../transfer/service'

/**
 * 截图 / 录屏服务（P1 第一批）。
 *
 * ===== 这一层为什么存在 =====
 * IPC handler 不该知道「screencap 必须先 mkdir -p 再写临时文件」「录屏要 SIGINT 收尾」
 * 「临时文件必须等传输任务进终态才能删」这些规则。把它们收在这里，规则只有一处实现，
 * 于是能被一组假 client + 假录屏句柄完整覆盖（tests/capture-service.test.ts）。
 *
 * ===== 三条从任务 10 继承下来的硬约束（都有真机复现记录）=====
 * 1. **二进制绝不走 stdout**：electron/adb/client.ts 是 setEncoding('utf8')，
 *    二进制跨 chunk 会被 StringDecoder 拼坏。所以截图一律「设备上写文件 → 传输队列 pull」。
 * 2. **落点按设备分目录**（shared/capture.ts 的 deviceShotDir）：清扫只碰自己那台，
 *    不会删掉另一台还在排队的 pull 的源文件。
 * 3. **清理有四个出口**：任务终态 / 入队失败立即删 / dispose 全执行 / 下次截图前扫残留。
 */

/** 一台设备的录制会话句柄（真实实现由 main.ts 用 spawnTracked 构造）。 */
export interface RecordHandle {
  /** 注册退出回调：自然退出（到 --time-limit / 设备断开 / 被强杀）时触发一次。 */
  onExit(callback: (info: { code: number | null }) => void): void
  /**
   * 请求设备侧结束录制。
   *
   * 必须是 SIGINT 而不是直接杀本地 adb：screenrecord 收到 SIGINT 才会把 moov 盒子
   * 写进 mp4 正常收尾；直接杀本地进程会让设备上的录制进程变成孤儿，
   * 产出的文件播放器打不开（真机实测：0 字节或无法 seek）。
   */
  requestStop(): Promise<void>
  /** 兜底强杀本地进程树（requestStop 之后仍未退出时用）。 */
  kill(): Promise<void>
}

/** 截图 / 录屏服务依赖（全部注入，测试可用假 client / 假录屏）。 */
export interface CaptureDeps {
  /** 主进程会话表：在线判定在它上面。 */
  devices: { get(serial: string): DeviceSession | undefined }
  /** 按 serial 造 client（AdbClient 满足 ShellRunner）。 */
  clientFor: (serial: string) => ShellRunner
  /** 传输队列的入队面：截图 / 录屏的产物都走它落地。 */
  transfer: { enqueue(input: EnqueueIntent): Promise<TransferTask> }
  /** 当前 adb 路径；空串表示还没定位到。 */
  adbPath: () => string
  /** 截图 / 录屏的默认目标目录（设置里的默认下载路径）。 */
  defaultDstDir: () => string
  /** 起一个 screenrecord 会话；闸门已关闭等情况下返回 null。 */
  startRecording: (serial: string, remotePath: string, maxSeconds: number) => RecordHandle | null
  /** 传输任务进终态后的回调登记（临时文件清理用）。 */
  onTaskSettled: (taskId: string, callback: () => void) => void
  /** 时钟注入（临时文件名用；测试可固定）。 */
  now?: () => number
}

/** 一次待结算的临时文件清理。 */
interface PendingCleanup {
  run: () => void
}

/** 设备上一次成功的截图 / 录屏落在哪儿，供「复制路径」使用。 */
export interface CaptureOutcome {
  /** 传输任务 id。 */
  taskId: string
  /** 设备上的临时路径。 */
  remotePath: string
  /** 用户最终要拿到的本地路径。 */
  localPath: string
}

/** 校验目标目录（存在且是目录）。 */
async function resolveDstDir(dir: string): Promise<{ ok: true; dir: string } | { ok: false; code: string }> {
  if (dir.trim() === '') return { ok: false, code: E_BAD_ARGS }
  const access = await resolveLocalPath(dir)
  if (!access.ok) return { ok: false, code: access.code }
  try {
    if (!statSync(access.path).isDirectory()) return { ok: false, code: E_NOT_A_DIRECTORY }
  } catch {
    return { ok: false, code: E_NOT_FOUND }
  }
  return { ok: true, dir: access.path }
}

/** 单台设备「能不能发命令」的判定（与批量层同一套语义，但码更精确）。 */
function precheck(session: DeviceSession | undefined): string | undefined {
  if (session === undefined) return E_NO_SERIAL
  if (session.status === 'device') return undefined
  if (session.status === 'unauthorized') return E_NO_PERMISSION
  return E_DEVICE_OFFLINE
}

/** 一条录制会话的运行期状态。 */
interface RecordingSession {
  serial: string
  remotePath: string
  localDir: string
  handle: RecordHandle
  /** 已经进入收尾流程（手动停止或自动结束），防止两条路径重复收尾。 */
  settling: boolean
  /** 退出通知的兑现器（stop 时 await 它）。 */
  exited: Promise<number | null>
  /** 由 onExit 兑现上面的 Promise。 */
  resolveExit: (code: number | null) => void
}

export class CaptureService {
  private readonly pending = new Map<string, PendingCleanup>()
  private readonly sessions = new Map<string, RecordingSession>()
  private disposed = false

  constructor(private readonly deps: CaptureDeps) {}

  /** 当前未结算的清理数（诊断/测试用；退出后必须为 0）。 */
  get pendingCleanups(): number {
    return this.pending.size
  }

  /** 当前在录的设备数（测试与诊断用）。 */
  get activeRecordings(): number {
    return this.sessions.size
  }

  /**
   * 退出收尾：按设备停止所有录制，并兑现未结算的临时文件清理。
   *
   * 与 BatchService.dispose 同一条约束：**必须保持同步循环**。
   * main.ts 紧接着就会 shutdownChildren() 置位闸门，之后任何 spawn 都被拒；
   * 每条清理的 rm 都在本 tick 内同步 spawn，所以挡不到它们。
   * 录制停止是异步的，这里只发出请求（before-quit 不会等它）——
   * 设备的 --time-limit 与设备侧 SIGINT 是兜底，残留由下次截图前的清扫收掉。
   */
  dispose(): void {
    this.disposed = true
    for (const session of [...this.sessions.values()]) {
      try {
        void session.handle.requestStop()
      } catch {
        // 退出路径上不能抛：主结果与进程收尾比一次录制更重要
      }
    }
    this.sessions.clear()
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) {
      try {
        entry.run()
      } catch {
        // 同上
      }
    }
  }

  /**
   * 单台设备截图。
   *
   * @param serial 设备
   * @param dstDir 本地目标目录；空串表示用设置里的默认下载路径
   */
  async screenshot(serial: string, dstDir: string): Promise<CaptureResult> {
    const blocked = precheck(this.deps.devices.get(serial))
    if (blocked !== undefined) throw new Error(blocked)
    const adb = this.deps.adbPath()
    if (adb === '') throw new Error(E_ADB_NOT_FOUND)

    const target = await resolveDstDir(dstDir === '' ? this.deps.defaultDstDir() : dstDir)
    if (!target.ok) throw new Error(target.code)

    const client = this.deps.clientFor(serial)
    const dir = await this.prepareTempDir(client, adb, serial)
    // 截图前先扫掉这台设备留下的陈旧残留（唯一能覆盖「进程被强杀」的出口）
    await this.sweepStale(client, adb, dir, '*.png')

    const stamp = (this.deps.now ?? (() => Date.now()))()
    const remotePath = dir + '/' + screenshotFileName(stamp, serial)
    let taskId: string | undefined
    try {
      const shot = await client.run(
        ['shell', 'screencap -p ' + shellQuote(remotePath)],
        { adbPath: adb, timeoutMs: CAPTURE_TIMEOUT_MS },
      )
      if (shot.code !== 0) throw new Error(classifyCaptureFailure(shot.stderr, shot.code))
      const task = await this.deps.transfer.enqueue({
        serial,
        direction: 'pull',
        src: remotePath,
        dstDir: target.dir,
      })
      taskId = task.id
      return {
        serial,
        taskId,
        remotePath,
        localPath: path.join(target.dir, baseNameOf(remotePath)),
      }
    } finally {
      this.registerCleanup(client, adb, remotePath, taskId)
    }
  }

  /**
   * 开始录屏。
   *
   * 返回时**文件还没生成**：真正的 mp4 在设备上写，停止（或到时间上限）之后
   * 才会被拉回本地。界面据此显示「录制中」，进度在停止后才出现在底栏。
   */
  async startRecord(serial: string, dstDir: string): Promise<RecordStarted> {
    const blocked = precheck(this.deps.devices.get(serial))
    if (blocked !== undefined) throw new Error(blocked)
    // 同一台设备只允许一条录制：两条 screenrecord 会抢同一块编码器，
    // 且「停止」无法说清停的是哪一条
    if (this.sessions.has(serial)) throw new Error(E_RECORD_ACTIVE)
    const adb = this.deps.adbPath()
    if (adb === '') throw new Error(E_ADB_NOT_FOUND)

    const target = await resolveDstDir(dstDir === '' ? this.deps.defaultDstDir() : dstDir)
    if (!target.ok) throw new Error(target.code)

    const client = this.deps.clientFor(serial)
    const dir = await this.prepareTempDir(client, adb, serial)
    await this.sweepStale(client, adb, dir, '*.mp4')

    const stamp = (this.deps.now ?? (() => Date.now()))()
    const remotePath = dir + '/' + recordFileName(stamp, serial)
    const handle = this.deps.startRecording(serial, remotePath, RECORD_MAX_SECONDS)
    if (handle === null) throw new Error(E_ADB_NOT_FOUND)

    let resolveExit: (code: number | null) => void = () => undefined
    const exited = new Promise<number | null>((resolve) => { resolveExit = resolve })
    const session: RecordingSession = {
      serial,
      remotePath,
      localDir: target.dir,
      handle,
      settling: false,
      exited,
      resolveExit,
    }
    this.sessions.set(serial, session)

    /*
     * 自然退出（到 --time-limit、设备断开、被外部杀掉）也要把文件拉回来：
     * 用户点了「录屏」就该拿到一段视频，而不是必须记得再点一次「停止」。
     * 这条路径与手动 stop 共用同一个收尾函数，靠 settling 标志保证只执行一次。
     */
    handle.onExit((info) => {
      session.resolveExit(info.code)
      if (session.settling) return
      void this.finalize(session, info.code)
    })

    return { serial, localPath: path.join(target.dir, baseNameOf(remotePath)), maxSeconds: RECORD_MAX_SECONDS }
  }

  /**
   * 停止录屏并把文件拉回本地。
   *
   * 顺序不可颠倒：先 SIGINT 让设备侧收尾 → 等本地 adb 退出（此时 mp4 已落盘完整）
   * → 才能入队 pull。提前 pull 会拿到一个还在写的文件（真机实测：文件长度冻结在半途）。
   */
  async stopRecord(serial: string): Promise<CaptureResult> {
    const session = this.sessions.get(serial)
    if (session === undefined) throw new Error(E_NOT_RECORDING)
    session.settling = true

    await session.handle.requestStop()
    const code = await this.waitExit(session)
    if (code !== 0 && code !== null) {
      // 非 0 退出码可能是「设备侧 screenrecord 不存在」这类真失败
      this.sessions.delete(serial)
      throw new Error(classifyCaptureFailure('', code))
    }
    return this.finalize(session, code)
  }

  /** 等本地 adb 进程退出；超过宽限期就强杀（否则 stop 会永远挂住）。 */
  private async waitExit(session: RecordingSession): Promise<number | null> {
    const timeout = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => { resolve('timeout') }, RECORD_START_TIMEOUT_MS)
      // 这个定时器不该让进程活着：它只是 stop 的宽限期
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
    })
    const result = await Promise.race([session.exited, timeout])
    if (result === 'timeout') {
      await session.handle.kill()
      return null
    }
    return result
  }

  /**
   * 收尾：把设备上的文件拉回本地，并登记临时文件清理。
   *
   * 手动 stop 与自然退出都走这里。幂等由调用方（settling 标志）保证。
   */
  private async finalize(session: RecordingSession, _code: number | null): Promise<CaptureResult> {
    const { serial, remotePath, localDir } = session
    // 先从会话表摘掉：之后任何 stop 都会得到「没有在录」
    this.sessions.delete(serial)

    const client = this.deps.clientFor(serial)
    const adb = this.deps.adbPath()
    let taskId: string | undefined
    try {
      if (adb === '') throw new Error(E_ADB_NOT_FOUND)
      const task = await this.deps.transfer.enqueue({
        serial,
        direction: 'pull',
        src: remotePath,
        dstDir: localDir,
      })
      taskId = task.id
      return { serial, taskId, remotePath, localPath: path.join(localDir, baseNameOf(remotePath)) }
    } catch (err) {
      // 拉不回来也要把设备上的临时文件删掉：否则设备会积累一堆用户看不见的 mp4
      if (taskId === undefined) this.registerCleanup(client, adb, remotePath, undefined)
      throw new Error(toErrorCode(err))
    } finally {
      if (taskId !== undefined) this.registerCleanup(client, adb, remotePath, taskId)
    }
  }

  /**
   * 准备（并返回）临时目录。
   *
   * 优先用隐藏目录；建不出来（权限 / 厂商限制）时回退到下载目录 ——
   * 宁可让临时文件落在用户可见处，也不能让功能整个不可用。
   */
  private async prepareTempDir(client: ShellRunner, adb: string, serial: string): Promise<string> {
    for (const dir of [deviceShotDir(serial), deviceFallbackShotDir(serial)]) {
      try {
        const made = await client.run(
          ['shell', 'mkdir -p ' + shellQuote(dir)],
          { adbPath: adb, timeoutMs: CAPTURE_TIMEOUT_MS },
        )
        if (made.code === 0) return dir
      } catch {
        // 试下一个
      }
    }
    return deviceFallbackShotDir(serial)
  }

  /** 扫掉这台设备自己留下的陈旧残留（范围严格限制在本机子目录内）。 */
  private async sweepStale(client: ShellRunner, adb: string, dir: string, pattern: string): Promise<void> {
    try {
      await client.run(
        // 通配符不能加引号：加了就是字面量，什么也删不掉
        ['shell', 'rm -f ' + shellQuote(dir) + '/' + pattern],
        { adbPath: adb, timeoutMs: CAPTURE_TIMEOUT_MS },
      )
    } catch {
      // 清扫失败不该让主操作失败
    }
  }

  /**
   * 登记一次临时文件清理（四个出口见文件头）。
   */
  private registerCleanup(
    client: ShellRunner,
    adb: string,
    remotePath: string,
    taskId: string | undefined,
  ): void {
    const run = (): void => {
      void client
        .run(['shell', 'rm -f ' + shellQuote(remotePath)], { adbPath: adb, timeoutMs: CAPTURE_TIMEOUT_MS })
        .catch(() => { console.warn('[capture] 临时文件清理失败：' + remotePath) })
    }
    const usableAdb = this.deps.adbPath()
    if (usableAdb === '') {
      // 退出后 adb 路径可能已经取不到：直接跳过，靠下一次清扫兜底
      if (taskId === undefined) return
    }
    if (taskId === undefined || this.disposed) {
      run()
      return
    }
    this.pending.set(taskId, { run })
    this.deps.onTaskSettled(taskId, () => {
      if (!this.pending.delete(taskId)) return
      run()
    })
  }
}
