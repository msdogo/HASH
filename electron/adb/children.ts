import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

/**
 * 在手 adb 子进程登记表 + 全局关闭闸门 —— 全应用唯一一份。
 *
 * 红线：「所有子进程在窗口关闭时回收」。任何模块只要 spawn 了 adb 子进程，
 * 就必须经 spawnTracked() 起（它会自动登记），否则退出时会在 Windows 上留下孤儿进程。
 * 这份实现被 client.ts（任务 2）、binary.ts（任务 3 的 probe）与 track.ts（任务 4）共用。
 *
 * ===== 为什么需要关闭闸门（审查轮 2 / I5）=====
 * 修前只有 killAllAdbChildren()，它只杀【当刻在册】的进程。
 * 复审实测：killAll 之后，一个正在 await、马上要 spawn 的调用仍会拉起新子进程，
 * 父进程退出后它存活（pid 45740）。
 * 也就是说「窗口关闭时回收全部子进程」这条红线在「退出与 spawn 竞争」的时刻是不成立的。
 *
 * 修法：加一个单向的 closed 闸门。
 *   - shutdownChildren()：置位 closed，然后 kill 全部在册进程；
 *   - spawnTracked()：closed 时直接返回 null，**根本不 spawn**；
 *   - trackChild()：closed 时立即 kill 传来的 child 并返回 false，
 *     覆盖「不经过 spawnTracked 的登记」（测试注入、未来新增代码）。
 * 闸门是单向的（进程生命周期内不会重新打开），避免「关了一半又允许 spawn」的歧义。
 */
const live = new Set<ChildProcess>()

/** 关闭闸门是否已置位。 */
let closed = false

/** 当前在手的 adb 子进程数量（测试与诊断用）。 */
export function adbChildCount(): number {
  return live.size
}

/** 关闭闸门是否已置位（测试与诊断用）。 */
export function childrenClosed(): boolean {
  return closed
}

/**
 * 登记一个刚 spawn 出来的 adb 子进程。
 * @returns 是否被接受。闸门已关闭时返回 false，并且会立刻 kill 这个 child
 *          —— 调用方据此直接失败，绝不能让一个「迟到的」进程逃过退出回收。
 */
export function trackChild(child: ChildProcess): boolean {
  if (closed) {
    killTree(child)
    return false
  }
  live.add(child)
  return true
}

/** 从登记表移除。必须在子进程的单一出口（close / error / 超时）里调用，避免泄漏计数。 */
export function untrackChild(child: ChildProcess): void {
  live.delete(child)
}

/**
 * 所有 adb 子进程的统一 spawn 出入口。
 *
 * 为什么不让各模块直接 spawn + trackChild：
 * 那样「先 spawn 后检查闸门」之间永远有一个窗口 —— 进程已经在跑了，闸门才发现要关。
 * 把 spawn 本身收进这个函数，检查与创建之间没有 await、没有回调，窗口被压到零。
 *
 * @returns 子进程；闸门已关闭时返回 null（**不 spawn**）。
 */
export function spawnTracked(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess | null {
  if (closed) return null
  const child = spawn(command, args, options)
  // spawn 本身可能同步抛错（调用方各自 try/catch），这里只负责登记
  live.add(child)
  return child
}

/**
 * 终结整棵进程树。
 * Windows 上 child.kill() 只终结直接子进程，cmd/adb 派生的孙进程会存活，必须走 taskkill /T /F；
 * POSIX 上用 detached 建立的进程组，对 -pid 发信号即可整组终结。
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) {
    child.kill()
    return
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/** 回收全部在手 adb 子进程（不置位闸门；用于测试重置与普通清理）。 */
export function killAllAdbChildren(): void {
  for (const child of live) killTree(child)
  live.clear()
}

/**
 * 置位关闭闸门并回收全部在手子进程（app.on('before-quit') 调用）。
 *
 * 与 killAllAdbChildren 的区别就是这个闸门：调用之后**任何**新的 spawn 都会被拒，
 * 所以「退出与 spawn 竞争」不再可能留下孤儿进程。幂等。
 */
export function shutdownChildren(): void {
  closed = true
  killAllAdbChildren()
}
