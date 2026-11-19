import { describe, it, expect } from 'vitest'
import {
  classifyTransferError,
  parseByteCount,
} from '../electron/transfer/runner'
import { E_NO_PERMISSION, E_NOT_FOUND, E_SYNC_FAILED } from '../src/shared/errors'

/*
 * 传输执行层（裁决 1/5）。
 *
 * 裁决 1 的真机结论：adb push/pull 在 1.0.41 上【不输出百分比】，只有结束时一行汇总
 * （见 tests/transfer-progress.test.ts 里的原始字节）。所以这里的实现是：
 *   - 进度：轮询目标文件大小（push 轮询远程、pull 轮询本地）；
 *   - 总量：push 用本地 stat、pull 用远程 stat；
 *   - 结束：解析汇总行拿权威字节数，作为最终 doneBytes。
 */

describe('裁决 5：字节数解析（防 Number 溢出）', () => {
  it('正常数字字符串', () => {
    expect(parseByteCount('52428800')).toBe(52428800)
    expect(parseByteCount('52428800\r\n')).toBe(52428800)
    expect(parseByteCount('  1234  ')).toBe(1234)
    expect(parseByteCount(42)).toBe(42)
  })

  it('0 是合法大小（空文件）', () => {
    expect(parseByteCount('0')).toBe(0)
  })

  it('超过 JS 安全整数 → null（降级为不确定态，不做会丢精度的算术）', () => {
    expect(parseByteCount('9007199254740993')).toBe(null) // MAX_SAFE_INTEGER + 2
    expect(parseByteCount('100000000000000000000')).toBe(null)
    expect(parseByteCount(String(Number.MAX_SAFE_INTEGER + 2))).toBe(null)
  })

  it('MAX_SAFE_INTEGER 本身仍合法（约 9PB，远超任何手机）', () => {
    expect(parseByteCount(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('2GB/4GB 这类大文件正常（number 装得下）', () => {
    expect(parseByteCount('2147483648')).toBe(2147483648)
    expect(parseByteCount('4294967296')).toBe(4294967296)
  })

  it('垃圾输入 / 空 / 负数 / NaN → null', () => {
    expect(parseByteCount('')).toBe(null)
    expect(parseByteCount('   ')).toBe(null)
    expect(parseByteCount('abc')).toBe(null)
    expect(parseByteCount('-5')).toBe(null)
    expect(parseByteCount(Number.NaN)).toBe(null)
    expect(parseByteCount(Number.POSITIVE_INFINITY)).toBe(null)
    expect(parseByteCount(null)).toBe(null)
    expect(parseByteCount(undefined)).toBe(null)
    expect(parseByteCount({})).toBe(null)
  })
})

describe('传输失败分类', () => {
  it('源文件不存在 → E_NOT_FOUND', () => {
    expect(classifyTransferError(1, "adb: error: failed to stat remote object '/sdcard/nope.bin': No such file or directory\r\n"))
      .toBe(E_NOT_FOUND)
  })

  it('权限不足 → E_NO_PERMISSION', () => {
    expect(classifyTransferError(1, 'adb: error: failed to copy: remote Permission denied\r\n'))
      .toBe(E_NO_PERMISSION)
  })

  it('其它非零退出 → E_SYNC_FAILED', () => {
    expect(classifyTransferError(1, 'something odd happened')).toBe(E_SYNC_FAILED)
  })

  it('零退出视为成功（即使 stderr 有内容）', () => {
    expect(classifyTransferError(0, 'warning whatever')).toBe(null)
  })
})
