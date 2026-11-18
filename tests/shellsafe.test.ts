import { describe, it, expect } from 'vitest'
import { shellQuote } from '../electron/adb/shellsafe'

describe('shellQuote', () => {
  it('普通路径加单引号', () => {
    expect(shellQuote('/sdcard/DCIM')).toBe("'/sdcard/DCIM'")
  })
  it('中文与空格安全', () => {
    expect(shellQuote('/sdcard/我的 照片/a.jpg')).toBe("'/sdcard/我的 照片/a.jpg'")
  })
  it('单引号被正确转义', () => {
    expect(shellQuote("it's.txt")).toBe("'it'\"'\"'s.txt'")
  })
  it('空串也安全', () => {
    expect(shellQuote('')).toBe("''")
  })
})
