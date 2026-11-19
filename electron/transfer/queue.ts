import { randomUUID } from 'node:crypto'
import type { Direction, TransferSnapshot, TransferStatus, TransferTask } from '../../src/shared/transfer'

/**
 * 传输队列：只做【状态与并发决策】，绝不 spawn 进程（裁决 4）。
 *
 * 这样切分的理由：并发不变量必须能被廉价、确定地测出来。
 * 如果队列自己调 adb，任何一条断言都会变成「靠真设备计时」的脆弱测试。
 * 真正干活的是 manager（注入执行器）与 runner（注入 AdbClient）。
 *
 * 三条不变量：
 *   1. 同一 serial 同时最多 maxPerDevice 个在跑（规格：1，FIFO）；
 *   2. 全局同时最多 maxGlobal 个在跑（规格：默认 3，设置可调 1-6）；
 *   3. 掉线设备（setDeviceOnline(serial, false)）的任务一律不出队，但【保留可重试】，
 *      且不占用全局并发额度 —— 否则一台挂掉的设备会白白占住别的设备的通道。
 */

/** 队列配置。 */
export interface QueueConfig {
  /** 单设备并发，默认 1（规格）。 */
  maxPerDevice?: number
  /** 全局并发，默认 3（规格：1-6 可调）。 */
  maxGlobal?: number
  /** 时钟注入（测试用）。 */
  now?: () => number
}

/** 入队参数。 */
export interface EnqueueInput {
  serial: string
  direction: Direction
  src: string
  dst: string
  /** 拿不到总量时传 null（界面走不确定态，裁决 5）。 */
  totalBytes?: number | null
}

/** 快照里的计数。 */
export interface QueueSnapshot extends TransferSnapshot {}

/** 可重试的状态集合（裁决 7：失败与被取消的都能重试）。 */
const RETRYABLE: ReadonlySet<TransferStatus> = new Set<TransferStatus>(['failed', 'canceled'])

export class TransferQueue {
  /** 单设备并发上限。 */
  readonly maxPerDevice: number
  /** 全局并发上限。 */
  readonly maxGlobal: number

  private readonly tasks = new Map<string, TransferTask>()
  /** 在跑的任务 id（顺序无关，计数用）。 */
  private readonly running = new Set<string>()
  /** 掉线的 serial 集合；不在集合里即视为在线。 */
  private readonly offline = new Set<string>()
  private readonly now: () => number

  constructor(config: QueueConfig = {}) {
    this.maxPerDevice = config.maxPerDevice ?? 1
    this.maxGlobal = config.maxGlobal ?? 3
    this.now = config.now ?? (() => Date.now())
  }

  /** 入队。返回的任务对象是【内部实例】，调用方不应直接改写它。 */
  enqueue(input: EnqueueInput): TransferTask {
    const total = input.totalBytes ?? null
    const task: TransferTask = {
      id: randomUUID(),
      serial: input.serial,
      direction: input.direction,
      src: input.src,
      dst: input.dst,
      // 负总量/非有限数一律当未知，绝不留下会让百分比算疯的值
      totalBytes: total !== null && Number.isFinite(total) && total >= 0 ? total : null,
      doneBytes: 0,
      status: 'queued',
      attempt: 0,
      createdAt: this.now(),
    }
    this.tasks.set(task.id, task)
    return task
  }

  /**
   * 取下一条可以开跑的任务（FIFO），没有则返回 null。
   *
   * 这里的「取」是**有副作用**的：返回的任务立刻进入 running 并占用并发额度。
   * 调用方要么在成功后 finish，要么在失败后 finish —— 绝不能取了不还。
   */
  next(): string | null {
    if (this.running.size >= this.maxGlobal) return null

    // 每台设备当前在跑数量
    const perDevice = new Map<string, number>()
    for (const id of this.running) {
      const running = this.tasks.get(id)
      if (running === undefined) continue
      perDevice.set(running.serial, (perDevice.get(running.serial) ?? 0) + 1)
    }

    // Map 保持插入顺序 → 遍历即 FIFO
    for (const task of this.tasks.values()) {
      if (task.status !== 'queued') continue
      // 掉线设备：不出队，但任务留在队列里（可重试，裁决 4）
      if (this.offline.has(task.serial)) continue
      if ((perDevice.get(task.serial) ?? 0) >= this.maxPerDevice) continue

      this.running.add(task.id)
      perDevice.set(task.serial, (perDevice.get(task.serial) ?? 0) + 1)
      task.status = 'running'
      return task.id
    }
    return null
  }

  /** 更新进度（夹在 0..totalBytes；总量未知时只夹下界）。 */
  progress(id: string, doneBytes: number): void {
    const task = this.tasks.get(id)
    if (task === undefined) return
    if (!Number.isFinite(doneBytes)) return
    const floored = Math.max(0, doneBytes)
    task.doneBytes = task.totalBytes === null ? floored : Math.min(floored, task.totalBytes)
  }

  /** 进入终态。running 额度在这里释放。 */
  finish(id: string, status: TransferStatus, error?: string, overwrote?: boolean): void {
    const task = this.tasks.get(id)
    if (task === undefined) return
    task.status = status
    // done 时清掉旧错误码（重试成功后不该还带着上次的失败原因）
    task.error = status === 'failed' ? error : undefined
    if (overwrote === true) task.overwrote = true
    if (status === 'done' && task.totalBytes !== null) task.doneBytes = task.totalBytes
    task.finishedAt = this.now()
    this.running.delete(id)
  }

  /** 标记完成。 */
  complete(id: string, overwrote?: boolean): void {
    this.finish(id, 'done', undefined, overwrote)
  }

  /**
   * 取消。
   *
   * 排队中的：直接置 canceled（还不占并发，也没进程要杀）。
   * 在跑的：只释放额度并置 canceled —— **杀进程是 manager 的事**，
   * 队列不持有进程句柄，越权去杀会让「谁负责收尾」含糊不清。
   */
  cancel(id: string): boolean {
    const task = this.tasks.get(id)
    if (task === undefined) return false
    if (task.status !== 'queued' && task.status !== 'running') return false
    task.status = 'canceled'
    task.error = undefined
    task.finishedAt = this.now()
    this.running.delete(id)
    return true
  }

  /**
   * 重试（裁决 7）：把 failed / canceled 放回队列。
   *
   * 进度归零是刻意的 —— 不做断点续传（ADR-04），重试就是从头再来，
   * 保留旧 doneBytes 会让进度条从半路开始，用户会以为续传生效了。
   */
  retry(id: string): boolean {
    const task = this.tasks.get(id)
    if (task === undefined) return false
    if (!RETRYABLE.has(task.status)) return false
    task.status = 'queued'
    task.doneBytes = 0
    task.error = undefined
    task.attempt += 1
    task.overwrote = undefined
    task.finishedAt = undefined
    return true
  }

  /** 设备上下线（裁决 4）。下线不丢任务，只是暂停出队。 */
  setDeviceOnline(serial: string, online: boolean): void {
    if (online) this.offline.delete(serial)
    else this.offline.add(serial)
  }

  /** 该设备是否被判为掉线。 */
  isDeviceOnline(serial: string): boolean {
    return !this.offline.has(serial)
  }

  /** 该设备当前被暂停的排队任务（界面提示「设备离线，等待重连」用）。 */
  pausedOnOffline(serial: string): TransferTask[] {
    if (!this.offline.has(serial)) return []
    const out: TransferTask[] = []
    for (const task of this.tasks.values()) {
      if (task.serial === serial && task.status === 'queued') out.push(task)
    }
    return out
  }

  get(id: string): TransferTask | undefined {
    return this.tasks.get(id)
  }

  /** 全部任务（入队顺序）。 */
  list(): TransferTask[] {
    return [...this.tasks.values()]
  }

  /** 在跑数量；给 serial 时只数该设备。 */
  runningCount(serial?: string): number {
    if (serial === undefined) return this.running.size
    let count = 0
    for (const id of this.running) {
      if (this.tasks.get(id)?.serial === serial) count += 1
    }
    return count
  }

  /** 该任务是否正在跑。 */
  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  /** 给渲染层的快照。 */
  snapshot(): QueueSnapshot {
    const tasks = this.list()
    let running = 0
    let queued = 0
    for (const task of tasks) {
      if (task.status === 'running') running += 1
      else if (task.status === 'queued') queued += 1
    }
    return { tasks, running, queued }
  }

  /**
   * 清掉已完成的任务。
   *
   * 只清 done：失败与被取消的任务必须留在列表里（裁决 7「一键重试」），
   * 清掉就等于把用户唯一的重试入口也删了。
   */
  clearFinished(): number {
    let removed = 0
    for (const task of [...this.tasks.values()]) {
      if (task.status === 'done') {
        this.tasks.delete(task.id)
        this.running.delete(task.id)
        removed += 1
      }
    }
    return removed
  }
}
