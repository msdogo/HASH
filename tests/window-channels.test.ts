import { describe, it, expect } from 'vitest'
import { CH, EVENT_CHANNELS, INVOKE_CHANNELS, isEventChannel, isInvokeChannel } from '../electron/ipc/channels'

/*
 * 窗口控制通道的接线门禁（主进程工程，纯常量断言）。
 *
 * 为什么单独一个文件：渲染层的 SSR 用例属于 tsconfig.app（要 DOM + jsx），
 * 而 channels.ts 属于 tsconfig.node —— 同一个文件里跨工程 import 会触发 TS6307。
 */

describe('窗口控制通道', () => {
  it('四个 invoke 通道命名与其它 domain:action 一致', () => {
    const invoke = [CH.WINDOW_MINIMIZE, CH.WINDOW_TOGGLE_MAXIMIZE, CH.WINDOW_CLOSE, CH.WINDOW_IS_MAXIMIZED]
    for (const channel of invoke) expect(channel).toMatch(/^window:[a-z-]+$/)
    expect(new Set(invoke).size).toBe(4)
  })

  it('最大化状态是单向事件（只能推，不能被渲染层 invoke）', () => {
    expect(CH.WINDOW_MAXIMIZED_CHANGED).toMatch(/^window:[a-z-]+$/)
    expect(isEventChannel(CH.WINDOW_MAXIMIZED_CHANGED)).toBe(true)
    expect(isInvokeChannel(CH.WINDOW_MAXIMIZED_CHANGED)).toBe(false)
  })

  it('四条命令都在 INVOKE 白名单里（漏登记 = preload 调了没人接）', () => {
    for (const channel of [
      CH.WINDOW_MINIMIZE, CH.WINDOW_TOGGLE_MAXIMIZE, CH.WINDOW_CLOSE, CH.WINDOW_IS_MAXIMIZED,
    ]) {
      expect(INVOKE_CHANNELS as readonly string[]).toContain(channel)
    }
    expect(EVENT_CHANNELS as readonly string[]).toContain(CH.WINDOW_MAXIMIZED_CHANGED)
  })
})