import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  adbChildCount,
  childrenClosed,
  killAllAdbChildren,
  shutdownChildren,
  spawnTracked,
  trackChild,
} from '../electron/adb/children'

/*
 * I5 / N2（审查轮 2）：killAllAdbChildren 挡不住【之后】起的 spawn。
 *
 * 复审实测：killAll 之后 resolveAdb 仍会 spawn 新子进程，父进程退出后它存活（pid 45740）。
 * killAllAdbChildren 只杀「当刻在册」的进程，对「正在 await 且马上要 spawn」的调用无效。
 *
 * 修法：全局关闭闸门 + 唯一 spawn 出入口。
 *   - shutdownChildren() 置位 closed 并 kill 全部；
 *   - 所有 adb 子进程都经 spawnTracked() 起，closed 时直接返回 null（不 spawn）；
 *   - trackChild() 在 closed 时 kill 新来的 child 并返回 false。
 *
 * 本文件是【唯一】置位闸门的测试文件（vitest 默认按文件隔离模块注册表）。
 */

describe('I5 子进程关闭闸门', () => {
  const nodeExe = process.execPath
  const SLEEP_ARGS = ['-e', 'setTimeout(() => {}, 60000)']

  it('初始状态未关闭', () => {
    expect(childrenClosed()).toBe(false)
  })

  it('关闭前 spawnTracked 能真的拉起进程（证明闸门不是"永远不 spawn"）', async () => {
    const child = spawnTracked(nodeExe, SLEEP_ARGS, { windowsHide: true, stdio: 'ignore' })
    expect(child).not.toBeNull()
    expect(adbChildCount()).toBe(1)
    // 系统层面确认进程真的活着
    await waitUntil(() => pidAlive(child?.pid), 2000)
    expect(pidAlive(child?.pid)).toBe(true)
    // 清理这一条，让后面的断言从 0 开始
    child?.kill()
    await waitUntil(() => !pidAlive(child?.pid), 3000)
  })

  it('shutdownChildren 之后：spawnTracked 返回 null（不 spawn）、在册归零', () => {
    shutdownChildren()
    expect(childrenClosed()).toBe(true)
    expect(adbChildCount()).toBe(0)

    const child = spawnTracked(nodeExe, SLEEP_ARGS, { windowsHide: true, stdio: 'ignore' })
    expect(child).toBeNull()
    expect(adbChildCount()).toBe(0)
  })

  it('关闭后 300ms 内系统层面没有任何新进程存活（实测，不只信登记表）', async () => {
    // 再试着 spawn 几次，模拟「正在 await 且马上要 spawn」的迟到调用
    for (let i = 0; i < 3; i++) {
      expect(spawnTracked(nodeExe, SLEEP_ARGS, { windowsHide: true, stdio: 'ignore' })).toBeNull()
    }
    await new Promise((r) => setTimeout(r, 300))
    expect(countNodeSleepProcesses()).toBe(0)
    expect(adbChildCount()).toBe(0)
  })

  it('关闭后 trackChild 拒绝登记、立即 kill 并返回 false', () => {
    let killed = false
    const fake = { pid: undefined, kill: () => { killed = true } }
    const accepted = trackChild(fake as never)
    expect(accepted).toBe(false)
    expect(killed).toBe(true)
    expect(adbChildCount()).toBe(0)
  })

  it('killAllAdbChildren 在关闭后仍幂等可用（不抛错）', () => {
    expect(() => { killAllAdbChildren(); killAllAdbChildren() }).not.toThrow()
  })
})

/** 进程是否存活（系统层面，不是登记表）。 */
function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 系统层面数一下「node -e setTimeout 60s」这种存活进程有几个。 */
function countNodeSleepProcesses(): number {
  if (process.platform === 'win32') {
    const r = spawnSync('wmic', ['process', 'where', "name='node.exe'", 'get', 'CommandLine'], {
      windowsHide: true, encoding: 'utf8',
    })
    const lines = (r.stdout ?? '').split('\n').filter((l) => l.includes('setTimeout'))
    return lines.length
  }
  const r = spawnSync('pgrep', ['-af', 'setTimeout'], { encoding: 'utf8' })
  return (r.stdout ?? '').trim() === '' ? 0 : (r.stdout ?? '').trim().split('\n').length
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 50))
  }
}
