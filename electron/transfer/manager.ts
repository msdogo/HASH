import type { TransferTask } from '../../src/shared/transfer'
import { ProgressGate, percentOf } from '../../src/shared/transfer'
import { E_ABORTED, E_DEVICE_OFFLINE } from '../../src/shared/errors'
import { TransferQueue, type EnqueueInput, type QueueConfig } from './queue'
import type { RunContext, TransferRun } from './runner'

/**
 * 传输调度器（裁决 4 / 6 / 7）：把「队列决策」与「真正执行」接起来。
 *
 * 为什么执行器是【注入】的，而不是在这里直接 new TransferRunner：
 *   并发不变量（同设备 ≤1、全局 ≤3、掉线暂停）必须能被确定性地测出来。
 *   如果这里直接起真 adb，任何并发断言都会变成「靠设备速度计时」的脆弱测试，
 *   而且没法构造「三台设备同时跑满」这种瞬时状态。
 *
 * 一次传输的事件流：
 *   enqueue → pump → execute(可注入)  ──进度──▶ 闸门节流 ▶ emit('progress')
 *                                    └─完成/失败─▶ queue.finish ▶ emit('done'/'failed') ▶ pump（补位）
 */

/** 执行器签名：真正干活的一方实现它（生产里是 TransferRunner.run）。 */
export type Executor = (task: TransferRun, ctx: RunContext) => Promise<{ ok: true; bytes?: number; overwrote?: boolean } | { ok: false; code: string }>

/** 对外事件（主进程转成 IPC 推送）。 */
export type TransferEvent =
  | { type: 'added'; task: TransferTask }
  | { type: 'progress'; task: TransferTask }
  | { type: 'done'; task: TransferTask }
  | { type: 'failed'; task: TransferTask }
  | { type: 'canceled'; task: TransferTask }
  | { type: 'changed'; task: TransferTask }

/** 调度器依赖。 */
export interface ManagerDeps {
  /** 真正执行一个传输。 */
  execute: Executor
  /** 事件出口（节流后的进度也从这里出）。 */
  emit: (event: TransferEvent) => void
  /** 单设备 / 全局并发。 */
  maxPerDevice?: number
  maxGlobal?: number
  /** 时钟注入（节流窗口测试用）。 */
  now?: () => number
  /** 预取总量（push 本地 stat / pull 远程 stat）。拿不到返回 null。 */
  resolveTotalBytes?: (task: TransferTask) => Promise<number | null>
}

/** 在跑任务的收尾句柄。 */
interface ActiveRun {
  controller: AbortController
  /** 用户主动取消（与掉线暂停区分：两者都要 abort，但错误码不同）。 */
  canceledByUser: boolean
}

export class TransferManager {
  readonly queue: TransferQueue
  private readonly active = new Map<string, ActiveRun>()
  /** 每个任务一把进度闸门（裁决 6）。 */
  private readonly gates = new Map<string, ProgressGate>()
  private readonly execute: Executor
  private readonly emitEvent: (event: TransferEvent) => void
  private readonly now: () => number
  private readonly resolveTotal: (task: TransferTask) => Promise<number | null>
  /** 防止 pump 重入（execute 同步完成时会递归）。 */
  private pumping = false

  constructor(deps: ManagerDeps) {
    this.queue = new TransferQueue({
      maxPerDevice: deps.maxPerDevice,
      maxGlobal: deps.maxGlobal,
      now: deps.now,
    } satisfies QueueConfig)
    this.execute = deps.execute
    this.emitEvent = deps.emit
    this.now = deps.now ?? (() => Date.now())
    this.resolveTotal = deps.resolveTotalBytes ?? (async () => null)
  }

  /** 入队并尝试立刻开跑。返回入队后的任务。 */
  enqueue(input: EnqueueInput): TransferTask {
    const task = this.queue.enqueue(input)
    this.emitEvent({ type: 'added', task })
    // 总量未知时后台补一次探测：拿到就补上，拿不到就永远不确定（裁决 5）
    if (task.totalBytes === null) {
      void this.resolveTotal(task).then((total) => {
        if (total === null) return
        // 任务可能还没跑完，也可能已被清掉
        if (this.queue.get(task.id) === undefined) return
        task.totalBytes = total
        this.emitEvent({ type: 'changed', task })
      }).catch(() => { /* 探测失败不影响任务本身 */ })
    }
    this.pump()
    return task
  }

  /**
   * 尽量把队列填满。
   *
   * 用 pumping 标志防止重入：execute 若同步完成，finish → pump → ... 会递归几十层；
   * 更糟的是同一 tick 内可能重复给同一设备派活，破坏单设备并发 1。
   */
  pump(): void {
    if (this.pumping) return
    this.pumping = true
    try {
      for (;;) {
        const id = this.queue.next()
        if (id === null) return
        this.start(id)
      }
    } finally {
      this.pumping = false
    }
  }

  /** 真正开始一个任务（同步登记，异步执行）。 */
  private start(id: string): void {
    const task = this.queue.get(id)
    if (task === undefined) return

    const controller = new AbortController()
    this.active.set(id, { controller, canceledByUser: false })
    this.gates.set(id, new ProgressGate())

    void this.runTask(task, controller.signal).catch(() => {
      // runTask 内部已经把所有失败路径收敛成 finish；这里只兜住意外异常，
      // 绝不能让一个未捕获的 Promise 把进程带崩。
      this.finishFailed(task, 'E_SYNC_FAILED')
    })
  }

  private async runTask(task: TransferTask, signal: AbortSignal): Promise<void> {
    const gate = this.gates.get(task.id)
    const run: TransferRun = {
      id: task.id,
      serial: task.serial,
      direction: task.direction,
      src: task.src,
      dst: task.dst,
      totalBytes: task.totalBytes,
    }

    const ctx: RunContext = {
      signal,
      onProgress: (doneBytes) => {
        this.queue.progress(task.id, doneBytes)
        const percent = percentOf(task.doneBytes, task.totalBytes)
        // 裁决 6：节流在主进程侧做，渲染层不该被进度事件淹没
        if (gate !== undefined && !gate.accept(percent, this.now())) return
        this.emitEvent({ type: 'progress', task })
      },
    }

    let outcome: Awaited<ReturnType<Executor>>
    try {
      outcome = await this.execute(run, ctx)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      outcome = { ok: false, code: message.includes(E_ABORTED) ? E_ABORTED : 'E_SYNC_FAILED' }
    }

    const active = this.active.get(task.id)
    this.active.delete(task.id)
    this.gates.delete(task.id)

    // 用户取消：任务已是 canceled（cancel() 里先改的状态），不要再覆盖成 failed
    if (active?.canceledByUser === true || (outcome.ok === false && outcome.code === E_ABORTED)) {
      if (this.queue.get(task.id)?.status === 'running') {
        this.queue.cancel(task.id)
      }
      this.emitEvent({ type: 'canceled', task })
      this.pump()
      return
    }

    if (outcome.ok) {
      // 汇总行的权威字节数（可能来自 execute 的第二返回值）
      if (typeof outcome.bytes === 'number' && Number.isFinite(outcome.bytes)) {
        this.queue.progress(task.id, outcome.bytes)
      }
      this.queue.complete(task.id, outcome.overwrote === true)
      this.emitEvent({ type: 'done', task })
      this.pump()
      return
    }

    this.finishFailed(task, outcome.code)
  }

  private finishFailed(task: TransferTask, code: string): void {
    this.active.delete(task.id)
    this.gates.delete(task.id)
    if (this.queue.get(task.id)?.status !== 'running') return
    this.queue.finish(task.id, 'failed', code)
    this.emitEvent({ type: 'failed', task })
    this.pump()
  }

  /**
   * 取消（裁决 3：真杀进程树）。
   *
   * 在跑的：abort 该任务的 signal —— AdbClient 会 killTree 整棵进程树并且 reject E_ABORTED，
   * 所以「Promise settle 了但进程还在」这条路被堵死了。
   * 排队中的：直接标 canceled，没有进程要杀。
   */
  cancel(id: string): boolean {
    const task = this.queue.get(id)
    if (task === undefined) return false
    const active = this.active.get(id)
    if (active !== undefined) active.canceledByUser = true
    const changed = this.queue.cancel(id)
    if (!changed) return false
    if (active !== undefined) {
      // abort 会驱动 AbortClient killTree；runTask 随后走 canceled 分支
      active.controller.abort()
    } else {
      this.emitEvent({ type: 'canceled', task })
      this.pump()
    }
    return true
  }

  /** 重试（裁决 7）：放回队列并尝试开跑。 */
  retry(id: string): boolean {
    const ok = this.queue.retry(id)
    if (!ok) return false
    const task = this.queue.get(id)
    if (task !== undefined) this.emitEvent({ type: 'changed', task })
    this.pump()
    return true
  }

  /**
   * 设备上下线（裁决 4）。
   *
   * 掉线时：
   *   1. 在跑的任务立即 abort（设备没了，继续跑只会卡到超时）并标失败可重试；
   *   2. 排队任务留在队列里（queue.setDeviceOnline 会让它们不出队）；
   *   3. 其它设备不受影响 —— pump 只跳过该 serial。
   */
  setDeviceOnline(serial: string, online: boolean): void {
    this.queue.setDeviceOnline(serial, online)
    if (online) {
      this.pump()
      return
    }
    for (const [id, active] of [...this.active]) {
      const task = this.queue.get(id)
      if (task === undefined || task.serial !== serial) continue
      // 先用掉线错误码把任务判失败（可重试），再 abort 让进程死掉
      this.queue.finish(id, 'failed', E_DEVICE_OFFLINE)
      this.emitEvent({ type: 'failed', task })
      this.active.delete(id)
      this.gates.delete(id)
      active.controller.abort()
    }
    this.pump()
  }

  get(id: string): TransferTask | undefined { return this.queue.get(id) }
  list(): TransferTask[] { return this.queue.list() }
  runningCount(serial?: string): number { return this.queue.runningCount(serial) }
  snapshot() { return this.queue.snapshot() }
  clearFinished(): number { return this.queue.clearFinished() }

  /** 应用退出：取消所有在跑任务并清空状态（进程回收由 children 的闸门兜底）。 */
  dispose(): void {
    for (const [id, active] of this.active) {
      this.queue.cancel(id)
      active.controller.abort()
    }
    this.active.clear()
    this.gates.clear()
  }
}
