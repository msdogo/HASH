import { describe, it, expect } from 'vitest'
import { applyCsp, buildCsp } from '../electron/csp'

describe('CSP（裁决 4：dev/prod 双模式）', () => {
  it('生产策略：只允许 self，禁止 eval 与内联脚本', () => {
    const csp = buildCsp(false)
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain('unsafe-eval')
    // script-src 里不得出现 unsafe-inline
    const script = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'))
    expect(script).toBe("script-src 'self'")
  })

  it('生产策略禁止对象、限制 base-uri 与 form-action', () => {
    const csp = buildCsp(false)
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('生产策略不放行 ws: 与 http:', () => {
    const csp = buildCsp(false)
    expect(csp).not.toContain('ws:')
    expect(csp).not.toContain('http:')
  })

  it('开发策略放行 Vite HMR 需要的 ws: 与内联脚本', () => {
    const csp = buildCsp(true)
    expect(csp).toContain('ws:')
    const script = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'))
    expect(script).toContain("'unsafe-inline'")
    // 开发态也要保留 self，不能整条放开成 *
    expect(script).toContain("'self'")
    expect(csp).not.toContain('*')
  })

  it('两种模式都禁止 object-src，且都是合法指令串', () => {
    for (const csp of [buildCsp(true), buildCsp(false)]) {
      expect(csp).toContain("object-src 'none'")
      for (const directive of csp.split(';')) {
        const trimmed = directive.trim()
        if (trimmed === '') continue
        expect(trimmed).toMatch(/^[a-z-]+( [^;]+)?$/)
      }
    }
  })
})
describe('CSP 注入（裁决 4：onHeadersReceived 行为）', () => {
  function capture(isDev: boolean): { policy: string; details: Record<string, string[]> } {
    let listener:
      | ((d: { responseHeaders?: Record<string, string[]> }, cb: (r: { responseHeaders: Record<string, string[]> }) => void) => void)
      | undefined
    applyCsp({ webRequest: { onHeadersReceived: (fn) => { listener = fn } } }, isDev)
    if (listener === undefined) throw new Error('没有注册 onHeadersReceived')
    let captured: Record<string, string[]> = {}
    listener({ responseHeaders: { 'content-type': ['text/html'] } }, (response) => {
      captured = response.responseHeaders
    })
    const values = captured['Content-Security-Policy'] ?? []
    return { policy: values[0] ?? '', details: captured }
  }

  it('生产模式注入 prod 策略，且至少注册了一次响应头监听', () => {
    const { policy } = capture(false)
    expect(policy).toBe(buildCsp(false))
    expect(policy).not.toContain('ws:')
  })

  it('开发模式注入 dev 策略（放行 HMR 的 ws:）', () => {
    const { policy } = capture(true)
    expect(policy).toBe(buildCsp(true))
    expect(policy).toContain('ws:')
  })

  it('保留原有响应头（丢掉 content-type 会让页面白屏）', () => {
    const { details } = capture(true)
    expect(details['content-type']).toEqual(['text/html'])
  })
})
