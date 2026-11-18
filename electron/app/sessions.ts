import { createHash } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { AdbClient } from '../adb/client'
import { resolveAdb, type CandidateInput, type ResolveResult } from '../adb/binary'
import { DeviceTracker } from '../adb/track'
import { DeviceManager } from '../devices/manager'
import { clearDeviceSerialTzCache } from '../fs/remote'
import { E_ADB_NOT_FOUND, toErrorCode } from '../../src/shared/errors'
import type { AdbAttempt, AdbState, DeviceSession, DevicesChangedBatch } from '../../src/shared/types'
import { DeviceChangeTracker } from './device-changed'

/**
 * 主进程的会话装配（裁决 1）。
 *
 * 为什么单独一个文件而不是塞进 main.ts：main.ts 一 import electron 就没法在
 * vitest 里跑（Electron 的入口在纯 Node 下起不来）。这里只依赖纯 Node 模块，
 * 于是「启动后有 tracker 实例、退出时被停掉」这条【可以自动化验证】，
 * main.ts 只负责把 Electron 的 app 生命周期接到这几个函数上。
 */

/** adb 自检的函数式注入点（测试替换掉真正的 resolveAdb）。 */
export interface AdbProbeDeps {
  /** 候选输入；resourcePath 由调用方从 process.resourcesPath 给出。 */
  resourcePath?: string
  custom?: string
  env?: string
  /** 仅测试注入：替换真正的 resolveAdb。 */
  resolve?: (input: CandidateInput) => Promise<ResolveResult>
}

/** 把 ResolveResult 收敛成一个 AdbState（永不抛错）。 */
export function createAdbProbe(deps: AdbProbeDeps = {}): () => Promise<AdbState> {
  return async () => {
    let result: ResolveResult
    try {
      result = deps.resolve !== undefined
        ? await deps.resolve({
            custom: deps.custom,
            env: deps.env,
            resourcesPath: deps.resourcePath ?? '',
          })
        : await resolveAdb({
            custom: deps.custom,
            env: deps.env,
            resourcesPath: deps.resourcePath ?? '',
          })
    } catch (err) {
      // resolveAdb 内部已经吞掉候选级错误；能抛到这里的是程序缺陷，
      // 但绝不能让它掀掉窗口 —— 设备栏显示「无法使用 adb」即可。
      return { state: 'error', code: toErrorCode(err), attempts: [] }
    }

    if (result.resolved !== null) {
      return {
        state: 'ok',
        path: result.resolved.path,
        version: result.resolved.version,
        source: result.resolved.source,
      }
    }

    const attempts: AdbAttempt[] = result.attempts.map((attempt) => ({
      path: attempt.path,
      source: attempt.source,
      ok: attempt.ok,
      code: attempt.code,
    }))
    return { state: 'error', code: lastFailureCode(attempts), attempts }
  }
}

/**
 * 取「最能解释为什么一个都用不了」的错误码：最后一个候选的结论。
 * 候选顺序是 custom > env > bundled > path，path 是最终兜底 ——
 * 用户自定义路径配错时 path 往往还能用；path 也不行才说明真没有 adb。
 */
function lastFailureCode(attempts: readonly AdbAttempt[]): string {
  for (let i = attempts.length - 1; i >= 0; i--) {
    const code = attempts[i].code
    if (code !== undefined && code !== '') return code
  }
  return E_ADB_NOT_FOUND
}

/** 路径指纹：用来判断「adb 路径变了，缓存要作废」。 */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export interface AdbTrackingOptions {
  /** 已解析出的 adb 绝对路径。 */
  adbPath: string
  /**
   * 复用调用方已有的会话表。
   * 主进程必须在 adb 自检完成【之前】就注册好 IPC handler（否则渲染层首屏 invoke 会
   * 撞上 "No handler registered"），而 tracker 要等自检拿到路径才能起 ——
   * 于是会话表先建、跟踪器后建，两者共用同一个 DeviceManager。
   */
  manager?: DeviceManager
  /** 仅测试注入：替换 spawn(adb, ['track-devices'])。 */
  spawnTrack?: () => ChildProcess
  /** 仅测试注入：替换一次 adb devices -l。 */
  pollDevices?: () => Promise<string>
  /** 合并窗口，默认 50ms。 */
  coalesceMs?: number
  /** 取当前 adb 自检状态；随每次推送下发给渲染层。 */
  adbState?: () => AdbState
}

/**
 * 设备跟踪的一整套（manager + tracker + 变更合并）。
 * main.ts 只需要 start() 与 stop()，不需要知道内部有几个定时器几条流。
 */
export class AdbTracking {
  readonly mgr: DeviceManager
  readonly tracker: DeviceTracker
  private readonly changes: DeviceChangeTracker
  private stopped = false

  constructor(options: AdbTrackingOptions) {
    this.mgr = options.manager ?? new DeviceManager()
    // 时区缓存失效（裁决 6 / 任务 5 N1）在这里闭环：DeviceChangeTracker 在
    // 「掉线 / 重连」两个边界上调用 clearDeviceSerialTzCache(serial)。
    // 设备时区可能已被用户在拔插之间改过，不清就会一直按旧偏移解释 ls 的时间列。
    this.changes = new DeviceChangeTracker(
      this.mgr,
      clearDeviceSerialTzCache,
      options.adbState ?? (() => ({ state: 'checking' })),
      options.coalesceMs,
    )
    this.tracker = new DeviceTracker({
      adbPath: options.adbPath,
      manager: this.mgr,
      spawnTrack: options.spawnTrack,
      pollDevices: options.pollDevices,
    })
  }

  /** 订阅去重后的设备变更（已按窗口合并）。 */
  onDevicesChanged(listener: (batch: DevicesChangedBatch) => void): () => void {
    return this.changes.onPush(listener)
  }

  /** 变更去重表（devices:list 的首屏快照、诊断用）。 */
  get changeTracker(): DeviceChangeTracker {
    return this.changes
  }

  start(): void {
    this.stopped = false
    this.tracker.start()
  }

  /** 通知「adb 自检状态可能变了」（自检是异步的，比窗口晚结束是常态）。 */
  notifyAdbState(): void {
    this.changes.notifyAdbState()
  }

  /**
   * 立即把挂起的变更批次推出去。
   * 生产上用于退出前收尾（别把最后一批变化憋在 50ms 窗口里）；
   * 测试用来避免依赖真实定时器。
   */
  flushChanges(): void {
    this.changes.flush()
  }

  /** 停止跟踪并回收。幂等；退出时必须调用（否则定时器与子进程会挂住进程）。 */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.tracker.stop()
    this.changes.dispose()
  }

  get isStopped(): boolean {
    return this.stopped
  }

  /** 造一个带 serial 的 client（所有设备命令的唯一入口）。 */
  clientFactory(serial: string): AdbClient {
    return new AdbClient(serial)
  }
}

/**
 * 装配一个设备跟踪集。测试注入 spawnTrack / pollDevices 即可不产生真子进程。
 * 直接返回 AdbTracking（而不是再包一层 {tracking}）：调用方只需要 start/stop/onDevicesChanged，
 * 多一层壳只会让 main.ts 和测试都多写一次解构。
 */
export function createAdbTracking(options: AdbTrackingOptions): AdbTracking {
  return new AdbTracking(options)
}

/** 造一个 client（不依赖 tracker 是否已起）。IPC handler 在自检完成前就需要它。 */
export function createClient(serial: string): AdbClient {
  return new AdbClient(serial)
}

/** 找到一台已建立的会话；没连过就是 undefined（fs:list 据此拒收渲染层给的任意 serial）。 */
export function findSession(mgr: DeviceManager, serial: string): DeviceSession | undefined {
  return mgr.get(serial)
}