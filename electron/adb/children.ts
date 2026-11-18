import { spawn, type ChildProcess } from 'node:child_process'

/**
 * 在手 adb 子进程登记表 —— 全应用唯一一份。
 *
 * 红线：「所有子进程在窗口关闭时回收」。任何模块只要 spawn 了 adb 子进程，
 * 就必须登记到这里，否则 killAllAdbChildren() 枚举不到它，窗口退出后进程会在 Windows 上存活。
 * 这份实现被 client.ts（任务 2）与 binary.ts（任务 3 的 probe）共用，不要复制第二套。
 */
const live = new Set<ChildProcess>()

/** 当前在手的 adb 子进程数量（测试与诊断用）。 */
export function adbChildCount(): number {
  return live.size
}

/** 登记一个刚 spawn 出来的 adb 子进程。必须紧跟 spawn 之后调用。 */
export function trackChild(child: ChildProcess): void {
  live.add(child)
}

/** 从登记表移除。必须在子进程的单一出口（close / error / 超时）里调用，避免泄漏计数。 */
export function untrackChild(child: ChildProcess): void {
  live.delete(child)
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

/** 回收全部在手 adb 子进程（app.on('before-quit') 调用）。 */
export function killAllAdbChildren(): void {
  for (const child of live) killTree(child)
  live.clear()
}
