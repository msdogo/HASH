import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MirrorWindow, serialFromHash } from '../src/components/MirrorWindow'
import { MirrorSidebar } from '../src/components/MirrorSidebar'
import { SIDEBAR_KEYS } from '../src/shared/device-key'
import { t } from '../src/shared/i18n'

/**
 * 投屏窗口的渲染门禁。
 *
 * 本工程没有 jsdom：SSR 只跑一次 render，拿不到 onClick。
 * 所以这里能断言的只有「渲染出什么」——按钮是否存在、是否带可读标签、
 * 画面区是否**真的空着**（嵌入的原生窗口要盖在那里）。
 * 点击接线本身属已知无门禁，如实登记在 progress.md。
 */
describe('serialFromHash', () => {
  it('解析投屏窗口的 hash', () => {
    expect(serialFromHash('#/mirror/ABC123')).toBe('ABC123')
  })

  it('带冒号的无线设备序列号能还原', () => {
    expect(serialFromHash('#/mirror/' + encodeURIComponent('192.168.1.7:5555'))).toBe('192.168.1.7:5555')
  })

  it('不是投屏 hash 返回空串', () => {
    expect(serialFromHash('#/settings')).toBe('')
    expect(serialFromHash('')).toBe('')
  })

  it('非法百分号编码不抛（返回空串，窗口显示提示而不是崩掉）', () => {
    expect(serialFromHash('#/mirror/%E0%A4%A')).toBe('')
  })
})

describe('MirrorSidebar', () => {
  it('六个按键全部渲染，且都有中文 title（图标按钮必须有可读名）', () => {
    const html = renderToStaticMarkup(React.createElement(MirrorSidebar, { onPress: () => undefined }))
    for (const key of SIDEBAR_KEYS) {
      const label = t('mirror.key.' + (key === 'volumeUp' ? 'volumeUp' : key))
      expect(html, key).toContain('title="' + label + '"')
    }
  })

  it('disabled 时按钮带 disabled 属性（离线设备不是点了没反应）', () => {
    const html = renderToStaticMarkup(
      React.createElement(MirrorSidebar, { onPress: () => undefined, disabled: true }),
    )
    expect((html.match(/disabled=""/g) ?? []).length).toBe(6)
  })

  it('busyKey 生效时全部按钮禁用（防止连点打爆 adb）', () => {
    const html = renderToStaticMarkup(
      React.createElement(MirrorSidebar, { onPress: () => undefined, busyKey: 'home' }),
    )
    expect((html.match(/disabled=""/g) ?? []).length).toBe(6)
  })
})

/**
 * 用与 tests/app-nav.test.tsx 同一手法断言：把组件断言成一个「收 props 的普通组件」。
 *
 * 为什么需要这层断言：MirrorWindow 的签名是 `(props: MirrorWindowProps = {})`，
 * React.createElement 的类型重载认不出「可选 props 的组件」，会报 attributes 不匹配。
 * 这不是类型系统的妥协，而是「注入点只用于测试」这件事的如实表达。
 */
const MirrorWindowWithProps = MirrorWindow as unknown as (
  props: { initial?: { serial?: string; model?: string } },
) => React.ReactElement

describe('MirrorWindow', () => {
  it('侧边栏 + 空画面区（画面由主进程嵌入，DOM 里必须是空的占位）', () => {
    const html = renderToStaticMarkup(
      React.createElement(MirrorWindowWithProps, { initial: { serial: 'ABC123' } }),
    )
    expect(html).toContain(t('mirror.opening'))
    expect(html).toContain('ABC123')
    // 侧边栏的六个键必须在
    expect((html.match(/aria-label="/g) ?? []).length).toBeGreaterThanOrEqual(6)
  })

  it('顶栏显示设备**型号**，不显示完整序列号', async () => {
    /*
     * 串号（9N9CN2G0012A3P）对用户没有意义，型号（DJI RC PLUS 2）一眼知道是哪台。
     * 这条用例同时锁两件事：
     *   ① 型号真的渲染出来了；
     *   ② 完整串号**没有**出现在可见文本里 —— 它只留在 title 属性中。
     * 只断言 ① 的话，把 serial 和 model 一起打印出来也能过，等于没锁住。
     */
    const html = renderToStaticMarkup(
      React.createElement(MirrorWindowWithProps, {
        initial: { serial: '9N9CN2G0012A3P', model: 'DJI RC PLUS 2' },
      }),
    )
    expect(html).toContain('DJI RC PLUS 2')
    // 完整串号只能出现在 title 属性里，不能出现在文本节点里
    const textOnly = html.replace(/<[^>]*>/g, '')
    expect(textOnly).not.toContain('9N9CN2G0012A3P')
  })

  it('型号缺失时回退 serial 后 4 位（绝不显示空字符串）', () => {
    const html = renderToStaticMarkup(
      React.createElement(MirrorWindowWithProps, { initial: { serial: '9N9CN2G0012A3P' } }),
    )
    expect(html).toContain('A3P')
    const textOnly = html.replace(/<[^>]*>/g, '')
    expect(textOnly).not.toContain('9N9CN2G0012A3P')
  })

  it('顶栏用 items-stretch，右上角三个按钮才撑满高度', () => {
    /*
     * 用户实测反馈：三个按钮是「顶栏中间一撮悬空的小方块」。
     * 根因是顶栏用了 items-center —— WindowControls 里虽写了 h-full，
     * 但父容器高度由内容决定，100% 撑不到顶栏。
     *
     * 这条用例锁两件事：① 用 items-stretch；② 不能用 items-center。
     * 只断言 ① 不够：两个类可以同时存在，而 items-center 在 CSS 里后写者胜，
     * 按钮照样不满高 —— 那正是最初的样子。
     */
    const html = renderToStaticMarkup(
      React.createElement(MirrorWindowWithProps, { initial: { serial: 'ABC123' } }),
    )
    const header = /<header[^>]*>/.exec(html)?.[0] ?? ''
    expect(header).toContain('items-stretch')
    expect(header).not.toContain('items-center')
  })

  it('顶栏与侧栏用浅色主题，与主应用一致（不再是深色条）', () => {
    // 深色是投屏窗口最初的写法。用户要求与主应用统一 ——
    // 主应用顶栏是浅底 + neutral-300 分隔线，设备栏是 #F0F2F5。
    const html = renderToStaticMarkup(
      React.createElement(MirrorWindowWithProps, { initial: { serial: 'ABC123' } }),
    )
    expect(html).not.toContain('bg-neutral-800')
    expect(html).toContain('border-neutral-300')
    // 侧栏底色与主应用设备栏同一个值
    expect(html).toContain('#F0F2F5')
  })

  it('画面区仍是深色（视频画布，通留白不能是白底）', () => {
    // 这一条与上一条不矛盾：顶栏/侧栏跟主应用统一，
    // 但画面是视频画布，letterbox 留白必须是深色，否则画面像贴在白纸上。
    const html = renderToStaticMarkup(
      React.createElement(MirrorWindowWithProps, { initial: { serial: 'ABC123' } }),
    )
    expect(html).toContain('bg-neutral-900')
  })

  it('没有 serial 时侧边栏禁用（避免对着空窗口按返回键）', () => {
    /*
     * 只数**侧边栏里**的 disabled，不数整页。
     *
     * 原先数整页的 disabled=""（恰好 6）。加了顶栏的「重置窗口」按钮之后
     * 它也是 disabled，于是变成 7 —— 那种断言测的是"页面上有几个 disabled"，
     * 而不是"侧边栏是不是全禁用"，一加按钮就红，红的原因与它要锁的东西无关。
     */
    const html = renderToStaticMarkup(
      React.createElement(MirrorWindowWithProps, { initial: { serial: '' } }),
    )
    const sidebar = /<nav[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? ''
    expect(sidebar).not.toBe('')
    expect((sidebar.match(/disabled=""/g) ?? []).length).toBe(6)
  })

  it('顶栏有「重置窗口大小」按钮（拉乱窗口后能一键恢复）', () => {
    /*
     * 这个按钮的价值在于**不关窗口**就能恢复默认尺寸 ——
     * 关掉重开要等 6~8 秒 scrcpy 重建窗口。
     */
    const html = renderToStaticMarkup(
      React.createElement(MirrorWindowWithProps, { initial: { serial: 'ABC123' } }),
    )
    expect(html).toContain('aria-label="' + t('mirror.resetSize') + '"')
    // 有 serial 时它必须可点（不能像侧边栏那样被禁用）
    const resetBtn = new RegExp('<button[^>]*aria-label="' + t('mirror.resetSize') + '"[^>]*>').exec(html)?.[0] ?? ''
    expect(resetBtn).not.toBe('')
    expect(resetBtn).not.toContain('disabled')
  })

  it('没有 serial 时重置按钮也禁用（没有会话可重置）', () => {
    const html = renderToStaticMarkup(
      React.createElement(MirrorWindowWithProps, { initial: { serial: '' } }),
    )
    const resetBtn = new RegExp('<button[^>]*aria-label="' + t('mirror.resetSize') + '"[^>]*>').exec(html)?.[0] ?? ''
    expect(resetBtn).toContain('disabled')
  })
})
