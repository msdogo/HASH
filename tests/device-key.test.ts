import { describe, it, expect } from 'vitest'
import { DEVICE_KEYS, SIDEBAR_KEYS, isDeviceKey, keyCodeOf } from '../src/shared/device-key'

describe('device-key 映射', () => {
  it('三个导航键的 KEYCODE 正确', () => {
    expect(keyCodeOf('back')).toBe(4)
    expect(keyCodeOf('home')).toBe(3)
    expect(keyCodeOf('recents')).toBe(187)
  })

  it('音量与电源的 KEYCODE 正确', () => {
    expect(keyCodeOf('volumeUp')).toBe(24)
    expect(keyCodeOf('volumeDown')).toBe(25)
    expect(keyCodeOf('power')).toBe(26)
  })

  it('每个枚举值都能映射到正整数', () => {
    for (const key of DEVICE_KEYS) {
      const code = keyCodeOf(key)
      expect(Number.isInteger(code)).toBe(true)
      expect(code).toBeGreaterThan(0)
    }
  })

  it('侧边栏顺序覆盖全部六个键且不重复', () => {
    expect([...SIDEBAR_KEYS].sort()).toEqual([...DEVICE_KEYS].sort())
    expect(new Set(SIDEBAR_KEYS).size).toBe(SIDEBAR_KEYS.length)
  })
})

describe('isDeviceKey', () => {
  it('认枚举内的小写字面量', () => {
    expect(isDeviceKey('back')).toBe(true)
    expect(isDeviceKey('recents')).toBe(true)
  })

  it('大小写敏感：Back 不是合法键', () => {
    expect(isDeviceKey('Back')).toBe(false)
  })

  it('数字与命令片段都不是合法键（注入面必须堵死）', () => {
    expect(isDeviceKey('4')).toBe(false)
    expect(isDeviceKey('input keyevent 4')).toBe(false)
    expect(isDeviceKey('4; rm -rf /sdcard')).toBe(false)
  })

  it('非字符串一律拒绝', () => {
    expect(isDeviceKey(undefined)).toBe(false)
    expect(isDeviceKey(null)).toBe(false)
    expect(isDeviceKey(4)).toBe(false)
    expect(isDeviceKey({ key: 'back' })).toBe(false)
  })
})

describe('keyCodeOf 对非法输入', () => {
  it('枚举外的键返回 0（不是 undefined、不是抛）', () => {
    expect(keyCodeOf('nope' as never)).toBe(0)
  })
})
