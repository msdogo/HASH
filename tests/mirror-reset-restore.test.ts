import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/*
 * 「重置窗口大小」= 恢复**投屏成功那一刻实测到**的内容区尺寸。
 *
 * ===== 为什么是源码静态门禁 =====
 * 缺陷现场：竖屏 MI 6 打开投屏，窗口实测 539×900；点重置后变成 523×900，
 * 少的 16px 被 fitRect 摊成上下各 17px 黑边（用户看到的「重置后上下多两条黑边」）。
 * 成因是 resetSize 用会话探测值重算，而 open() 用的是 measureStableVideoRect
 * 量到的实测值 —— 两套口径差 16px。
 *
 * 要观测的行为全都发生在主进程的 BrowserWindow 上（getContentSize / setContentSize），
 * 而本工程 environment: node、没有给 electron 做 mock（见 tests/mirror-window-title.test.ts
 * 的同类说明），所以沿用 readFileSync 断言，锁住「容易在后续重构里被改回去」的几行。
 *
 * 算法本身（windowFitSize 的回退路径）仍有真单元测试，见 tests/mirror-reset-size.test.ts。
 */

const root = path.resolve(import.meta.dirname, '..')
const source = readFileSync(path.join(root, 'electron/mirror/window.ts'), 'utf8')

/** resetSize 的源码块（到方法结束）。 */
const resetStart = source.indexOf('resetSize(serial: string): void {')
const resetBlock = resetStart < 0 ? '' : source.slice(resetStart, source.indexOf('\n  },\n}', resetStart))

describe('重置窗口大小恢复投屏成功时的尺寸', () => {
  it('成功路径记录 getContentSize() 的结果', () => {
    expect(source).toContain('const [defaultWidth, defaultHeight] = win.getContentSize()')
    expect(source).toContain('entry.defaultSize = { width: defaultWidth, height: defaultHeight }')
  })

  it('记录发生在按实测视频尺寸 setContentSize 之后', () => {
    /*
     * :262 那次 setContentSize(fitted.width, fitted.height) 才是窗口的最终尺寸
     * （它用 measureStableVideoRect 的实测值）。记在它之前 = 记到建窗时的推算值
     * = 523 而不是 539，缺陷原样复发。
     */
    const setFitted = source.indexOf('win.setContentSize(fitted.width, fitted.height)')
    const record = source.indexOf('win.getContentSize()')
    expect(setFitted).toBeGreaterThan(-1)
    expect(record).toBeGreaterThan(-1)
    expect(record).toBeGreaterThan(setFitted)
  })

  it('resetSize 首选记录值，重算只作回退', () => {
    expect(resetBlock).not.toBe('')
    expect(resetBlock).toContain('setContentSize(entry.defaultSize.width, entry.defaultSize.height)')
    /*
     * 回退函数只能有**一个**调用点，且在 defaultSize === null 的分支里。
     * 「两处都调」或「先算再判断」都会让记录值被覆盖 —— 缺陷原样复发。
     */
    const fallbackCalls = resetBlock.split('fallbackSize()').length - 1
    expect(fallbackCalls).toBe(1) // 只有 defaultSize === null 那一处调用
    expect(resetBlock).toContain('if (entry.defaultSize === null) fallbackSize()')
  })

  it('最大化/全屏状态下先还原（否则 setContentSize 是空操作）', () => {
    expect(resetBlock).toContain('unmaximize()')
    expect(resetBlock).toContain('setFullScreen(false)')
    // 必须先还原再设尺寸
    expect(resetBlock.indexOf('unmaximize()')).toBeLessThan(
      resetBlock.indexOf('setContentSize(entry.defaultSize.width'),
    )
  })

  it('子窗口宽高比用实测尺寸（设备转屏后按 session.screen 推算会拉扁画面）', () => {
    expect(resetBlock).toContain('windowRectOf(entry.embedded.childHwnd)')
  })

  it('Entry 里 defaultSize 初始为 null（open 尚未走完时重置是安全空操作）', () => {
    expect(source).toContain('defaultSize: null')
    expect(source).toContain('defaultSize: { width: number; height: number } | null')
    // 回退分支必须存在，否则 null 时会什么都不做
    expect(resetBlock).toContain('if (entry.defaultSize === null) fallbackSize()')
  })
})
