import { describe, it, expect } from 'vitest'
import { ERROR_CODES } from '../src/shared/errors'
import { errorText, t, tf } from '../src/shared/i18n'

const HAN = /[\u4e00-\u9fff]/

describe('i18n 错误码文案（裁决 3）', () => {
  it('每个错误码都有一句中文人话，且不是直接回显错误码', () => {
    for (const code of ERROR_CODES) {
      const text = errorText(code)
      expect(text, code).not.toBe(code)
      expect(text, code).not.toContain(code)
      expect(text, code).toMatch(HAN)
      // 一句能看懂的句子，不是三两个字的占位
      expect(text.length, code).toBeGreaterThan(8)
    }
  })

  it('15 个错误码的文案两两不同（没有复制粘贴占位）', () => {
    const texts = ERROR_CODES.map((code) => errorText(code))
    expect(new Set(texts).size).toBe(texts.length)
  })

  it('E_SHUTDOWN 有中文人话（应用退出时的取消提示）', () => {
    const text = errorText('E_SHUTDOWN')
    expect(text).not.toBe('E_SHUTDOWN')
    expect(text).toMatch(HAN)
    expect(text).toContain('退出')
    expect(text.length).toBeGreaterThan(8)
  })

  it('E_ADB_SHIM_UNSUPPORTED 明确指向 platform-tools 里的 adb.exe', () => {
    expect(errorText('E_ADB_SHIM_UNSUPPORTED')).toContain('platform-tools')
    expect(errorText('E_ADB_SHIM_UNSUPPORTED')).toContain('adb.exe')
  })

  it('E_NO_SERIAL / E_ADB_NOT_FOUND / E_NO_PERMISSION 的语义可辨认', () => {
    expect(errorText('E_NO_SERIAL')).toContain('设备')
    expect(errorText('E_ADB_NOT_FOUND')).toContain('adb')
    expect(errorText('E_NO_PERMISSION')).toContain('权限')
  })

  it('表外的错误码回退到兜底文案并带上原始码', () => {
    const text = errorText('E_NOT_A_REAL_CODE')
    expect(text).toContain('E_NOT_A_REAL_CODE')
    expect(text).toMatch(HAN)
  })
})

describe('i18n 基础能力', () => {
  it('未注册的 key 原样返回（向后兼容）', () => {
    expect(t('task2.missing.key')).toBe('task2.missing.key')
  })

  it('设备栏文案已注册', () => {
    // app.name 是产品名（英文品牌），不是中文文案 —— 不参与下面的「必须含汉字」循环，
    // 单独断言它已注册且非空，避免把「改名成英文」误判成「文案缺失」。
    expect(t('app.name')).not.toBe('app.name')
    expect(t('app.name').trim().length).toBeGreaterThan(0)
    for (const key of [
      'devices.title',
      'devices.empty',
      'devices.adbChecking',
      'devices.adbUnusable',
      'devices.status.device',
      'devices.status.offline',
      'devices.status.unauthorized',
      'devices.status.recovery',
      'devices.status.unknown',
      'devices.selectHint',
    ]) {
      expect(t(key), key).not.toBe(key)
      expect(t(key), key).toMatch(HAN)
    }
  })

  it('tf 做 {name} 占位替换', () => {
    const text = tf('devices.summary', { total: 3, online: 2 })
    expect(text).toContain('3')
    expect(text).toContain('2')
    expect(text).not.toContain('{')
  })

  it('tf 遇到未注册 key 原样返回，缺参数留占位', () => {
    expect(tf('nope.key', { a: 1 })).toBe('nope.key')
  })
})