import { describe, it, expect } from 'vitest'
import {
  ERROR_CODES,
  E_ABORTED,
  E_BAD_ARGS,
  E_NOT_FOUND,
  E_SHUTDOWN,
  E_TIMEOUT,
  E_UNKNOWN,
  isErrorCode,
  toErrorCode,
} from '../src/shared/errors'

describe('共享错误码', () => {
  it('包含前五个任务积累的全部错误码，且不重复', () => {
    const expected = [
      'E_NO_SERIAL',
      'E_TIMEOUT',
      'E_ABORTED',
      'E_SHUTDOWN',
      'E_INVALID_PATH',
      'E_ADB_NOT_FOUND',
      'E_ADB_NOT_EXECUTABLE',
      'E_ADB_BAD_OUTPUT',
      'E_ADB_TIMEOUT',
      'E_ADB_SHIM_UNSUPPORTED',
      'E_NO_PERMISSION',
      'E_NOT_FOUND',
      'E_PARSE_DEGRADED',
      'E_BAD_ARGS',
      'E_LIST_FAILED',
      'E_UNKNOWN',
      // 审查轮 1（任务 7）：跟随符号链接目录时的两种新增失败
      'E_LINK_UNRESOLVED',
      'E_LINK_CYCLE',
      // 审查轮 2（任务 7）：指向文件的快捷方式需要单独的文案
      'E_NOT_A_DIRECTORY',
      // 任务 8：传输失败（裁决 7 的「失败保留可重试」要有自己的文案）
      'E_SYNC_FAILED',
      // 任务 8：传输途中设备掉线（裁决 4）
      'E_DEVICE_OFFLINE',
    ]
    for (const code of expected) expect(ERROR_CODES).toContain(code)
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
    expect(ERROR_CODES.length).toBe(expected.length)
  })

  it('E_SHUTDOWN 已登记（子进程闸门关闭时的统一错误码）', () => {
    expect(isErrorCode(E_SHUTDOWN)).toBe(true)
    expect(toErrorCode(new Error(E_SHUTDOWN))).toBe(E_SHUTDOWN)
  })

  it('isErrorCode 只认表内的码', () => {
    expect(isErrorCode('E_TIMEOUT')).toBe(true)
    expect(isErrorCode('E_ABORTED')).toBe(true)
    expect(isErrorCode('E_NOPE')).toBe(false)
    expect(isErrorCode('')).toBe(false)
    expect(isErrorCode(undefined)).toBe(false)
    expect(isErrorCode(42)).toBe(false)
  })

  it('toErrorCode 从异常消息里取出错误码', () => {
    expect(toErrorCode(new Error(E_NOT_FOUND))).toBe(E_NOT_FOUND)
    expect(toErrorCode(new Error('E_ABORTED'))).toBe(E_ABORTED)
    // 错误码可能嵌在更长的消息里（"ls: E_NO_PERMISSION /data"）
    expect(toErrorCode(new Error('ls: E_NO_PERMISSION /data'))).toBe('E_NO_PERMISSION')
    expect(toErrorCode('E_TIMEOUT')).toBe(E_TIMEOUT)
  })

  it('toErrorCode 对未知异常回退 E_UNKNOWN，绝不抛错', () => {
    expect(toErrorCode(new Error('boom'))).toBe(E_UNKNOWN)
    expect(toErrorCode(undefined)).toBe(E_UNKNOWN)
    expect(toErrorCode(null)).toBe(E_UNKNOWN)
    expect(toErrorCode({ code: 1 })).toBe(E_UNKNOWN)
    expect(toErrorCode(42)).toBe(E_UNKNOWN)
    // E_ 开头但不在表内的码也必须回退，不能被误当成合法码
    expect(toErrorCode(new Error('E_NOT_A_REAL_CODE'))).toBe(E_UNKNOWN)
  })

  it('E_BAD_ARGS 在表内（IPC 校验失败的统一出口）', () => {
    expect(isErrorCode(E_BAD_ARGS)).toBe(true)
    expect(toErrorCode(new Error(E_BAD_ARGS))).toBe(E_BAD_ARGS)
  })
})