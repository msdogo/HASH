import { describe, it, expect } from 'vitest'
import {
  PAGES,
  pageAfterAppsClick,
  pageAfterSelectDevice,
  settingsClickOpensWindow,
  type Page,
} from '../src/shared/nav'
import { t } from '../src/shared/i18n'

/*
 * 页面路由的行为门禁。
 *
 * 组件的 onClick 在 SSR 下观测不到（工程无 jsdom），所以「点完之后去哪」这个
 * **决定**被抽成 src/shared/nav.ts 的纯函数，由这里直接驱动。
 * 「onClick 那一行有没有调它」仍然只能靠 code review —— 已如实登记进
 * progress.md 的「已知无门禁清单」，不造假文本断言。
 */

describe('点设备必须回到文件页（R3-1 的缺陷本体）', () => {
  it('在任何一页点设备的目标都一致（与当前页无关）', () => {
    for (const page of PAGES) expect(pageAfterSelectDevice(page), page).toBe('files')
  })

  it('反向自证：设备点击的目标在任何一页都不是非文件页', () => {
    for (const page of PAGES) expect(pageAfterSelectDevice(page), page).not.toBe(page === 'files' ? 'apps' : page)
  })
})

/*
 * 设置改成独立窗口之后，这条判断的语义变了：**它不再改变当前页**。
 *
 * 以前是 toggle（设置页 ↔ 文件页），用户抱怨「进得去出不来」；
 * 现在点设置只开一个子窗口，主窗口停在原地 —— 所以这里要钉住的恰恰是
 * 「无论在哪一页，page 都不变」。写死成切页会让主窗口在开窗的同时跳走。
 */
describe('点设置只开窗口，不切页', () => {
  it('每一页都返回同一个 page（当前页不变）', () => {
    for (const page of PAGES) expect(settingsClickOpensWindow(page).page, page).toBe(page)
  })

  it('每一页都要求开窗口（否则点了没反应）', () => {
    for (const page of PAGES) expect(settingsClickOpensWindow(page).openWindow, page).toBe(true)
  })

  it('设置不再是 Page 的成员（它已经是独立窗口，不该还能切进去）', () => {
    expect(PAGES as readonly string[]).not.toContain('settings')
  })
})

describe('点应用页签去应用页（不是 toggle）', () => {
  it('任何一页点它都落到应用页', () => {
    for (const page of PAGES) expect(pageAfterAppsClick(page), page).toBe('apps')
  })

  it('已在应用页再点一次没有副作用（仍然停在应用页）', () => {
    expect(pageAfterAppsClick('apps')).toBe('apps')
  })
})

describe('页面枚举自身', () => {
  it('PAGES 覆盖 Page 的全部取值（新增一页时遍历型用例自动跟上）', () => {
    const expected: Page[] = ['files', 'overview', 'apps']
    expect([...PAGES].sort()).toEqual([...expected].sort())
  })
})

describe('设置窗口的文案走 i18n', () => {
  it('settings.title 有真文案（未注册的 key 会原样返回）', () => {
    expect(t('settings.title')).not.toBe('settings.title')
    expect(t('settings.title')).toMatch(/[\u4e00-\u9fff]/)
  })
})
