import type { ChildProcess } from 'node:child_process'
import { spawnTracked, killTree } from '../adb/children'

/**
 * scrcpy 进程的真实实现。
 *
 * ===== 为什么单独一层 =====
 * service.ts 只负责「会话表与生命周期编排」，它需要能在纯 node 测试里跑（假 spawn）；
 * 真正碰 child_process 的部分收在这里，与 capture/recorder.ts 同一分层手法。
 */

export interface StartScrcpyDeps {
  /** scrcpy.exe 绝对路径。 */
  scrcpyPath: string
  /**
   * 内置 adb 的**绝对路径**（Windows 原生形式）。
   *
   * spike 实测（docs/superpowers/spike/scrcpy-embed-result.md 第六节）：
   * 传给 scrcpy 的 ADB 必须是 `C:\\...\\adb.exe` 这种形式，
   * MSYS 风格（`/e/AI/...`）会让它报 CreateProcessW() error 2 ——
   * 它直接交给 Win32 API，不做任何路径转换。
   */
  adbPath: string
  args: readonly string[]
}

/** 子进程句柄（service 只需要这三件事）。 */
export interface ScrcpyHandle {
  pid: number | undefined
  /** 进程退出或起不来时回调；只会触发一次。 */
  onExit: (callback: (code: number | null) => void) => void
  /** 终结整棵进程树并**等到真死**。 */
  kill: () => Promise<void>
  /** 拿到的 stderr 片段（用于 classifyScrcpyFailure）。 */
  stderrSoFar: () => string
}

/**
 * 起一个 scrcpy 进程。
 *
 * @returns 句柄；子进程闸门已关闭（应用正在退出）时返回 null。
 */
export function startScrcpy(deps: StartScrcpyDeps): ScrcpyHandle | null {
  const env = { ...process.env, ADB: deps.adbPath }
  const child = spawnTracked(deps.scrcpyPath, deps.args, {
    env,
    windowsHide: true,
    /*
     * 独立进程组：超时/取消时能整组终结。
     * Windows 上 detached 无意义（走 taskkill /T），POSIX 上必须有。
     */
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  if (child === null) return null

  let settled = false
  let stderr = ''
  const callbacks: Array<(code: number | null) => void> = []

  /*
   * stderr **必须消费**。
   *
   * 不读会让管道填满，scrcpy 反而卡死 —— 与 capture/recorder.ts 同一条教训。
   * 同时把片段留下：启动失败时 classifyScrcpyFailure 靠它区分
   * 「认不出设备」与「adb 起不来」，两种给用户的修法完全不同。
   */
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
    // 只留尾巴：启动期的错误在头几 KB 内，剩下的没有诊断价值
    if (stderr.length > 8192) stderr = stderr.slice(-8192)
  })

  const settle = (code: number | null): void => {
    if (settled) return
    settled = true
    for (const cb of callbacks) {
      try {
        cb(code)
      } catch {
        // 回调失败不能影响进程收尾
      }
    }
  }

  child.on('close', (code) => { settle(code) })
  child.on('error', () => { settle(null) })

  return {
    pid: child.pid,
    onExit(callback) {
      // 已经退出的进程不能再注册等待（否则调用方会永远等下去）
      if (settled) {
        callback(child.exitCode)
        return
      }
      callbacks.push(callback)
    },
    async kill() {
      await killTree(child as ChildProcess)
    },
    stderrSoFar: () => stderr,
  }
}
