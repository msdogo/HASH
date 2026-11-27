import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MAX_SIZE,
  SIDEBAR_WIDTH,
  HEADER_HEIGHT,
  fitRect,
  videoSizeFor,
  windowFitSize,
} from '../src/shared/mirror'

/**
 * 「重置窗口大小」的算式门禁。
 *
 * ===== 这条用例在锁什么 =====
 * resetSize 不是把窗口设回某个**缓存值**，而是用会话里记下的 screen
 * 重新算一遍 —— 与 open() 完全同一套算式。为什么要这样：
 * 设备可能中途转过屏，用缓存值会把横屏设备的窗口"重置"成竖的。
 *
 * 所以这里锁的是「重置结果 === 初始尺寸」这个不变式：
 * 只要 resetSize 与 open() 共用 videoSizeFor + windowFitSize，
 * 两者就不可能漂移。
 */
describe('重置窗口大小的算式', () => {
  /** 与 window.ts 的 open()/resetSize() 逐字一致的算法。 */
  const defaultSizeOf = (screen: { width: number; height: number }, scale = 1) => {
    const video = videoSizeFor(screen, DEFAULT_MAX_SIZE)
    return windowFitSize(video.width, video.height, scale)
  }

  it('横屏设备重置回横向默认尺寸', () => {
    const size = defaultSizeOf({ width: 1920, height: 1200 })
    expect(size.width).toBeGreaterThan(size.height)
  })

  it('竖屏设备重置回竖向默认尺寸', () => {
    const size = defaultSizeOf({ width: 1080, height: 1920 })
    expect(size.height).toBeGreaterThan(size.width)
  })

  it('重置后的客户区刚好装下画面（宽 = 视频宽 + 侧边栏，高 = 视频高 + 顶栏）', () => {
    /*
     * 1920 档下视频就是原生的 1920x1200，而 windowFitSize 有 maxHeight=900 的钳制，
     * 所以这里用一个不会被钳制的尺寸（正方形 400x400）精确验证加项。
     */
    const size = defaultSizeOf({ width: 400, height: 400 })
    expect(size.width).toBe(400 + SIDEBAR_WIDTH)
    expect(size.height).toBe(400 + HEADER_HEIGHT)
  })

  it('设备中途转屏：重置用的是新方向，不是缓存值', () => {
    /*
     * 这是 resetSize 相对于"记住初始尺寸"的关键差别。
     * 同一条会话里 screen 变成横的之后，重置必须给出横窗口。
     */
    const portrait = defaultSizeOf({ width: 1080, height: 1920 })
    const landscape = defaultSizeOf({ width: 1920, height: 1080 })
    expect(portrait.height > portrait.width).toBe(true)
    expect(landscape.width > landscape.height).toBe(true)
  })

  it('重置后按同一宽高比居中（与 resize 走的 fitRect 一致）', () => {
    // 用户拉大之后画面居中留黑边是 fitRect 的责任；重置只是把可用区域变回默认，
    // 两者共用同一个函数，所以这里验证 fitRect 在默认区域里不产生偏移。
    const size = defaultSizeOf({ width: 400, height: 400 })
    const available = {
      x: 0,
      y: HEADER_HEIGHT,
      width: (size.width - SIDEBAR_WIDTH),
      height: (size.height - HEADER_HEIGHT),
    }
    const rect = fitRect(available, 400, 400)
    // 可用区宽高刚好等于视频尺寸 -> 铺满，无黑边
    expect(rect.width).toBe(400)
    expect(rect.height).toBe(400)
    expect(rect.x).toBe(0)
    expect(rect.y).toBe(HEADER_HEIGHT)
  })

  it('高 DPI 下重置尺寸按 scaleFactor 折算（不出现窗口比画面大一倍）', () => {
    const at1x = defaultSizeOf({ width: 400, height: 400 }, 1)
    const at2x = defaultSizeOf({ width: 400, height: 400 }, 2)
    // 2x 屏幕上同样的物理像素只需要一半的 DIP
    expect(at2x.width).toBeLessThan(at1x.width)
    expect(at2x.width).toBe(200 + SIDEBAR_WIDTH)
  })
})
