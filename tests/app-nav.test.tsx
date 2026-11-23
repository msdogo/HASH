import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { App } from '../src/App'
import { SettingsPage } from '../src/pages/SettingsPage'
import { t } from '../src/shared/i18n'
import type { Page } from '../src/shared/nav'
import type { SettingsData } from '../src/shared/settings'

/*
 * R3-1 的**渲染期**门禁：页面路由与设置页出口。
 *
 * 为什么能测：App 支持 initial.page 注入（与 DeviceRail 的 initial 同一手法）。
 * 当前在哪一页本来是 useState 内部状态，SSR 只有一次 render，不能「点一下再断言」；
 * 注入起始页之后，「page → 真的渲染了那一页」与「在设置页时顶栏按钮高亮」都有了
 * 可复现的判据 —— 判据是用户看得见的 HTML，不是源码文本。
 *
 * onClick 里那几行接线（点设备 / 点设置 / 点返回）仍然观测不到，已如实登记
 * progress.md「已知无门禁清单」，本文件不编造 toContain(源码) 断言。
 */

const SETTINGS: SettingsData = {
  downloadDir: 'D:/Downloads/adbfm',
  defaultDownloadDir: 'C:/Users/me/Downloads',
  appVersion: '9.9.9-fixture',
  adb: { state: 'ok', source: 'bundled', path: 'C:/app/platform-tools/adb.exe', version: '1.0.41' },
}

/** 三页各自的「只可能在这一页出现」的标记（由实测渲染输出确定，不是猜的）。 */
const MARK: Record<Page, string> = {
  // 文件页：没有设备时的占位文案（只有 FilesPage 渲染它，DeviceRail 不渲染）
  files: t('devices.selectHint'),
  // 总览页：批量操作标题
  overview: t('batch.title'),
  // 设置页：页面根节点的 data-testid（R2-2 起就有）
  settings: 'data-testid="settings-page"',
}

function appHtml(page: Page): string {
  return renderToStaticMarkup(React.createElement(App as unknown as (p: { initial?: { page?: Page } }) => React.ReactElement, {
    initial: { page },
  }))
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
 * 直接用 buttonByText 的 includes 会把「按钮上没字、只有 tooltip」也算通过 ——
 * 本项目已多次栽在「断言命中的是别处文字」这类无牙判据上。
 */
function buttonInner(button: string): string {
  const open = button.indexOf('>')
  const close = button.lastIndexOf('</button>')
  if (open < 0 || close < 0) throw new Error('不是一段完整的按钮 HTML：' + button)
  return button.slice(open + 1, close)
}

describe('R3-1：App 的 page 状态真的决定渲染哪一页', () => {
  it('page=files → 渲染文件页（不是设置页/总览页）', () => {
    const html = appHtml('files')
    expect(html).toContain(MARK.files)
    expect(html).not.toContain(MARK.settings)
    expect(html).not.toContain(MARK.overview)
  })

  it('page=overview → 渲染总览页', () => {
    const html = appHtml('overview')
    expect(html).toContain(MARK.overview)
    expect(html).not.toContain(MARK.settings)
    expect(html).not.toContain(MARK.files)
  })

  it('page=settings → 渲染设置页（而不是永远渲染文件页）', () => {
    const html = appHtml('settings')
    expect(html).toContain(MARK.settings)
    expect(html).not.toContain(MARK.files)
    expect(html).not.toContain(MARK.overview)
  })

  it('生产路径：不传 initial → 首屏是文件页（与改前一致）', () => {
    const html = renderToStaticMarkup(React.createElement(App))
    expect(html).toContain(MARK.files)
    expect(html).not.toContain(MARK.settings)
  })
})

describe('R3-1：顶栏「⚙设置」按钮的高亮跟着 page 走（toggle 的可见面）', () => {
  /*
   * 高亮类必须带**前后空格**再匹配：未选中的那一支是 hover:bg-neutral-200/70，
   * 直接用 includes('bg-neutral-200') 会永远为真（本项目反复踩过的无牙断言形态）。
   */
  const ACTIVE = ' bg-neutral-200 '

  it('在设置页时该按钮是高亮态', () => {
    expect(buttonByText(appHtml('settings'), t('nav.settings'))).toContain(ACTIVE)
  })

  it('不在设置页时该按钮不高亮（高亮不会永远为真）', () => {
    for (const page of ['files', 'overview'] as Page[]) {
      expect(buttonByText(appHtml(page), t('nav.settings')), page).not.toContain(ACTIVE)
    }
  })

  it('对照：设置页高亮的同时，「当前设备」页签不高亮（证明高亮判定确实在跟着 page 变）', () => {
    const html = appHtml('settings')
    expect(buttonByText(html, t('nav.files'))).not.toContain(ACTIVE)
  })
})

/* ============ 设置页的返回按钮（用户要的第一个出口） ============ */

const PAGE = SettingsPage as unknown as (props: {
  onBack: () => void
  initial?: { data?: SettingsData | null; loading?: boolean; error?: string | null }
}) => React.ReactElement

function settingsHtml(onBack: () => void = () => undefined): string {
  return renderToStaticMarkup(React.createElement(PAGE, { onBack, initial: { data: SETTINGS } }))
}

describe('R3-1：设置页的「返回」按钮', () => {
  it('真的渲染出一个带返回文案、可点的按钮', () => {
    const html = settingsHtml()
    const tag = buttonByText(html, t('settings.back'))
    // 按钮上**看得见**的字（不是只有 title/aria-label）
    expect(buttonInner(tag)).toContain(t('settings.back'))
    expect(tag).not.toMatch(/\sdisabled=""/)
    expect(tag).toContain('aria-label="' + t('settings.back') + '"')
    // 与页内既有小按钮同样的样式（边框 + 11px 灰字），不是裸文字按钮
    expect(tag).toContain('border-neutral-300')
  })

  it('文案来自 i18n（不是写死中文的裸字面量）', () => {
    const html = settingsHtml()
    expect(html).toContain(t('settings.back'))
    // 反向自证：未注册的 key 会原样返回，所以这条不是恒真
    expect(t('settings.back')).not.toBe('settings.back')
  })

  it('对照组：返回按钮之外，页面内容照常渲染（没有为了加按钮把设置页弄丢）', () => {
    const html = settingsHtml()
    expect(html).toContain('data-testid="settings-page"')
    expect(html).toContain(t('settings.title'))
    expect(html).toContain('data-testid="settings-adb"')
  })

  it('每次渲染都会把 onBack 交给同一个按钮（换一个回调，按钮仍在）', () => {
    // SSR 观测不到 onClick，但能证明按钮不是条件渲染的一部分 —— 换回调它照样在。
    const first = settingsHtml(() => undefined)
    const second = settingsHtml(() => undefined)
    expect(first).toContain(t('settings.back'))
    expect(second).toContain(t('settings.back'))
  })
})
