import { describe, it, expect } from 'vitest'
import { deviceMenuItemsFor } from '../src/shared/device-menu'

describe('deviceMenuItemsFor', () => {
  it('在线且没投屏 → 只有「投屏」', () => {
    const items = deviceMenuItemsFor(true, false)
    expect(items.map((i) => i.id)).toEqual(['mirror'])
    expect(items[0].labelKey).toBe('mirror.open')
  })

  it('已投屏 → 只给「关闭投屏」（不给「投屏」，点了也没反应）', () => {
    const items = deviceMenuItemsFor(true, true)
    expect(items.map((i) => i.id)).toEqual(['mirrorStop'])
    expect(items[0].labelKey).toBe('mirror.close')
  })

  it('离线且没投屏 → 空表（不提供注定失败的动作）', () => {
    expect(deviceMenuItemsFor(false, false)).toEqual([])
  })

  it('离线但仍在投屏 → 仍给「关闭投屏」（窗口可能还开着，必须能关）', () => {
    const items = deviceMenuItemsFor(false, true)
    expect(items.map((i) => i.id)).toEqual(['mirrorStop'])
  })

  it('每一项的 labelKey 都是已登记文案的键', () => {
    for (const online of [true, false]) {
      for (const mirroring of [true, false]) {
        for (const item of deviceMenuItemsFor(online, mirroring)) {
          expect(item.labelKey).toMatch(/^mirror\./)
        }
      }
    }
  })
})
