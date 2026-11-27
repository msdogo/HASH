import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { App } from '../src/App'
import { SettingsPage } from '../src/pages/SettingsPage'
import { SettingsWindow } from '../src/components/SettingsWindow'
import { t } from '../src/shared/i18n'
import { PAGES, type Page } from '../src/shared/nav'
import type { SettingsData } from '../src/shared/settings'

/*
 * 渲染期的页面路由门禁。
 *
 * 为什么能测：App 支持 initial.page / initial.settingsWindow 注入
 * （与 DeviceRail 的 initial 同一手法）。当前在哪一页本来是 useState 内部状态，
 * SSR 只有一次 render，不能「点一下再断言」；注入之后，
 * 「page → 真的渲染了那一页」与「#/settings → 渲染设置窗口」都有了可复现判据 ——
 * 判据是用户看得见的 HTML，不是源码文本。
 *
 * onClick 里那几行接线（点设备 / 点设置）仍然观测不到，已如实登记在
 * progress.md「已知无门禁清单」，本文件不编造 toContain(源码) 断言。
 */

const SETTINGS: SettingsData = {
  downloadDir: 'D:/Downloads/adbfm',
  defaultDownloadDir: 'C:/Users/me/Downloads',
  appVersion: '9.9.9-fixture',
  adb: { state: 'ok', source: 'bundled', path: 'C:/app/platform-tools/adb.exe', version: '1.0.41' },
  scrcpyArgs: '',
  defaultScrcpyArgs: '',
}

/** 各页的「只可能在这一页出现」的标记（由实测渲染输出确定，不是猜的）。 */
const MARK: Record<Page, string> = {
  // 文件页：没有设备时的占位文案（只有 FilesPage 渲染它，DeviceRail 不渲染）
  files: t('devices.selectHint'),
  // 总览页：批量操作标题
  overview: t('batch.title'),
  /*
   * 应用页（P1 第二批）。
   *
   * 用「没有设备时的占位文案」作标记：它与文件页的 devices.selectHint 不同，
   * 且只有 AppsPage 会渲染它。标记必须互不重复，否则分不清渲染了哪一页。
   */
  apps: t('apps.noDevice'),
}

function appHtml(page: Page): string {
  return renderToStaticMarkup(React.createElement(
    App as unknown as (p: { initial?: { page?: Page; settingsWindow?: boolean } }) => React.ReactElement,
    { initial: { page } },
  ))
}

/** 按 hash 分流的「设置窗口」形态。 */
function settingsWindowHtml(): string {
  return renderToStaticMarkup(React.createElement(
    App as unknown as (p: { initial?: { settingsWindow?: boolean } }) => React.ReactElement,
    { initial: { settingsWindow: true } },
  ))
}

/** 取某个按钮的**整段**HTML（开标签 + 内容 + 闭标签），按文案定位。 */
function buttonByText(html: string, text: string): string {
  const tags = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []
  const hit = tags.find((tag) => tag.includes(text))
  if (hit === undefined) throw new Error('找不到文案为 ' + text + ' 的按钮：' + html.slice(0, 2000))
  return hit
}

/**
 * 按钮里**真的看得见**的文本（标签之间那部分）。
 *
 * 为什么要剥出内容再判：title / aria-label 里也有同样的字，
 * 直接用 includes 会把「按钮上没字、只有 tooltip」也算通过。
 */
function buttonInner(button: string): string {
  const open = button.indexOf('>')
  const close = button.lastIndexOf('</button>')
  if (open < 0 || close < 0) throw new Error('不是一段完整的按钮 HTML：' + button)
  return button.slice(open + 1, close)
}

describe('App 的 page 状态真的决定渲染哪一页', () => {
  it('每一页只渲染自己（标记互不串台）', () => {
    for (const page of PAGES) {
      const html = appHtml(page)
      expect(html, page).toContain(MARK[page])
      for (const other of PAGES) {
        if (other === page) continue
        expect(html, page + ' 不该包含 ' + other).not.toContain(MARK[other])
      }
    }
  })

  it('生产路径：不传 initial → 首屏是文件页（与改前一致）', () => {
    const html = renderToStaticMarkup(React.createElement(App))
    expect(html).toContain(MARK.files)
  })

  /*
   * 设置不再是主窗口内的一页 —— 这条断言守的是「别把它又加回去」。
   * 加回去的后果：主窗口里又出现一个占满内容区的设置页，
   * 而设置窗口同时也存在，用户会看到两个设置界面。
   */
  it('主窗口的任何一页都不渲染设置页', () => {
    for (const page of PAGES) {
      expect(appHtml(page), page).not.toContain('data-testid="settings-page"')
    }
  })
})

/*
 * 顶栏与左栏的形态（用户实测反馈的两条）。
 *
 * 这两条都必须断言**渲染输出**，不能断言源码文本：
 * 「左栏底部没有那个按钮」用 HTML 判断才是真的没画出来；
 * 「页签撑满顶栏」只能通过它的 class 看 —— 而 class 就在 HTML 里，所以能测。
 */
describe('左栏不再有「全部设备」按钮（顶栏页签已是入口）', () => {
  it('渲染结果里没有那个左栏按钮', () => {
    const html = appHtml('files')
    /*
     * 判据是 **<aside> 之内**不出现「全部设备」。
     * 顶栏那个页签文案一模一样，直接断言整页 not.toContain 会永远为假 ——
     * 这正是本项目反复遇到的「断言命中了别处文字」。
     */
    const aside = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'))
    expect(aside.length).toBeGreaterThan(0)
    expect(aside).not.toContain(t('nav.overview'))
  })

  it('底部统计仍然保留（它是状态，不是入口）', () => {
    const html = appHtml('files')
    const aside = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'))
    expect(aside).toContain('共')
  })
})

describe('顶栏：应用图标与撑满高度的页签', () => {
  it('左上角渲染了应用图标', () => {
    const html = appHtml('files')
    const h1 = html.slice(html.indexOf('<h1'), html.indexOf('</h1>'))
    expect(h1).toContain('<img')
    // 装饰性图标：屏幕阅读器不该读它，alt 必须为空
    expect(h1).toContain('alt=""')
  })

  it('页签用 items-stretch 且不再是圆角小胶囊（否则撑满后是方块套圆角）', () => {
    const html = appHtml('files')
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'))
    expect(nav).toContain('items-stretch')
    expect(nav).not.toContain('rounded')
  })

  it('页签与设置按钮同高：两者都不再写死 py-0.5 的小内边距', () => {
    const html = appHtml('files')
    // 设置按钮在 nav 之外
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'))
    expect(header).not.toContain('py-0.5')
  })
})

describe('设置是独立窗口（#/settings 分流）', () => {
  it('hash 命中时只渲染设置窗口，不渲染主窗口的顶栏/页签', () => {
    const html = settingsWindowHtml()
    expect(html).toContain('data-testid="settings-page"')
    /*
     * 主窗口的页签不该出现（否则两套导航会同时存在）。
     *
     * 判据用 <nav> 元素而不是文案：'应用' 这两个字也出现在设置页自己的
     * 说明文字里（「adb 由应用自动定位」），拿文案判会永远为真 ——
     * 与本项目反复踩过的「断言命中的是别处文字」同一类无牙判据。
     */
    expect(html).not.toContain('<nav')
    expect(html).not.toContain(t('nav.overview'))
  })

  it('设置窗口有自己的顶栏标题（否则无边框窗口看起来像一张浮空卡片）', () => {
    expect(settingsWindowHtml()).toContain(t('settings.title'))
  })

  it('设置窗口有最小化与关闭，但没有最大化（内容是固定两块，最大化只是空白）', () => {
    const html = settingsWindowHtml()
    expect(html).toContain(t('window.minimize'))
    expect(html).toContain(t('window.close'))
    expect(html).not.toContain(t('window.maximize'))
  })
})

/*
 * 设置页**不再有**「返回」按钮。
 *
 * 历史：它曾经是页面时代的必需品（R3-1：进得去出不来）。现在设置是独立子窗口，
 * 出口就是窗口右上角 ×。同一个动作画两遍会让用户猜「返回」和「关闭」有什么差别，
 * 而实际上两者一模一样 —— 用户实测反馈的第一条就是这个多余按钮。
 *
 * 这条断言方向是反的（not.toContain）也仍然有门禁价值：它锁住「别再加回来」。
 */
describe('设置页没有返回按钮（出口只有窗口 ×）', () => {
  const PAGE = SettingsPage as unknown as (props: {
    initial?: { data?: SettingsData | null; loading?: boolean; error?: string | null }
  }) => React.ReactElement

  function settingsHtml(): string {
    return renderToStaticMarkup(React.createElement(PAGE, { initial: { data: SETTINGS } }))
  }

  it('渲染结果里没有「返回」按钮', () => {
    const html = settingsHtml()
    expect(html).not.toContain(t('settings.back'))
    expect(html).not.toContain('aria-label="' + t('settings.back') + '"')
  })

  it('设置页内容仍然完整渲染（删按钮没连带删掉正文）', () => {
    const html = settingsHtml()
    expect(html).toContain('data-testid="settings-page"')
    expect(html).toContain(t('settings.title'))
  })
})

describe('SettingsWindow 外壳', () => {
  const Shell = SettingsWindow as unknown as (props: { initial?: { maximized?: boolean } }) => React.ReactElement

  it('外壳包含设置内容与顶栏（两者缺一窗口就不成立）', () => {
    const html = renderToStaticMarkup(React.createElement(Shell, {}))
    expect(html).toContain('data-testid="settings-page"')
    expect(html).toContain(t('window.close'))
  })
})
