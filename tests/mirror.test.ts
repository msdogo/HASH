import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MAX_SIZE,
  MAX_SIZE_OPTIONS,
  SCRCPY_WINDOW_PREFIX,
  buildScrcpyArgs,
  classifyScrcpyFailure,
  mirrorTitleOf,
} from '../src/shared/mirror'

describe('buildScrcpyArgs', () => {
  it('必须带 -s serial（与 adb 同一条红线）', () => {
    const args = buildScrcpyArgs({ serial: 'ABC123', token: 't1', maxSize: DEFAULT_MAX_SIZE })
    expect(args.slice(0, 2)).toEqual(['-s', 'ABC123'])
  })

  it('无边框 + 唯一标题前缀', () => {
    const args = buildScrcpyArgs({ serial: 'ABC123', token: 't1', maxSize: DEFAULT_MAX_SIZE })
    expect(args).toContain('--window-borderless')
    expect(args).toContain('--window-title=' + SCRCPY_WINDOW_PREFIX + 't1')
  })

  it('不带 --render-driver（spike 证明默认 d3d11 够用，少一个变量）', () => {
    const args = buildScrcpyArgs({ serial: 'ABC123', token: 't1', maxSize: DEFAULT_MAX_SIZE })
    expect(args.some((a) => a.startsWith('--render-driver'))).toBe(false)
  })

  it('带 --no-audio', () => {
    const args = buildScrcpyArgs({ serial: 'ABC123', token: 't1', maxSize: DEFAULT_MAX_SIZE })
    expect(args).toContain('--no-audio')
  })

  it('maxSize 拼进 --max-size', () => {
    const args = buildScrcpyArgs({ serial: 'ABC123', token: 't1', maxSize: 720 })
    expect(args).toContain('--max-size=720')
  })

  it('无线设备序列号（含冒号）原样传递', () => {
    const args = buildScrcpyArgs({ serial: '192.168.1.7:5555', token: 't2', maxSize: 1280 })
    expect(args.slice(0, 2)).toEqual(['-s', '192.168.1.7:5555'])
    expect(args).toContain('--max-size=1280')
  })

  it('两个 token 不同则标题不同（多设备互不认错）', () => {
    const a = buildScrcpyArgs({ serial: 'S1', token: 'aaa', maxSize: DEFAULT_MAX_SIZE })
    const b = buildScrcpyArgs({ serial: 'S2', token: 'bbb', maxSize: DEFAULT_MAX_SIZE })
    expect(a).not.toEqual(b)
    expect(a).toContain('--window-title=' + SCRCPY_WINDOW_PREFIX + 'aaa')
    expect(b).toContain('--window-title=' + SCRCPY_WINDOW_PREFIX + 'bbb')
  })
})

describe('mirrorTitleOf', () => {
  it('有型号用型号 + serial 后 4 位', () => {
    expect(mirrorTitleOf({ serial: '9N9CN2G0012A3P', model: 'DJI RC Plus 2' })).toBe('DJI RC Plus 2 (2A3P)')
  })

  it('无型号回退「设备」', () => {
    expect(mirrorTitleOf({ serial: '9N9CN2G0012A3P' })).toBe('设备 (2A3P)')
  })

  it('空字符串型号也回退（不显示空括号前缀）', () => {
    expect(mirrorTitleOf({ serial: 'ABCD1234', model: '' })).toBe('设备 (1234)')
  })
})

describe('classifyScrcpyFailure', () => {
  it('认不出设备 → E_DEVICE_OFFLINE', () => {
    expect(classifyScrcpyFailure('ERROR: Could not find any ADB device')).toBe('E_DEVICE_OFFLINE')
  })

  it('ADB 设备找不到（带 serial 的变体）→ E_DEVICE_OFFLINE', () => {
    expect(classifyScrcpyFailure('ERROR: Could not find ADB device 9N9CN2G0012A3P')).toBe('E_DEVICE_OFFLINE')
  })

  it('adb server 起不来 → E_SCRCPY_NO_ADB', () => {
    expect(classifyScrcpyFailure('ERROR: Could not start adb server')).toBe('E_SCRCPY_NO_ADB')
  })

  it('Command not found: [adb] → E_SCRCPY_NO_ADB', () => {
    expect(
      classifyScrcpyFailure("ERROR: Command not found: [/e/AI/x/adb.exe], [start-server]"),
    ).toBe('E_SCRCPY_NO_ADB')
  })

  it('其余 → E_MIRROR_START_FAILED', () => {
    expect(classifyScrcpyFailure('something odd happened')).toBe('E_MIRROR_START_FAILED')
  })

  it('空串 → E_MIRROR_START_FAILED（不抛）', () => {
    expect(classifyScrcpyFailure('')).toBe('E_MIRROR_START_FAILED')
  })
})

describe('MAX_SIZE_OPTIONS', () => {
  it('含默认值', () => {
    expect(MAX_SIZE_OPTIONS).toContain(DEFAULT_MAX_SIZE)
  })

  it('全部为正整数且递增', () => {
    for (let i = 0; i < MAX_SIZE_OPTIONS.length; i++) {
      expect(Number.isInteger(MAX_SIZE_OPTIONS[i])).toBe(true)
      expect(MAX_SIZE_OPTIONS[i]).toBeGreaterThan(0)
      if (i > 0) expect(MAX_SIZE_OPTIONS[i]).toBeGreaterThan(MAX_SIZE_OPTIONS[i - 1])
    }
  })
})
