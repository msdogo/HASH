import { protocol, net } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildCsp } from '../csp'
import { APP_HOST, APP_SCHEME, appResponseHeaders, appUrlToPath, toAppUrl } from '../app-protocol'

/**
 * 生产模式的自定义协议注册（审查轮 1 / C2）。
 *
 * 这里只做两件事：注册 app:// 为 standard+secure scheme，然后 handle 它。
 * 纯逻辑（URL → 路径、响应头）都在 ../app-protocol.ts 里，那边有单测；
 * 本文件无法在 vitest 里测（依赖 electron 的 protocol/net），只做薄薄一层接线。
 */

/** 必须在 app ready 之前调用：scheme 的特权声明晚了就不生效。 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        // standard：让它有正常的 origin（'self' 才是 app://bundle，CSP 语义正确）
        standard: true,
        // secure：按安全上下文对待（crypto.subtle 等 API 需要）
        secure: true,
        // 允许 fetch / XHR 同源请求
        supportFetchAPI: true,
        // 允许被当作脚本/样式加载
        corsEnabled: true,
        // 允许 service worker（当前不用，但 standard scheme 必须声明才不别扭）
        allowServiceWorkers: false,
      },
    },
  ])
}

/** 默认页面入口。 */
export const APP_ENTRY_URL = toAppUrl(APP_HOST, '/index.html')

/**
 * 注册 app:// 的处理器：把请求映射到 dist 目录，并【亲手写 CSP 响应头】。
 *
 * 为什么 CSP 写在这里而不是 webRequest.onHeadersReceived：
 * 这正是 C2 的核心 —— onHeadersReceived 对 file:// 不触发，而 app:// 是我们自己的
 * 处理器，响应头由我们构造，100% 可控。onHeadersReceived 仍然保留（dev 的 http:// 走它），
 * 两边用同一份 buildCsp()，不会漂移。
 */
export function registerAppProtocol(distRoot: string, isDev: boolean): void {
  const csp = buildCsp(isDev)
  protocol.handle(APP_SCHEME, async (request) => {
    const filePath = appUrlToPath(request.url, distRoot)
    if (filePath === null) {
      return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } })
    }
    try {
      const response = await net.fetch(pathToFileURL(filePath).toString())
      if (!response.ok) {
        return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
      }
      const headers = appResponseHeaders(csp, path.extname(filePath))
      // 保留 net.fetch 给的其余头（尤其是 Content-Length），再覆盖 CSP 与 Content-Type
      const merged = new Headers(response.headers)
      for (const [name, value] of Object.entries(headers)) merged.set(name, value)
      return new Response(response.body, { status: response.status, headers: merged })
    } catch {
      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
    }
  })
}
