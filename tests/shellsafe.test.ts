import { describe, it, expect } from 'vitest'
import { shellQuote, E_INVALID_PATH } from '../electron/adb/shellsafe'

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
  // adb shell 以换行作为命令结束符：值里出现换行/回车/空字节必须拒绝，而不是转义
  it('换行被拒绝', () => {
    expect(() => shellQuote('/sdcard/a\nb')).toThrow(E_INVALID_PATH)
  })
  it('回车被拒绝', () => {
    expect(() => shellQuote('/sdcard/a\rb')).toThrow(E_INVALID_PATH)
  })
  it('空字节被拒绝', () => {
    expect(() => shellQuote('/sdcard/a\0b')).toThrow(E_INVALID_PATH)
  })
})
