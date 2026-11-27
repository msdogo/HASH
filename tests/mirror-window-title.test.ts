import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/*
 * 投屏窗口「任务栏名 = 设备名」的源码静态门禁。
 *
 * ===== 为什么是静态断言而不是行为测试 =====
 * 要观测到的两件事都发生在主进程的 BrowserWindow 上：
 *   1) 构造参数里传了 title（决定任务栏按钮的初始名字）
 *   2) 拦掉了 page-title-updated（否则渲染层一加载就把标题打回 HASH）
 * 本工程 environment: node、没有 jsdom、也没有给 electron 做过 mock，
 * 而 electron/mirror/window.ts 还连带依赖 ./embed 的 koffi 原生调用 ——
 * 为它搭一套假 Electron 壳的成本远高于收益，且那种假壳极易变成"只测假壳"。
 *
 * 所以沿用本仓 ui-contract.test.ts 的手法：把**容易在后续重构里被悄悄删掉**的
 * 两行用源码断言锁住。算法本身（型号 + 尾号、回退规则）已有真单元测试，见
 * tests/mirror.test.ts 的 describe('mirrorTitleOf')。
 */

const root = path.resolve(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

describe('投屏窗口的任务栏标题', () => {
  const source = read('electron/mirror/window.ts')

  it('创建窗口时把会话标题作为 title 传进去', () => {
    /*
     * 锁的是「BrowserWindow 的构造参数里有 title: session.title」。
     * 删掉这一行 → 所有投屏窗口继承 index.html 的 <title>HASH</title>，
     * 开两台设备会出现两个一模一样的「HASH」按钮。
     */
    expect(source).toMatch(/new BrowserWindow\(\{[\s\S]*?title:\s*session\.title[\s\S]*?\}\)/)
  })

  it('title 在 webPreferences 之前（同属一个构造函数调用）', () => {
    // 防止"参数传到了别处"的误判：title 必须和 width/webPreferences 在同一个对象字面量里。
    const start = source.indexOf('new BrowserWindow({')
    const end = source.indexOf('})', start)
    expect(start).toBeGreaterThan(-1)
    const block = source.slice(start, end)
    expect(block).toContain('title: session.title')
    expect(block).toContain('webPreferences')
  })

  it('拦截 page-title-updated，阻止渲染层覆盖标题', () => {
    /*
     * 这是另一半，缺了它上一半就是白做的：
     * 渲染层加载 index.html 后 document.title='HASH' 会回写窗口标题，
     * 用户看到的是任务栏闪一下设备名再变回 HASH。
     * 这里要求监听存在**且**回调里真的调了 preventDefault（只注册不拦 = 无效）。
     */
    expect(source).toMatch(
      /\bwin\.on\(\s*'page-title-updated'\s*,\s*\([^)]*\)\s*=>\s*\{[^}]*preventDefault\(\)/,
    )
    /*
     * 反向门禁：挂在 webContents 上等于没挂。
     * 实机对照（Electron 45，三步各起一个进程）：
     *   none       → title=HASH
     *   webContents→ title=HASH         ← 拦不住
     *   window     → title=MI 6 (1A2B)  ← 唯一有效的写法
     */
    expect(source).not.toMatch(/webContents\.on\(\s*'page-title-updated'/)
  })

  it('拦截发生在 loadView 之前（不给页面抢跑的机会）', () => {
    const listener = source.indexOf("'page-title-updated'")
    const load = source.indexOf('deps.loadView(')
    expect(listener).toBeGreaterThan(-1)
    expect(load).toBeGreaterThan(-1)
    expect(listener).toBeLessThan(load)
  })

  it('渲染层入口仍然是 <title>HASH</title>（主窗口该叫这个名字）', () => {
    // 反向保护：不要把 index.html 的 title 直接改掉 —— 那会把主窗口一起改名。
    expect(read('index.html')).toMatch(/<title>HASH<\/title>/)
  })

  it('主窗口与设置窗口不受影响（不装这个监听）', () => {
    // 只有投屏窗口需要按设备区分；主进程里给主窗口装同一个监听会误伤。
    expect(read('electron/main.ts')).not.toContain('page-title-updated')
  })

  it('scrcpy 原生窗口标题仍是红线拼接（嵌入靠它找 HWND）', () => {
    // title 参数只影响宿主窗口；--window-title 一旦被改，findWindowByTitle 就找不到画面。
    expect(source).toContain('findWindowByTitle(SCRCPY_WINDOW_PREFIX + session.token)')
  })
})
