/**
 * Content-Security-Policy（裁决 4）。
 *
 * 为什么不在 index.html 写死 meta：dev 模式下 Vite HMR 需要 ws: 与内联脚本，
 * 写死的 meta 会直接把 dev 打断，于是所有人在开发时把 CSP 删掉 —— 等于没有。
 * 这里按 dev/prod 生成两份策略，由主进程用 onHeadersReceived 注入。
 */

const BASE_IMG = "img-src 'self' data:"
const BASE_FONT = "font-src 'self' data:"

/** 两种模式都锁死的指令：不允许 object / 不许被嵌套 / 不许提交表单。 */
const HARDENING = "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/**
 * 生产策略：只允许 self，禁止 eval、禁止内联脚本、禁止任何网络来源。
 * 打包后页面只加载本地资源，这条策略不会挡住任何功能。
 */
const PROD = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  BASE_IMG,
  BASE_FONT,
  "connect-src 'self'",
  HARDENING,
].join('; ')

/**
 * 开发策略：额外放行 Vite HMR 需要的 ws: 与内联脚本。
 * 注意 style-src 的 unsafe-inline 两种模式都保留 —— React 内联 style 属性不触发它，
 * 但 Vite dev 注入的 <style> 需要；生产构建里样式是外链文件，这条留着无害。
 */
const DEV = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  BASE_IMG,
  BASE_FONT,
  "connect-src 'self' ws: wss:",
  HARDENING,
].join('; ')

/** 生成 CSP 字符串。isDev 为真时放行 Vite HMR。 */
export function buildCsp(isDev: boolean): string {
  return isDev ? DEV : PROD
}
/** onHeadersReceived 回调里能拿到的响应头结构（只用到 responseHeaders）。 */
export interface HeadersDetails {
  responseHeaders?: Record<string, string[]>
}

/** 注入 CSP 所需的最小 session 契约（Electron 的 Session 天然满足）。 */
export interface WebRequestLike {
  onHeadersReceived(
    listener: (details: HeadersDetails, callback: (response: { responseHeaders: Record<string, string[]> }) => void) => void,
  ): void
}

export interface SessionLike {
  webRequest: WebRequestLike
}

/**
 * 把 CSP 注入到该 session 的所有响应头上。
 *
 * 为什么用 onHeadersReceived 而不是 index.html 里的 meta：
 * meta 是写死的，dev 下要么挡掉 Vite HMR（script-src 无 unsafe-inline 时），
 * 要么为了 dev 放宽到生产也不安全。这里按模式生成两份策略，
 * 并且【保留原有响应头】—— 直接返回新对象会把 content-type 之类全丢掉，页面白屏。
 */
export function applyCsp(ses: SessionLike, isDev: boolean): void {
  const policy = buildCsp(isDev)
  ses.webRequest.onHeadersReceived((details, callback) => {
    const existing = details.responseHeaders ?? {}
    /*
     * 已经有 CSP 就原样放行，不叠加第二条。
     *
     * 为什么：生产模式走 app:// 自定义协议，CSP 由 protocol.handle 亲手写进响应头
     * （那样即使 onHeadersReceived 不触发也一定有）。而实测 app:// 是标准网络事务，
     * onHeadersReceived 同样会触发 —— 两边都写就会变成「同一个头两份策略」。
     * 浏览器对多份 CSP 取交集，两份一致时语义无害，但响应头会膨胀一倍、
     * 而且将来若两边策略漂移，排障会非常痛苦。这里以「已有则不再写」收敛。
     */
    if (hasCsp(existing)) {
      callback({ responseHeaders: existing })
      return
    }
    callback({
      responseHeaders: {
        ...existing,
        'Content-Security-Policy': [policy],
      },
    })
  })
}

/** 响应头里是否已带 CSP（头名大小写不敏感）。 */
function hasCsp(headers: Record<string, string[]>): boolean {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'content-security-policy') return true
  }
  return false
}