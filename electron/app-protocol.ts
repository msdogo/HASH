import path from 'node:path'

/**
 * 自定义协议 app://（审查轮 1 / C2）。
 *
 * ===== 为什么必须换掉 loadFile(file://) =====
 * 生产模式原来用 `win.loadFile(dist/index.html)`。两个致命问题：
 *
 * 1. **CSP 注不进去**：`session.webRequest.onHeadersReceived` 只对有「响应头阶段」的
 *    网络事务触发（http/https/ws）。file:// 由 file URL loader 直接读盘，根本没有
 *    这个阶段 —— 生产环境下一条 CSP 头都不会生效。这就是「dev 验证过了、prod 从没落地」。
 * 2. **'self' 语义不对**：file:// 页面的 origin 是 opaque origin，
 *    `default-src 'self'` 在 Chromium 里对 file:// 的匹配行为特殊，很可能把
 *    dist/assets/index-*.js 全拦掉 → 白屏。「要么没 CSP，要么白屏」的二选一。
 *
 * 解法：把 dist 目录用 `protocol.handle('app', ...)` 提供出来，页面走 app://<host>/index.html。
 * 这时：
 * - 每个响应都由我们亲手构造，**可以直接写 Content-Security-Policy 响应头**（不依赖
 *   onHeadersReceived 是否触发）；
 * - 注册成 standard + secure scheme 后，origin 是 app://<host>，
 *   `'self'` 语义正常，同源资源放行、外站一律拦掉。
 *
 * 本文件只放纯逻辑（URL ↔ 文件路径映射、响应头构造），不 import electron，
 * 因此可以在 vitest 里直接单测 —— 路径穿越这类安全逻辑必须有测试。
 */

/** 协议名。必须是 Chromium 认可的小写单段 scheme。 */
export const APP_SCHEME = 'app'
/** 协议内的主机名。所有资源都在同一个 host 下，'self' 等价于 app://bundle。 */
export const APP_HOST = 'bundle'

/** 生产模式下要注入的响应头（含 CSP，不依赖 onHeadersReceived）。 */
export function appResponseHeaders(csp: string, ext: string): Record<string, string> {
  return {
    'Content-Security-Policy': csp,
    'Content-Type': contentType(ext),
  }
}

/** 按扩展名给 Content-Type。只覆盖 dist 里会出现的类型。 */
export function contentType(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.woff':
      return 'font/woff'
    case '.woff2':
      return 'font/woff2'
    case '.ttf':
      return 'font/ttf'
    case '.ico':
      return 'image/x-icon'
    case '.map':
      return 'application/json; charset=utf-8'
    default:
      // 未知类型给二进制流，浏览器不会当脚本执行（比误判成 text/html 安全）
      return 'application/octet-stream'
  }
}

/** 生成协议内的 URL。 */
export function toAppUrl(host: string, pathname: string): string {
  const clean = pathname.startsWith('/') ? pathname : '/' + pathname
  return APP_SCHEME + '://' + host + clean
}

/**
 * 把 app:// URL 映射成本地文件绝对路径。
 *
 * 安全要点（必须全部满足，否则返回 null）：
 * - scheme 必须是 app；
 * - host 必须非空（app:// 空 host 无法绑定 origin）；
 * - 解码后不得含有 `..` 段（明文与 %2e%2e 编码都要拦）；
 * - 解析出来的绝对路径必须仍在 distRoot 之内（防止用各种花式编码逃逸）。
 * 任何一条不满足就返回 null —— 调用方据此返回 404，绝不抛错。
 */
export function appUrlToPath(rawUrl: string, distRoot: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== APP_SCHEME + ':') return null
  /*
   * host 白名单（审查轮 2 附带项）。
   *
   * 修前只判 host 非空，实测 `app://bundle:99/index.html` 返回 200 ——
   * 虽然端口不影响文件映射，但这意味着「host 任意」是被默认接受的，
   * 将来若有人用 host 区分多份资源，就会出现意外可达的路径。
   * 这里收紧成「只认精确的小写 bundle」：
   *   - 带端口（bundle:99）不算精确；
   *   - 大小写不同（BUNDLE）不算精确 —— URL 规范会把 host 统一小写，
   *     但这里仍然显式拒绝，避免依赖解析器的规范化行为。
   */
  if (parsed.hostname !== APP_HOST || parsed.port !== '') return null
  if (parsed.host !== APP_HOST) return null

  let pathname: string
  try {
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    // 非法百分号编码（%ZZ）会让 decodeURIComponent 抛错
    return null
  }
  // 先判穿越：解码之后仍出现 .. 段就一律拒绝
  for (const segment of pathname.split('/')) {
    if (segment === '..') return null
  }
  // 目录形式回落到 index.html
  const relative = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\//, '')
  const resolved = path.resolve(distRoot, relative)

  // 归一化之后再确认还在根内（双保险：path.resolve 已消掉 ..，这里断言结果）
  const rootResolved = path.resolve(distRoot)
  const withSep = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep
  if (resolved !== rootResolved && !resolved.startsWith(withSep)) return null

  return resolved
}
