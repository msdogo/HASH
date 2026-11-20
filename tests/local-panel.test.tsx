import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LocalPanel, pickLocalData, type LocalView } from '../src/components/LocalPanel'
import { t, tf } from '../src/shared/i18n'
import type { LocalListData } from '../src/shared/file-ops'

/*
 * 本地面板的**渲染期**门禁（R2 复审 Minor 2）。
 *
 * 修前「起始目录真的显示出来了」只有一条源码文本断言：
 *   expect(read('src/components/LocalPanel.tsx')).toContain("tf('local.startDir'")
 * 复审实测把那一行换成 JSX 注释（注释里保留原文）→ ui-contract 44 passed 全绿，
 * 也就是这个显示**完全没有门禁**（grep LocalPanel tests/*.tsx 零命中）。
 *
 * 这里用与 DeviceRail / SettingsPage 相同的手法：组件支持 initial 注入
 * （生产不传 → 读 store），测试传值 → renderToStaticMarkup 渲染真组件断言 HTML 文本。
 *
 * 工程说明：本文件归 tsconfig.app 管（DOM lib + jsx），运行环境仍是 node ——
 * renderToStaticMarkup 不需要 DOM。
 */

const LIST: LocalListData = {
  cwd: 'D:/work/photos',
  parent: 'D:/work',
  startDir: 'D:/work',
  items: [
    { name: 'a.jpg', isDir: false, isLink: false, size: 1024, mtime: 1, full: 'D:/work/photos/a.jpg' },
    { name: 'sub', isDir: true, isLink: false, size: 0, mtime: 2, full: 'D:/work/photos/sub' },
  ],
}

const PANEL = LocalPanel as unknown as (props: {
  onUpload: (localPath: string, name: string) => void
  collapsed: boolean
  onToggleCollapsed: () => void
  initial?: Partial<LocalView>
}) => React.ReactElement

function panelHtml(initial?: Partial<LocalView>, over: { collapsed?: boolean } = {}): string {
  return renderToStaticMarkup(React.createElement(PANEL, {
    onUpload: () => undefined,
    collapsed: over.collapsed ?? false,
    onToggleCollapsed: () => undefined,
    ...(initial === undefined ? {} : { initial }),
  }))
}

describe('R2 复审 Minor 2：本地面板真的显示「起始目录：<路径>」', () => {
  it('渲染出完整的那句话（不是某个字样，是 tf 拼好的整句）', () => {
    const html = panelHtml({ data: LIST })
    expect(html).toContain(tf('local.startDir', { dir: LIST.startDir }))
    // 反向自证：这句话里确实带了那个真实路径，而不是占位符没替换
    expect(html).toContain(LIST.startDir)
    expect(html).not.toContain('{dir}')
  })

  it('换一个起始目录，渲染出的文本随之变化（写死常量会在这里红）', () => {
    const other = 'E:/另一个 起点'
    const html = panelHtml({ data: { ...LIST, startDir: other } })
    expect(html).toContain(tf('local.startDir', { dir: other }))
    expect(html).not.toContain(tf('local.startDir', { dir: LIST.startDir }))
  })

  it('还没读到本地目录（data 为 null）时不渲染那句话，也不渲染路径', () => {
    const html = panelHtml({ data: null, loading: true })
    expect(html).not.toContain(tf('local.startDir', { dir: LIST.startDir }))
    expect(html).toContain(t('local.loading'))
  })

  it('对照组：面板本身确实渲染了（防止空 HTML 让上面几条空转）', () => {
    const html = panelHtml({ data: LIST })
    expect(html).toContain('data-testid="local-panel"')
    expect(html).toContain(t('local.title'))
    // 当前目录与每个条目都渲染出来了
    expect(html).toContain(LIST.cwd)
    expect(html).toContain('a.jpg')
    expect(html).toContain('sub')
  })

  it('错误码被翻成中文人话显示（不是裸码）', () => {
    const html = panelHtml({ data: LIST, error: 'E_NOT_FOUND' })
    expect(html).toContain('这个路径不存在')
    expect(html).not.toContain('>E_NOT_FOUND<')
  })

  it('选中的本地文件显示文件名、上传按钮可点（选中路径的判定走 selectedLocalPath）', () => {
    const html = panelHtml({ data: LIST, selected: ['a.jpg'] })
    expect(html).toContain('a.jpg')
    // 选中了文件 → 上传按钮不再 disabled（按钮文本形如「↑ 上传到当前目录」）
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []
    const upload = buttons.find((tag) => tag.includes(t('transfer.upload')))
    expect(upload).toBeDefined()
    expect(/\sdisabled=""/.test(upload as string)).toBe(false)

    // 反向对照：没有选中任何文件时，同一个按钮必须 disabled（否则上面那条是恒真）
    const idle = panelHtml({ data: LIST, selected: [] })
    const idleButtons = idle.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []
    const idleUpload = idleButtons.find((tag) => tag.includes(t('transfer.upload')))
    expect(idleUpload).toBeDefined()
    expect(/\sdisabled=""/.test(idleUpload as string)).toBe(true)
  })

  it('折叠状态渲染的是窄条（不渲染列表内容）', () => {
    const html = panelHtml({ data: LIST }, { collapsed: true })
    expect(html).not.toContain('data-testid="local-list"')
    expect(html).not.toContain(tf('local.startDir', { dir: LIST.startDir }))
  })
})

/*
 * 注入点的**生产路径**门禁（与 pickRailData 同一手法）。
 *
 * 复审已经证明「纯函数门禁只能证明判断对，不能证明组件用了它」，
 * 所以这里不做过度承诺：只钉住 pickLocalData 的两个方向 ——
 * 不传 initial / 传了 initial，两种输入下的返回值。组件若不再调用它，
 * 上面那组渲染用例会一起失守（渲染不出起始目录）。
 */
describe('LocalPanel：initial 为 undefined 时必须原样读 store', () => {
  const storeSlice: LocalView = {
    data: LIST,
    loading: false,
    error: null,
    selected: ['a.jpg'],
  }

  it('不传 initial → 四个字段全部来自 store（引用相等）', () => {
    const picked = pickLocalData(undefined, storeSlice)
    expect(picked.data).toBe(LIST)
    expect(picked.loading).toBe(false)
    expect(picked.error).toBe(null)
    expect(picked.selected).toBe(storeSlice.selected)
  })

  it('只注入部分字段时，其余字段仍读 store（不改注入语义）', () => {
    const injected: LocalListData = { ...LIST, startDir: 'F:/injected' }
    const picked = pickLocalData({ data: injected }, storeSlice)
    expect(picked.data).toBe(injected)
    expect(picked.selected).toBe(storeSlice.selected)
    expect(picked.error).toBe(null)
  })

  it('显式注入 null（还没读到目录）时不得回落到 store 的数据', () => {
    // 这条钉住「用 === undefined 判而不是 ??」：null 是有意义的值，不能被当成「没注入」
    const picked = pickLocalData({ data: null }, storeSlice)
    expect(picked.data).toBe(null)
    // 对照：store 里确实有数据，所以上面的 null 不是「两边都空」的巧合
    expect(storeSlice.data).not.toBe(null)
  })
})
