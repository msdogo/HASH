import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsPage } from '../src/pages/SettingsPage'
import { FileToolbar } from '../src/components/FileToolbar'
import { t, tf } from '../src/shared/i18n'
import type { SettingsData } from '../src/shared/settings'

/*
 * R2-2 的**渲染期**门禁（设置页 + 全选按钮）。
 *
 * 为什么必须渲染真组件：本项目已经吃过 14 次「源码文本断言」的亏 ——
 * expect(source).toContain('…') 连注释都能满足。而这一轮要证明的两件事
 * 恰好都是「用户看不看得见」：
 *   1. 设置页真的把当前下载路径 / adb 来源·路径·版本渲染出来；
 *   2. 工具条上真的有一个「全选」按钮，且**无选中项时它是可点的**。
 *
 * 工程说明：本文件归 tsconfig.app 管（有 DOM lib 与 jsx），运行环境仍是 node ——
 * renderToStaticMarkup 不需要 DOM。SettingsPage 支持 initial 注入，
 * 因为 zustand v5 的 useSyncExternalStore 在 SSR 下取初始快照并冻结
 * （先 setState 再渲染拿到的仍是初始值，本工程实测过）。
 */

const SETTINGS: SettingsData = {
  downloadDir: 'D:/Downloads/adbfm',
  defaultDownloadDir: 'C:/Users/me/Downloads',
  // R7：故意不是 package.json 里的真实版本，这样「渲染的是 appVersion 而不是写死的 0.1.0」才可证
  appVersion: '7.42.13',
  adb: { state: 'ok', source: 'bundled', path: 'C:/app/resources/platform-tools/adb.exe', version: '1.0.41' },
}

const PAGE = SettingsPage as unknown as (props: {
  initial?: { data?: SettingsData | null; loading?: boolean; error?: string | null }
}) => React.ReactElement

function settingsHtml(initial: { data?: SettingsData | null; loading?: boolean; error?: string | null }): string {
  return renderToStaticMarkup(React.createElement(PAGE, { initial }))
}

/** 从渲染出的 HTML 里按 title 取一个按钮的**开标签**（用于判断 disabled）。 */
function buttonWithTitle(html: string, title: string): string {
  const tags = html.match(/<button\b[^>]*>/g) ?? []
  const hit = tags.find((tag) => tag.includes('title="' + title + '"'))
  if (hit === undefined) throw new Error('找不到 title=' + title + ' 的按钮：' + html.slice(0, 3000))
  return hit
}

/** React 对布尔属性渲染成 disabled=""，不能用 includes('disabled')（类名里有 disabled:opacity-40）。 */
function isDisabled(tag: string): boolean {
  return /\sdisabled=""/.test(tag)
}

describe('R2-2 设置页：默认下载路径（可写）', () => {
  it('渲染出当前下载路径（含完整绝对路径）', () => {
    const html = settingsHtml({ data: SETTINGS })
    expect(html).toContain(tf('settings.downloadDir.current', { dir: SETTINGS.downloadDir }))
    expect(html).toContain('D:/Downloads/adbfm')
  })

  it('「更换」与「恢复默认」两个按钮都在，且在有数据时都可点', () => {
    const html = settingsHtml({ data: SETTINGS })
    // 自定义目录：恢复默认必须可点（当前不是默认值）
    expect(isDisabled(buttonWithTitle(html, t('settings.downloadDir.reset')))).toBe(false)
    // 「更换」按文案渲染（它没有 title，用文本断言按钮存在）
    expect(html).toContain(t('settings.downloadDir.change'))
  })

  it('当前已是默认目录时「恢复默认」禁用（没有可恢复的东西）', () => {
    const html = settingsHtml({ data: { ...SETTINGS, downloadDir: SETTINGS.defaultDownloadDir } })
    expect(isDisabled(buttonWithTitle(html, t('settings.downloadDir.reset')))).toBe(true)
    expect(html).toContain(t('settings.downloadDir.defaultHint'))
  })

  it('自定义目录时显示「当前是自定义目录」（与默认值提示互斥）', () => {
    const html = settingsHtml({ data: SETTINGS })
    expect(html).toContain(t('settings.downloadDir.customHint'))
    expect(html).not.toContain(t('settings.downloadDir.defaultHint'))
  })

  it('还没读到设置时显示「正在读取设置…」而不是显示一个空路径', () => {
    const html = settingsHtml({ data: null, loading: true })
    expect(html).toContain(t('settings.downloadDir.loading'))
    expect(html).not.toContain(t('settings.downloadDir.current').replace('{dir}', ''))
  })

  it('读取完成但路径为空时显示「还没有读到下载路径」（与加载中区分）', () => {
    const html = settingsHtml({ data: { ...SETTINGS, downloadDir: '' }, loading: false })
    expect(html).toContain(t('settings.downloadDir.empty'))
  })

  it('读取失败时把错误码翻成中文人话显示（不显示裸码）', () => {
    const html = settingsHtml({ data: SETTINGS, error: 'E_NOT_FOUND' })
    expect(html).toContain('这个路径不存在')
    expect(html).not.toContain('>E_NOT_FOUND<')
  })
})

describe('R2-2 设置页：adb 状态（只读）', () => {
  it('渲染出来源 / 路径 / 版本三行', () => {
    const html = settingsHtml({ data: SETTINGS })
    expect(html).toContain(t('settings.adb.source'))
    expect(html).toContain(t('settings.adb.source.bundled'))
    expect(html).toContain(t('settings.adb.path'))
    expect(html).toContain('C:/app/resources/platform-tools/adb.exe')
    expect(html).toContain(t('settings.adb.version'))
    expect(html).toContain('1.0.41')
  })

  it('三种来源都可能出现（映射不是写死一个值）', () => {
    const path = settingsHtml({ data: { ...SETTINGS, adb: { state: 'ok', source: 'path', path: 'P:/adb.exe', version: '1' } } })
    expect(path).toContain(t('settings.adb.source.path'))
    expect(path).not.toContain(t('settings.adb.source.bundled'))

    const env = settingsHtml({ data: { ...SETTINGS, adb: { state: 'ok', source: 'env', path: 'E:/adb.exe', version: '2' } } })
    expect(env).toContain(t('settings.adb.source.env'))

    const custom = settingsHtml({ data: { ...SETTINGS, adb: { state: 'ok', source: 'custom', path: 'C:/my/adb.exe', version: '3' } } })
    expect(custom).toContain(t('settings.adb.source.custom'))
  })

  it('还在自检时显示「正在查找 adb…」，同时不显示路径/版本行', () => {
    const html = settingsHtml({ data: { ...SETTINGS, adb: { state: 'checking' } } })
    expect(html).toContain(t('settings.adb.checking'))
    /*
     * R7 起「版本」这个标签也出现在「关于」块里，所以这里把范围收窄到 adb 那块
     * （从 settings-adb 到 settings-about）—— 判定本身反而更准：
     * 若自检未完成时 adb 块仍渲染了版本行，这条照样红。
     */
    const adbSection = html.slice(
      html.indexOf('data-testid="settings-adb"'),
      html.indexOf('data-testid="settings-about"'),
    )
    expect(adbSection).not.toContain(t('settings.adb.version'))
    expect(adbSection).not.toContain(t('settings.adb.path'))
  })

  it('自检失败时显示中文错误文案', () => {
    const html = settingsHtml({ data: { ...SETTINGS, adb: { state: 'error', code: 'E_ADB_NOT_FOUND' } } })
    expect(html).toContain('没有找到可用的 adb')
    expect(html).not.toContain('E_ADB_NOT_FOUND')
  })

  it('adb 是只读的：整页没有任何可编辑输入框', () => {
    const html = settingsHtml({ data: SETTINGS })
    // adb 区块里不能出现 input/textarea（「不给改」是可验证的事实，不是注释）
    const adbSection = html.slice(html.indexOf('data-testid="settings-adb"'))
    expect(adbSection).not.toMatch(/<input|<textarea|<select/)
    expect(html).toContain(t('settings.adb.readonly'))
  })
})

describe('R7 设置页：关于（应用版本号）', () => {
  /*
   * 断言的是**具体的版本号值**，不是「有『版本』两个字」——
   * 后者把值改成空串也照样绿（本项目已吃过 15 次这类假护栏的亏）。
   * SETTINGS.appVersion 刻意取 7.42.13（既不是 package.json 的 0.1.0，也不是常见版本号），
   * 于是「渲染的是 appVersion 而不是写死的常量」这件事真的可证。
   */
  it('渲染出 appVersion 的具体值，且「关于」标题与「版本」标签来自 i18n', () => {
    const html = settingsHtml({ data: SETTINGS })
    expect(html).toContain('data-testid="settings-about"')
    expect(html).toContain('7.42.13')
    expect(html).toContain(t('settings.about.title'))
    expect(html).toContain(t('settings.about.version'))
  })

  it('换一个版本值，渲染结果跟着变（不是写死的常量）', () => {
    const other = settingsHtml({ data: { ...SETTINGS, appVersion: '3.1.4-rc.2' } })
    expect(other).toContain('3.1.4-rc.2')
    expect(other).not.toContain('7.42.13')
    // package.json 的真实版本也只是一个可能的取值，不是写死的答案
    expect(settingsHtml({ data: { ...SETTINGS, appVersion: '0.1.0' } })).toContain('0.1.0')
  })

  it('appVersion 为空串时显示占位符而不是空白（那行看着不像坏了）', () => {
    const html = settingsHtml({ data: { ...SETTINGS, appVersion: '' } })
    expect(html).toContain(t('settings.about.unknown'))
    expect(html).not.toContain('7.42.13')
    // 占位符渲染在「版本」这一行的值位置，不是页面别处冒出来的一句话
    const about = html.slice(html.indexOf('data-testid="settings-about"'))
    expect(about).toContain(t('settings.about.version'))
    expect(about).toContain(t('settings.about.unknown'))
  })

  it('还没读到设置时也不显示假版本号（显示占位符，且没有可编辑输入框）', () => {
    const html = settingsHtml({ data: null, loading: true })
    expect(html).toContain('data-testid="settings-about"')
    expect(html).toContain(t('settings.about.unknown'))
    expect(html).not.toContain('7.42.13')
    expect(html.slice(html.indexOf('data-testid="settings-about"'))).not.toMatch(/<input|<textarea|<select/)
  })

  it('版本值用等宽字体（与 adb 的路径/版本同一套 Row 样式）', () => {
    const html = settingsHtml({ data: SETTINGS })
    const about = html.slice(html.indexOf('data-testid="settings-about"'))
    // 值所在的那个 span 带 font-mono —— 与 adb 那两行 mono 值同款
    expect(about).toMatch(/class="[^"]*font-mono[^"]*"[^>]*>7\.42\.13</)
  })
})

describe('R2-2 设置页：结构与文案契约', () => {
  it('两块内容都渲染出来（防止只做了一块）', () => {
    const html = settingsHtml({ data: SETTINGS })
    expect(html).toContain('data-testid="settings-download-dir"')
    expect(html).toContain('data-testid="settings-adb"')
    expect(html).toContain(t('settings.title'))
  })

  it('没有硬编码中文：所有可见文案都能在 i18n 表里找到（渲染文本里出现的句子来自 t/tf）', () => {
    const html = settingsHtml({ data: SETTINGS })
    for (const key of ['settings.title', 'settings.downloadDir.title', 'settings.downloadDir.desc',
      'settings.downloadDir.change', 'settings.downloadDir.reset', 'settings.adb.title', 'settings.adb.readonly']) {
      expect(html, key).toContain(t(key))
      // 该 key 必须有真文案（未注册的 key 会原样返回）
      expect(t(key)).not.toBe(key)
    }
  })
})

/* ============ 多选可见入口：工具条上的「全选」 ============ */

function toolbarHtml(over: Partial<{ selectedCount: number; ready: boolean; query: string }> = {}): string {
  const props: React.ComponentProps<typeof FileToolbar> = {
    selectedCount: over.selectedCount ?? 0,
    ready: over.ready ?? true,
    onCreateFolder: () => undefined,
    onRename: () => undefined,
    onDelete: () => undefined,
    onCopyTo: () => undefined,
    onMoveTo: () => undefined,
    onDownload: () => undefined,
    onSelectAll: () => undefined,
    onScreenshot: () => undefined,
    onRecordStart: () => undefined,
    onRecordStop: () => undefined,
    onMirror: () => undefined,
    recording: false,
    query: over.query ?? '',
    onQueryChange: () => undefined,
  }
  return renderToStaticMarkup(React.createElement(FileToolbar, props))
}

describe('R2-2 多选入口：工具条「全选」按钮', () => {
  it('没有选中项时「全选」**可点**（全选的意义就是当前没选中）', () => {
    const tag = buttonWithTitle(toolbarHtml({ selectedCount: 0 }), t('files.toolbar.selectAll'))
    expect(isDisabled(tag)).toBe(false)
  })

  it('有其他选中项时也可点（全选 = 扩到全部，不该因已选几项而失效）', () => {
    const tag = buttonWithTitle(toolbarHtml({ selectedCount: 2 }), t('files.toolbar.selectAll'))
    expect(isDisabled(tag)).toBe(false)
  })

  it('对照：同一条工具条上「删除」在无选中时是禁用的（证明 disabled 判定本身有效）', () => {
    const html = toolbarHtml({ selectedCount: 0 })
    expect(isDisabled(buttonWithTitle(html, t('op.toolbar.delete')))).toBe(true)
    expect(isDisabled(buttonWithTitle(html, t('op.toolbar.download')))).toBe(true)
  })

  it('设备/目录不可用时「全选」跟着禁用（ready=false）', () => {
    const tag = buttonWithTitle(toolbarHtml({ ready: false }), t('files.toolbar.selectAll'))
    expect(isDisabled(tag)).toBe(true)
  })

  it('按钮带 title 与 aria-label（与既有按钮同样式、同样可发现）', () => {
    const tag = buttonWithTitle(toolbarHtml(), t('files.toolbar.selectAll'))
    expect(tag).toContain('aria-label="' + t('files.toolbar.selectAll') + '"')
    expect(t('files.toolbar.selectAll')).not.toBe('files.toolbar.selectAll')
  })

  it('i18n 里有全选与快捷键提示的文案（不会渲染成裸 key）', () => {
    expect(t('files.toolbar.selectAll')).toBe('全选')
    expect(t('files.selectHint')).toContain('Ctrl')
    expect(t('files.selectHint')).toContain('Shift')
  })
})

/* ============ R6：工具条右端的搜索框（渲染期门禁） ============ */

describe('R6 搜索框：渲染期可见性（行为门禁见 tests/file-view.test.ts）', () => {
  /*
   * 这里只证明「用户看得见什么」：输入框在、placeholder 是中文文案、清除按钮只在有内容时出现。
   * 真正的搜索行为（大小写/子串/trim/换目录清空）全部由 tests/file-view.test.ts 的纯函数用例守 ——
   * 本工程无 jsdom，输入框的 onChange 在 SSR 下永远不触发，拿它当行为门禁就是假护栏。
   */
  it('渲染出搜索输入框，placeholder 走 i18n（不是裸 key）', () => {
    const html = toolbarHtml()
    expect(html).toContain('placeholder="' + t('files.searchPlaceholder') + '"')
    expect(t('files.searchPlaceholder')).toBe('搜索当前目录文件名')
  })

  it('输入框带 aria-label（无 title 的元素也要能被辅助技术叫出名字）', () => {
    expect(toolbarHtml()).toContain('aria-label="' + t('files.searchPlaceholder') + '"')
  })

  it('搜索框为空时不渲染清除按钮（空输入框配一个叉号是无信息的装饰）', () => {
    const html = toolbarHtml()
    expect(html).toContain(t('files.searchPlaceholder'))
    expect(html).not.toContain('title="' + t('files.searchClear') + '"')
  })

  it('有搜索词时清除按钮出现，且带 title 与 aria-label', () => {
    const html = toolbarHtml({ query: 'route' })
    expect(html).toContain('title="' + t('files.searchClear') + '"')
    expect(html).toContain('aria-label="' + t('files.searchClear') + '"')
    // 受控：当前过滤词必须真的回填进 value（否则用户看不到自己在搜什么）
    expect(html).toContain('value="route"')
  })

  it('搜索框不因「没有选中项」而禁用（它不是对选中项的操作）', () => {
    const html = toolbarHtml({ selectedCount: 0, ready: false })
    const inputTags = html.match(/<input\b[^>]*>/g) ?? []
    expect(inputTags).toHaveLength(1)
    const only = inputTags[0] ?? ''
    expect(only).not.toBe('')
    expect(/\sdisabled=""/.test(only)).toBe(false)
  })

  it('搜索框在工具条上、与「全选」等按钮同一条（不新增行）', () => {
    const html = toolbarHtml()
    // 同一段 HTML 里既有按钮也有输入框，且只有一条工具条容器
    expect(html).toContain(t('files.toolbar.selectAll'))
    expect((html.match(/<input\b/g) ?? [])).toHaveLength(1)
    expect((html.match(/border-b/g) ?? []).length).toBeGreaterThan(0)
  })
})

