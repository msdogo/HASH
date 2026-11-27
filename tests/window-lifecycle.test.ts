import { describe, it, expect } from 'vitest'
import {
  closeOutcome,
  decideStartup,
  mayStartApp,
  restoreMainWindow,
  type RestorableWindow,
} from '../electron/app/lifecycle'

/*
 * 进程生命周期的三条判据。
 *
 * 这些都是**真出过**的缺陷，且都只在肉眼下暴露、事后极难复现：
 *   1. 第二实例被拒后仍然建窗口 → 双击图标「闪一下」；
 *   2. 关闭按钮直接关窗口 → 进程退出，传到一半的文件变成残片；
 *   3. 从托盘叫回窗口时只 restore()+focus() → hide 出来的窗口没有反应。
 * 所以它们值得有门禁，而不是继续靠「记得别写错」。
 */

describe('单实例：没拿到锁就不能继续启动', () => {
  it('拿到锁才允许启动', () => {
    expect(mayStartApp(true)).toBe(true)
  })

  /*
   * 这一条锁住的是 whenReady 回调里的 `if (!mayStartApp(...)) return`。
   * 只留 app.quit() 是不够的：quit 是异步的，之后的代码照样执行 ——
   * 窗口会真的被创建出来再随进程消失。
   */
  it('没拿到锁必须为 false（否则第二个实例会画出窗口再消失）', () => {
    expect(mayStartApp(false)).toBe(false)
  })
})

/*
 * 第二道锁（跨 user-data-dir 的全局互斥体）的判定。
 *
 * 触发这次改动的现场：装了正式版（默认 userData）的同时又跑了一份构建产物
 * （自带 --user-data-dir），两个实例都活着，任务栏 4 个图标。
 * Electron 的锁绑在 userData 上，管不了这件事。
 */
describe('启动闸门：两道锁', () => {
  const base = { electronLock: true, globalLock: true, allowMultiInstance: false } as const

  it('两道锁都在 → 启动', () => {
    expect(decideStartup({ ...base })).toBe(true)
  })

  it('Electron 锁没拿到 → 不启动（与 mayStartApp 一致）', () => {
    expect(decideStartup({ ...base, electronLock: false })).toBe(false)
  })

  /* 这就是本次要修的那条：userData 不同，Electron 锁放行，靠全局锁拦住。 */
  it('全局锁被别人持有 → 不启动（即使 Electron 锁拿到了）', () => {
    expect(decideStartup({ ...base, globalLock: false })).toBe(false)
  })

  /*
   * fail-open：探测失败（非 Windows / koffi 加载不出来）必须放行。
   * 把它当 false 的话，探测一旦异常应用就永远打不开，且用户看不到任何原因。
   */
  it('全局锁探测失败（null）→ 放行，不能把应用锁死', () => {
    expect(decideStartup({ ...base, globalLock: null })).toBe(true)
  })

  /* 联调要「正式版 + 构建产物」并存：允许跳过全局锁。 */
  it('allowMultiInstance → 跳过全局锁', () => {
    expect(decideStartup({ ...base, globalLock: false, allowMultiInstance: true })).toBe(true)
  })

  /* 但跳过全局锁不能连 Electron 的锁一起跳过。 */
  it('allowMultiInstance 仍然不能绕过 Electron 锁', () => {
    expect(decideStartup({ ...base, electronLock: false, allowMultiInstance: true })).toBe(false)
  })
})

describe('关闭按钮 = 退到后台', () => {
  /*
   * 必须是 background（= minimize），不能是 hide：
   * hide 会把窗口从任务栏摘掉，而用户明确要求「退到后台，任务栏图标还在」。
   */
  it('普通关闭 → 退到后台（最小化，任务栏图标保留），进程继续', () => {
    expect(closeOutcome(false)).toBe('background')
  })

  it('托盘「退出」置位后 → 真关窗口，走完整的 before-quit 清理', () => {
    expect(closeOutcome(true)).toBe('close')
  })
})

/*
 * 注意区分两条入口：
 *   - 第二次双击桌面图标：什么都不做（用户明确要求「像别的应用一样没反应」）；
 *   - 托盘图标 / 托盘菜单「显示主界面」：把窗口叫回来（这是唯一的找回入口）。
 * 所以下面测的是 restoreMainWindow 本身，它现在只被托盘路径使用。
 */
describe('从托盘叫回窗口', () => {
  function fake(over: Partial<RestorableWindow> & { calls: string[] }): RestorableWindow {
    return {
      isMinimized: over.isMinimized ?? (() => false),
      isVisible: over.isVisible ?? (() => true),
      restore: over.restore ?? (() => { over.calls.push('restore') }),
      show: over.show ?? (() => { over.calls.push('show') }),
      focus: over.focus ?? (() => { over.calls.push('focus') }),
    }
  }

  it('隐藏的窗口必须先 show()（只 focus() 对 hide 出来的窗口无效）', () => {
    const calls: string[] = []
    const win = fake({ isVisible: () => false, calls })
    expect(restoreMainWindow(win)).toBe(true)
    expect(calls).toContain('show')
    expect(calls).toContain('focus')
    expect(calls).not.toContain('restore')
  })

  it('已经可见的窗口不再重复 show()（避免闪烁）', () => {
    const calls: string[] = []
    const win = fake({ calls })
    restoreMainWindow(win)
    expect(calls).not.toContain('show')
    expect(calls).toEqual(['focus'])
  })

  it('最小化的窗口先 restore() 再 show()', () => {
    const calls: string[] = []
    const win = fake({ isMinimized: () => true, isVisible: () => false, calls })
    restoreMainWindow(win)
    expect(calls).toEqual(['restore', 'show', 'focus'])
  })

  /*
   * 窗口可能已经销毁（退出流程中）。此时必须返回 false 而不是抛异常 ——
   * 用户点托盘图标时程序崩溃，比「没反应」更糟。
   */
  it('没有窗口时返回 false 且不抛', () => {
    expect(restoreMainWindow(undefined)).toBe(false)
  })
})
