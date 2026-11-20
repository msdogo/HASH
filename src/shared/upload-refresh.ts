import type { TransferTask } from './transfer'
import { canonicalRemotePath, remoteParent } from './path-guard'

/**
 * 上传「真正传完」后自动刷新当前目录（R4 事项 1）。
 *
 * ===== 修前到底错在哪 =====
 * FilesPage 只在上传**入队成功**时刷一次（enqueue 返回后立刻 refresh），而 adb push
 * 是排队异步跑的，几秒到几分钟之后才真正落盘。用户看到的现象是：
 * 「底栏显示已完成，但文件列表里没有这个文件」——只能手动点右上角刷新。
 *
 * ===== 为什么判断必须是 shared 里的纯函数 =====
 * 1. 本工程没有 jsdom（environment: node），组件里的 useEffect 在 SSR 下一次都不跑，
 *    把判断写进 effect 就是零门禁；
 * 2. 这个判断有 5 个条件（方向 / 终态 / 设备 / 目录 / 别名归一），每一条都能单独写错，
 *    必须能逐条喂输入断言。
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块。
 */

/**
 * 同一次上传的多个文件会在极短时间内连续进入终态（一次 push 多个文件时几乎同毫秒）。
 *
 * 300ms 的取舍：
 *   - 太短（如 0）：一次 10 个文件的上传会触发 10 次 fs:list，万级目录下每次都是
 *     一整轮 adb ls，界面会被自己的刷新拖住；
 *   - 太长（如 2s）：用户点了上传后要干等两秒才看到文件出现，还不如手动刷。
 * 另外这里是**尾沿防抖**（每次新事件都续期），不是「固定窗口内只刷一次」：
 * 固定窗口会把「窗口内后完成的那几个文件」永久丢掉（刷新发生在它们落盘之前），
 * 而尾沿防抖保证刷新一定发生在**最后一个文件**落盘之后。
 */
export const TERMINAL_REFRESH_QUIET_MS = 300

/**
 * 这条传输任务成功后，是否应该刷新「当前设备当前目录」的列表。
 *
 * 五个条件全部满足才刷（少一条都会误刷或漏刷）：
 * 1. `direction === 'push'`：只关心上传。下载落的是本地目录，刷远程列表没有意义；
 * 2. `status === 'done'`：只有成功才刷。失败/取消时设备上**没有**新文件，
 *    刷新只会让用户以为「文件好像进去了」，是误导；
 * 3. `task.serial === activeSerial`：多设备并发时，A 机的完成事件不能刷 B 机的列表；
 * 4. `remoteParent(task.dst) === currentCwd`：文件必须落在**当前正在看的**目录，
 *    否则刷新是白跑一次 adb ls；
 * 5. 比较前**归一化**：/sdcard 与 /storage/emulated/0 是同一批 inode 的别名，
 *    纯字符串比较会把「文件明明就在这儿」判成不同目录。归一统一走
 *    path-guard 的 canonicalRemotePath（本文件不自己写一份前缀表，
 *    否则加一个新别名就要改 N 处，必然漏 —— 与 isRemoteInside 同一条纪律）。
 */
export function shouldRefreshAfterTask(
  task: TransferTask,
  activeSerial: string | null,
  currentCwd: string,
): boolean {
  if (activeSerial === null) return false
  if (task.direction !== 'push') return false
  if (task.status !== 'done') return false
  if (task.serial !== activeSerial) return false
  if (currentCwd === '') return false
  // dst 是完整路径（push 时 = 设备上的落点），目录部分用 path-guard 的 remoteParent 取，
  // 不在这里手写 lastIndexOf('/')：那里已经处理了根、重复斜杠与尾斜杠。
  const dir = remoteParent(task.dst)
  if (dir === null) return false
  return canonicalRemotePath(dir) === canonicalRemotePath(currentCwd)
}

/**
 * 从「上一份快照 → 新快照」里挑出**刚刚**完成、且命中上面五条条件的任务。
 *
 * 为什么不能直接遍历新快照：主进程的进度推送是**整份快照**（见 transferStore），
 * 同一台设备传 1GB 时每秒会推十几次；每次推送里那条已完成的任务仍然在列表里，
 * 直接遍历会把它反复算成「刚刚完成」，于是刷个没完。
 * 所以必须与上一份快照对比：只有「上一份还不是 done」而这一份是 done 的才算新完成
 * （顺带覆盖了「失败 → 重试 → 成功」这条路径）。
 */
export function newlyDoneUploads(
  previous: readonly TransferTask[],
  next: readonly TransferTask[],
  activeSerial: string | null,
  currentCwd: string,
): TransferTask[] {
  const before = new Map(previous.map((task) => [task.id, task.status]))
  const fresh: TransferTask[] = []
  for (const task of next) {
    if (!shouldRefreshAfterTask(task, activeSerial, currentCwd)) continue
    if (before.get(task.id) === 'done') continue
    fresh.push(task)
  }
  return fresh
}

/**
 * 尾沿防抖的**纯**状态（时间从外面注入）。
 *
 * 抽出来是为了让「合并刷新」这件事本身有门禁：真实接线里 setTimeout 与 store 订阅
 * 都不可观测（无 jsdom），但 note/take 的时序语义可以喂假时钟逐条断言。
 */
export class TerminalRefreshCoalescer {
  private dueAt: number | null = null

  constructor(private readonly quietMs: number = TERMINAL_REFRESH_QUIET_MS) {}

  /** 收到一条命中事件：从现在起再安静 quietMs 才刷；已有挂起则**续期**。返回新的到期时刻。 */
  note(now: number): number {
    this.dueAt = now + this.quietMs
    return this.dueAt
  }

  /**
   * 定时器到点：到期才返回 true（并清空挂起）。
   *
   * 未到期返回 false 是有意的 —— 那说明这段时间里又来了新事件（已续期），
   * 这一次的定时器作废，刷新由续期后的那一次负责。
   */
  take(now: number): boolean {
    if (this.dueAt === null) return false
    if (now < this.dueAt) return false
    this.dueAt = null
    return true
  }

  /** 是否有挂起的刷新（卸载时要据此取消定时器）。 */
  get pending(): boolean {
    return this.dueAt !== null
  }

  reset(): void {
    this.dueAt = null
  }
}

/** 「当前设备 + 当前目录」——每次要用时现取，不能在订阅建立时固定住。 */
export interface RefreshContext {
  serial: string | null
  cwd: string
}

/** 看门狗的外部依赖（全部注入：真实生产 / 假时钟测试共用同一份实现）。 */
export interface TerminalRefreshWatcherDeps {
  /** 现取上下文：用户随时会切设备/切目录，判定必须用**事件到来时**的那一份。 */
  readContext: () => RefreshContext
  /** 真正触发一次列表刷新（生产 = fileStore.refresh）。 */
  refresh: (serial: string) => void
  /** 调度一次延迟回调，返回取消函数（生产 = setTimeout/clearTimeout）。 */
  schedule: (delayMs: number, run: () => void) => () => void
  quietMs?: number
  now?: () => number
}

export interface TerminalRefreshWatcher {
  /** 喂一份新快照（生产由 useTransferStore.subscribe 调用）。 */
  onSnapshot: (tasks: readonly TransferTask[]) => void
  /** 卸载：退订由调用方负责，这里只取消挂起的刷新（幂等）。 */
  dispose: () => void
}

/**
 * 把「新快照 → 是否该刷 → 合并成一次刷新」这条**判断链**装成一个可测的看门狗。
 *
 * 为什么整条链都放 shared（而不是在 FilesPage 里写 useEffect）：
 * 组件里的订阅回调在无 jsdom 的工程里一次都跑不到，等于零门禁；
 * 而这里除了 `schedule` 的真实实现（setTimeout）之外，其余每一步都能用假时钟驱动。
 * 组件侧只剩三行接线（订阅 / 传快照 / 卸载），已如实登记进「已知无门禁清单」。
 *
 * 两条刻意保留的保守行为：
 *   - **到点复查**：刷之前重新问一次「现在还该刷吗」（用同一个 shouldRefreshAfterTask）。
 *     用户在 300ms 里切走设备或切走目录时，就不刷了 —— 否则会去刷一个用户已经不看的
 *     列表（多一次无意义的 adb ls），以及最坏情况下刷错设备；
 *   - **起始快照不算完成**：进文件页时上一次会话遗留的 done 任务不触发刷新，
 *     否则每次进页面都会白刷一次。
 */
export function createTerminalRefreshWatcher(
  deps: TerminalRefreshWatcherDeps,
  initialTasks: readonly TransferTask[],
): TerminalRefreshWatcher {
  const quietMs = deps.quietMs ?? TERMINAL_REFRESH_QUIET_MS
  const now = deps.now ?? ((): number => Date.now())
  const coalescer = new TerminalRefreshCoalescer(quietMs)
  let previous = initialTasks
  /** 最近一条命中的任务：到点时用它重新确认上下文（而不是拿建立订阅时的那份）。 */
  let pendingTask: TransferTask | null = null
  let cancel: (() => void) | null = null
  let disposed = false

  const arm = (): void => {
    if (cancel !== null) cancel()
    cancel = deps.schedule(quietMs, () => {
      cancel = null
      if (disposed) return
      // 到点复查：这段时间里若又来了新事件（已续期），这一次就作废
      if (!coalescer.take(now())) {
        arm()
        return
      }
      const task = pendingTask
      pendingTask = null
      if (task === null) return
      const context = deps.readContext()
      if (!shouldRefreshAfterTask(task, context.serial, context.cwd)) return
      deps.refresh(task.serial)
    })
  }

  return {
    onSnapshot: (tasks) => {
      if (disposed) return
      const context = deps.readContext()
      const fresh = newlyDoneUploads(previous, tasks, context.serial, context.cwd)
      previous = tasks
      if (fresh.length === 0) return
      // 同一批里可能有多条（一次拖 10 个文件），记最后一条即可 ——
      // 它们满足同一组条件（同一个 serial、同一个目录），刷新一次就够
      pendingTask = fresh[fresh.length - 1] ?? null
      coalescer.note(now())
      arm()
    },
    dispose: () => {
      disposed = true
      if (cancel !== null) cancel()
      cancel = null
      pendingTask = null
      coalescer.reset()
    },
  }
}
