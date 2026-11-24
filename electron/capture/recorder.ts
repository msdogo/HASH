import type { ChildProcess } from 'node:child_process'
import { killTree, spawnTracked, untrackChild } from '../adb/children'
import { shellQuote } from '../adb/shellsafe'
import type { RecordHandle } from './service'

/**
 * 录屏进程的真实实现（P1 第一批）。
 *
 * ===== 为什么「停止」不靠本地进程的信号 =====
 * Windows 上 child.kill('SIGINT') 实际走 TerminateProcess —— 设备侧的 screenrecord
 * **收不到 SIGINT**，于是它继续录到 --time-limit 才停，而且 mp4 没有正常收尾
 * （moov 盒子没写，播放器打不开）。真机复现过：文件长度冻结在半途。
 *
 * 正确做法是在**设备上**发 SIGINT：另起一条 adb 命令 pkill -INT screenrecord。
 * screenrecord 收到 SIGINT 会把 moov 写进 mp4 再退出，这是它唯一的正常收尾路径。
 *
 * ===== 为什么本地进程也要登记 =====
 * 它是长驻子进程。不登记的话「关掉窗口后 adb 还在跑」是必然结果，
 * 而 children.ts 的闸门 + before-quit 的 shutdownChildren 正是为这类进程准备的。
 */

/**
 * 让设备侧结束录制的候选命令（按顺序尝试）。
 *
 * pkill 不是所有 toybox 版本都有，旧版只有 kill + pidof；
 * 两条都试一次的成本是一条 30s 超时的空闲命令，而漏掉的后果是用户永远停不下来。
 */
export const STOP_COMMANDS = [
  'pkill -INT screenrecord',
  'kill -2 $(pidof screenrecord)',
]

/** 录屏进程依赖。 */
export interface RecorderDeps {
  /** 已定位的 adb 绝对路径。 */
  adbPath: string
  /** 设备序列号（每条命令都强制带 -s）。 */
  serial: string
  /** 设备上的目标 mp4 路径。 */
  remotePath: string
  /** 服务端硬上限（秒）。 */
  maxSeconds: number
  /**
   * 让设备侧结束录制（另一条 adb 调用）。
   *
   * 注入而不是在这里自己 spawn：测试要能断言「停止时确实发了 pkill -INT」，
   * 而真机上这条命令与录制进程互不相干（它走同一个 adb server 的另一个连接）。
   */
  requestStopOnDevice: () => Promise<void>
}

/**
 * 起一个录制会话。
 *
 * @returns 句柄；子进程闸门已关闭（应用正在退出）时返回 null。
 */
export function startRecorder(deps: RecorderDeps): RecordHandle | null {
  const child = spawnTracked(
    deps.adbPath,
    ['-s', deps.serial, 'shell', 'screenrecord --time-limit ' + deps.maxSeconds + ' ' + shellQuote(deps.remotePath)],
    {
      windowsHide: true,
      // POSIX 建独立进程组，超时/取消时能整组终结；Windows 用 taskkill /T 走进程树。
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  if (child === null) return null

  let settled = false
  const exitCallbacks: Array<(info: { code: number | null }) => void> = []

  const settle = (code: number | null): void => {
    if (settled) return
    settled = true
    untrackChild(child)
    for (const callback of exitCallbacks) {
      try {
        callback({ code })
      } catch {
        // 回调失败不能影响子进程收尾
      }
    }
  }

  child.on('close', (code) => { settle(code) })
  child.on('error', () => { settle(null) })
  // stderr 必须消费：不读会让管道填满，adb 反而卡住
  child.stderr?.on('data', () => undefined)

  return {
    onExit(callback) {
      // 已经退出的进程不能再注册等待（否则调用方会永远等下去）
      if (settled) {
        callback({ code: child.exitCode })
        return
      }
      exitCallbacks.push(callback)
    },
    async requestStop() {
      await deps.requestStopOnDevice()
    },
    async kill() {
      await killTree(child as ChildProcess)
    },
  }
}
