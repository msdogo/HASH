import { describe, it, expect } from 'vitest'
import { controllerForSender, createWindowController, type WindowLike } from '../electron/window/controller'

/*
 * 窗口控制（自绘顶栏的三个按钮）。
 *
 * 这些行为改坏了界面照样能开，但用户会直接关不掉程序 ——
 * 所以每一条都要有门禁，而不是只靠手工点一遍。
 */

function fake(initial = false) {
  let maximized = initial
  const calls: string[] = []
  const win: WindowLike = {
    minimize: () => { calls.push('minimize') },
    maximize: () => { calls.push('maximize'); maximized = true },
    unmaximize: () => { calls.push('unmaximize'); maximized = false },
    isMaximized: () => maximized,
  }
  return { win, calls, isMax: () => maximized }
}

describe('窗口控制', () => {
  it('最小化转成一次 minimize 调用', () => {
    const f = fake()
    createWindowController(() => f.win).minimize()
    expect(f.calls).toEqual(['minimize'])
  })

  it('最大化与还原是同一个按钮：每次切换状态翻转', () => {
    const f = fake()
    const ctrl = createWindowController(() => f.win)
    expect(ctrl.toggleMaximize()).toBe(true)
    expect(f.isMax()).toBe(true)
    expect(ctrl.toggleMaximize()).toBe(false)
    expect(f.isMax()).toBe(false)
  })

  /*
   * 关键一条：状态以 isMaximized() 为准，不自己记。
   * 用户双击标题栏或按 Win+↑ 时渲染层完全不知情 ——
   * 自己记状态的话，点一次「最大化」会变成先还原再最大化（看起来没反应）。
   */
  it('外部已经把窗口最大化时，切换动作是还原（而不是再 maximize 一次）', () => {
    const f = fake(true)
    const ctrl = createWindowController(() => f.win)
    expect(ctrl.toggleMaximize()).toBe(false)
    expect(f.calls).toEqual(['unmaximize'])
  })

  it('没有窗口时三个操作都是安全空操作（不抛异常）', () => {
    const ctrl = createWindowController(() => undefined)
    expect(() => { ctrl.minimize() }).not.toThrow()
    expect(ctrl.toggleMaximize()).toBe(false)
    expect(ctrl.isMaximized()).toBe(false)
  })

  /*
   * 多窗口路由：这是本功能最容易踩、也最难肉眼发现的坑。
   * 应用有主窗口 + 设置子窗口，若一律取 getAllWindows()[0]，
   * 在设置窗口点最小化会最小化主窗口。
   */
  it('命令只作用于 resolve 返回的那个窗口（不串台）', () => {
    const main = fake()
    const settings = fake()
    let which: 'main' | 'settings' = 'settings'
    const ctrl = controllerForSender(
      () => (which === 'settings' ? settings.win : main.win),
      (window) => window,
    )
    ctrl.minimize()
    expect(settings.calls).toEqual(['minimize'])
    expect(main.calls).toEqual([])
    // 切到主窗口发起，只有主窗口动
    which = 'main'
    ctrl.minimize()
    expect(main.calls).toEqual(['minimize'])
    expect(settings.calls).toEqual(['minimize'])
  })

  it('resolve 拿不到窗口时按「没有窗口」处理（不抛、不误伤别的窗口）', () => {
    const fallback = fake()
    const ctrl = controllerForSender(
      () => undefined,
      () => fallback.win,
    )
    expect(() => { ctrl.minimize() }).not.toThrow()
    expect(fallback.calls).toEqual([])
    expect(ctrl.toggleMaximize()).toBe(false)
  })

  it('窗口在操作瞬间被销毁也不抛（pick 每次现取，不是构造时缓存）', () => {
    let win: WindowLike | undefined = fake().win
    const ctrl = createWindowController(() => win)
    ctrl.minimize()
    win = undefined
    expect(() => { ctrl.minimize() }).not.toThrow()
    expect(ctrl.toggleMaximize()).toBe(false)
  })
})