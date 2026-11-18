import { describe, it, expect } from 'vitest'
import { t } from '../src/shared/i18n'

// 这条用例同时是 tsconfig 的验证：tests/ 归 node 工程后必须能 import src/shared。
describe('tests 可以 import src/shared', () => {
  it('未注册的 key 原样返回', () => {
    expect(t('task2.missing.key')).toBe('task2.missing.key')
  })
})
