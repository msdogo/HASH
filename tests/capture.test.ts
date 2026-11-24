import { describe, it, expect } from 'vitest'
import {
  CAPTURE_TIMEOUT_MS,
  RECORD_MAX_SECONDS,
  SHOT_FALLBACK_DIR,
  SHOT_PREFIX,
  SHOT_TEMP_DIR,
  baseNameOf,
  classifyCaptureFailure,
  deviceFallbackShotDir,
  deviceShotDir,
  recordFileName,
  sanitizeSerial,
  screenshotFileName,
} from '../src/shared/capture'

/*
 * P1 第一批：截图 / 录屏的共享纯函数。
 *
 * 这些是「设备上的文件叫什么、放在哪个目录」的唯一事实源。
 * 它们一旦算错，清理用的通配符就扫不到写出去的文件 —— 设备上会永久留垃圾，
 * 而用户完全看不见。所以每一条都要有断言。
 */
describe('截图 / 录屏的落点与命名', () => {
  it('临时根是隐藏目录（不是用户可见的 Download）', () => {
    expect(SHOT_TEMP_DIR).toBe('/sdcard/.adbfm')
    // 以点开头 = ls 不带 -a 看不到，用户不会翻到临时文件
    expect(SHOT_TEMP_DIR.split('/').pop()?.startsWith('.')).toBe(true)
  })

  it('每台设备有自己专属的子目录（清扫只碰自己那台）', () => {
    expect(deviceShotDir('ONLINE-1')).toBe('/sdcard/.adbfm/ONLINE-1')
    expect(deviceShotDir('A')).not.toBe(deviceShotDir('B'))
  })

  it('无线设备的冒号被换成下划线（Windows 文件名不允许冒号）', () => {
    expect(sanitizeSerial('192.168.1.7:5555')).toBe('192.168.1.7_5555')
    expect(sanitizeSerial('192.168.1.7:5555')).not.toContain(':')
  })

  it('回退目录按设备分目录（与隐藏目录同一套归属规则）', () => {
    expect(deviceFallbackShotDir('X1')).toBe(SHOT_FALLBACK_DIR + '/X1')
    expect(SHOT_FALLBACK_DIR).toBe('/sdcard/Download')
  })

  it('截图文件名带固定前缀 + 时间戳 + 设备片段', () => {
    const name = screenshotFileName(1700000000000, 'A:1')
    expect(name.startsWith(SHOT_PREFIX)).toBe(true)
    expect(name).toContain('1700000000000')
    expect(name).toContain('A_1')
    expect(name.endsWith('.png')).toBe(true)
  })

  it('录屏文件名与截图分开（清理时的通配符不同，混用会互相删）', () => {
    const shot = screenshotFileName(1, 'A')
    const rec = recordFileName(1, 'A')
    expect(rec.endsWith('.mp4')).toBe(true)
    expect(rec.startsWith(SHOT_PREFIX)).toBe(false)
    expect(shot.startsWith(SHOT_PREFIX)).toBe(true)
  })

  it('baseNameOf 统一按 / 与 \\ 切（两种路径写法都要能算出文件名）', () => {
    expect(baseNameOf('/sdcard/.adbfm/A/x.png')).toBe('x.png')
    expect(baseNameOf('C:\\dl\\x.png')).toBe('x.png')
    expect(baseNameOf('x.png')).toBe('x.png')
  })
})

describe('超时与上限', () => {
  it('截图超时 30s', () => {
    expect(CAPTURE_TIMEOUT_MS).toBe(30_000)
  })

  it('录屏有服务端硬上限（用户忘了停止时唯一不依赖本进程的兜底）', () => {
    expect(RECORD_MAX_SECONDS).toBeGreaterThan(0)
    // 必须是分钟级但不是无限：太短会打断正常录制，太长会写满存储
    expect(RECORD_MAX_SECONDS).toBeGreaterThanOrEqual(60)
    expect(RECORD_MAX_SECONDS).toBeLessThanOrEqual(600)
  })
})

describe('失败归类（把设备侧 stderr 翻成错误码）', () => {
  it('权限不足 / 不存在 / 空间不足 / 只读 各自有专属码', () => {
    expect(classifyCaptureFailure('screencap: /x: Permission denied', 1)).toBe('E_NO_PERMISSION')
    expect(classifyCaptureFailure('No such file or directory', 1)).toBe('E_NOT_FOUND')
    expect(classifyCaptureFailure('No space left on device', 1)).toBe('E_NO_SPACE')
    expect(classifyCaptureFailure('Read-only file system', 1)).toBe('E_PROTECTED_PATH')
  })

  it('进程被信号终止（code 为 null）归成超时，而不是笼统失败', () => {
    expect(classifyCaptureFailure('', null)).toBe('E_TIMEOUT')
    expect(classifyCaptureFailure('timeout', 1)).toBe('E_TIMEOUT')
  })

  it('认不出的失败归成 E_SYNC_FAILED —— 绝不编一个成功', () => {
    expect(classifyCaptureFailure('something weird', 1)).toBe('E_SYNC_FAILED')
    expect(classifyCaptureFailure('', 1)).toBe('E_SYNC_FAILED')
  })
})
