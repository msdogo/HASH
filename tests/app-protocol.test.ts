import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { APP_HOST, APP_SCHEME, appUrlToPath, toAppUrl } from '../electron/app-protocol'

/*
 * C2：生产模式 CSP 未落地（审查轮 1）。
 *
 * 根因：dev 走 loadURL(http://)，prod 走 loadFile(file://)。onHeadersReceived 只对
 * 有「响应头阶段」的事务触发，file:// 由 file URL loader 直接读盘，没有这一阶段，
 * 所以 prod 下一条 CSP 头都注不进去。而且 file:// 页面里的 'self' 是 opaque origin，
 * 就算注进去了也可能把 dist/assets/*.js 全拦掉 → 白屏。
 *
 * 解法：用自定义协议 app:// 提供 dist。它有真实响应头，onHeadersReceived 能生效，
 * 'self' 也等于 app://<host>，语义正常。
 */

const DIST = 'C:/app/dist'
/** 平台无关地比较路径（Windows 上 path.resolve 产出反斜杠，这是对的）。 */
const norm = (p: string): string => p.split('\\').join('/')

describe('C2 自定义协议路径映射', () => {
  it('app://<host>/index.html 映射到 dist/index.html', () => {
    expect(norm(appUrlToPath('app://bundle/index.html', DIST) ?? '')).toBe('C:/app/dist/index.html')
  })

  it('app://<host>/assets/x.js 映射到 dist/assets/x.js', () => {
    expect(norm(appUrlToPath('app://bundle/assets/index-abc.js', DIST) ?? '')).toBe('C:/app/dist/assets/index-abc.js')
  })

  it('末尾只有 slash 时回落到 index.html', () => {
    expect(norm(appUrlToPath('app://bundle/', DIST) ?? '')).toBe('C:/app/dist/index.html')
    expect(norm(appUrlToPath('app://bundle', DIST) ?? '')).toBe('C:/app/dist/index.html')
  })

  it('百分号编码被正确解码（中文文件名/带空格的资源）', () => {
    expect(norm(appUrlToPath('app://bundle/a%20b.png', DIST) ?? '')).toBe('C:/app/dist/a b.png')
    expect(norm(appUrlToPath('app://bundle/%E4%B8%AD%E6%96%87.js', DIST) ?? '')).toBe('C:/app/dist/中文.js')
  })

  /*
   * 关于目录穿越：实测 URL 标准解析器已经把明文 `..` 与百分号编码的 `%2e%2e`
   * 【都】规范化掉了（`app://bundle/%2e%2e/secret.txt` 的 pathname 直接是 `/secret.txt`）。
   * 所以「返回 null」不是正确断言 —— 那条输入压根不会穿越，返回 dist 内的文件是对的。
   * 真正该锁死的不变量是：**任何输入解析出来的路径都不得逃出 distRoot**。
   * 下面用一组攻击向量把这个不变量钉住（这也是 appUrlToPath 里那道 path.resolve 兜底的意义）。
   */
  it('任何输入都不得逃出 distRoot（不变量，比「返回 null」更强）', () => {
    const root = norm(path.resolve(DIST)) + '/'
    const attacks = [
      'app://bundle/../secret.txt',
      'app://bundle/%2e%2e/secret.txt',
      'app://bundle/%2E%2E/%2E%2E/secret.txt',
      'app://bundle/a/%2e%2e/b/../../secret.txt',
      'app://bundle/../../../../../../etc/passwd',
      'app://bundle/%252e%252e/secret.txt',
      'app://bundle/..%5c..%5csecret.txt',
      'app://bundle/%2e%2e%5csecret.txt',
      'app://bundle/C:/Windows/win.ini',
      'app://bundle//C:/Windows/win.ini',
      'app://bundle/....//....//secret.txt',
    ]
    for (const url of attacks) {
      const resolved = appUrlToPath(url, DIST)
      if (resolved === null) continue // 直接拒绝同样安全
      const normalized = norm(path.resolve(resolved)) + '/'
      expect(normalized.startsWith(root), url + ' → ' + normalized).toBe(true)
    }
  })

  it('盘符注入与反斜杠注入被拒绝（Windows 特有的逃逸向量）', () => {
    expect(appUrlToPath('app://bundle/C:/Windows/win.ini', DIST)).toBeNull()
    expect(appUrlToPath('app://bundle//C:/Windows/win.ini', DIST)).toBeNull()
    expect(appUrlToPath('app://bundle/..%5c..%5csecret.txt', DIST)).toBeNull()
    expect(appUrlToPath('app://bundle/%2e%2e%5csecret.txt', DIST)).toBeNull()
  })

  it('编码后的 .. 被解析器规范化后仍落在 dist 内（不是 null，但也没穿越）', () => {
    const resolved = appUrlToPath('app://bundle/%2e%2e/secret.txt', DIST)
    expect(resolved).not.toBeNull()
    expect(norm(resolved ?? '')).toBe('C:/app/dist/secret.txt')
  })

  it('非法百分号编码不抛错，返回 null', () => {
    expect(appUrlToPath('app://bundle/%ZZ.js', DIST)).toBeNull()
  })

  it('非 app 协议、非法 URL 一律返回 null（不抛错）', () => {
    expect(appUrlToPath('file:///C:/app/dist/index.html', DIST)).toBeNull()
    expect(appUrlToPath('http://evil.test/index.html', DIST)).toBeNull()
    expect(appUrlToPath('app://', DIST)).toBeNull()
    expect(appUrlToPath('not a url', DIST)).toBeNull()
  })

  it('toAppUrl 生成的标准形式可被 appUrlToPath 反解（往返一致）', () => {
    const url = toAppUrl('bundle', '/assets/index-abc.js')
    expect(url).toBe('app://bundle/assets/index-abc.js')
    expect(norm(appUrlToPath(url, DIST) ?? '')).toBe('C:/app/dist/assets/index-abc.js')
  })

  it('协议名是小写单段 scheme（Chromium 要求）', () => {
    expect(APP_SCHEME).toBe('app')
    expect(APP_SCHEME).toMatch(/^[a-z][a-z0-9+.-]*$/)
  })
})
describe('附带：app:// host 白名单（审查轮 2）', () => {
  it('只接受 bundle 这个 host', () => {
    expect(APP_HOST).toBe('bundle')
    expect(appUrlToPath('app://bundle/index.html', DIST)).not.toBeNull()
  })

  it('app://bundle:99/ 这类带端口的 URL 被拒（实测原实现返回 200）', () => {
    expect(appUrlToPath('app://bundle:99/index.html', DIST)).toBeNull()
    expect(appUrlToPath('app://bundle:99/assets/x.js', DIST)).toBeNull()
  })

  it('其它 host 一律拒绝', () => {
    expect(appUrlToPath('app://evil/index.html', DIST)).toBeNull()
    expect(appUrlToPath('app://evil.test/index.html', DIST)).toBeNull()
    expect(appUrlToPath('app://localhost/index.html', DIST)).toBeNull()
    expect(appUrlToPath('app://evil:8080/index.html', DIST)).toBeNull()
  })

  it('大小写不同的 host 也要被拒（只认精确的小写 bundle）', () => {
    expect(appUrlToPath('app://BUNDLE/index.html', DIST)).toBeNull()
    expect(appUrlToPath('app://Bundle/index.html', DIST)).toBeNull()
  })
})
