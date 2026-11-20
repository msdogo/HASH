import { describe, it, expect } from 'vitest'
import { pageAfterSelectDevice, pageAfterSettingsClick, type Page } from '../src/shared/nav'
import { t } from '../src/shared/i18n'

/*
 * R3-1（用户实测缺陷：设置页进得去出不来）的**行为门禁**。
 *
 * 组件的 onClick 在 SSR 下观测不到（工程无 jsdom），所以「点完之后去哪一页」这个
 * **决定**被抽成 src/shared/nav.ts 的纯函数，由这里直接驱动。
 * 「onClick 那一行有没有调它」仍然只能靠 code review —— 已如实登记进
 * progress.md 的「已知无门禁清单」，不造假文本断言。
 */

const PAGES: Page[] = ['files', 'overview', 'settings']

describe('R3-1：点设备必须回到文件页（修前：点了还在设置页）', () => {
  it('在设置页点设备 → 文件页（缺陷本体）', () => {
    expect(pageAfterSelectDevice('settings')).toBe('files')
  })

  it('在任何一页点设备的目标都一致（与当前页无关）', () => {
    // 三个入口逐一代入：写死 'files' 与「按当前页算」在这里都会通过，
    // 但下一组「设置页 → files」会拦住「设置页点设备不动」的那种退化。
    for (const page of PAGES) expect(pageAfterSelectDevice(page), page).toBe('files')
  })

  it('反向自证：设备点击的目标不能是设置页（否则缺陷原样复发）', () => {
    for (const page of PAGES) expect(pageAfterSelectDevice(page), page).not.toBe('settings')
  })
})

describe('R3-1：顶栏「⚙设置」是 toggle（再点一次回到文件页）', () => {
  it('不在设置页 → 进设置页', () => {
    expect(pageAfterSettingsClick('files')).toBe('settings')
    expect(pageAfterSettingsClick('overview')).toBe('settings')
  })

  it('已在设置页 → 回文件页（第三个出口）', () => {
    expect(pageAfterSettingsClick('settings')).toBe('files')
  })

  /*
   * 从文件页 / 设置页出发，连点两次回到出发页（自反）。
   * 从总览页出发不成立：设置页的出口**固定是文件页**（本应用只有 3 页、不做 history 栈），
   * 所以 overview → settings → files。这是规格要求的语义，如实断言，不写成「自反」。
   */
  it('从文件页/设置页连点两次回到出发页（自反）', () => {
    for (const page of ['files', 'settings'] as Page[]) {
      expect(pageAfterSettingsClick(pageAfterSettingsClick(page)), page).toBe(page)
    }
  })

  it('从总览页连点两次落到文件页（设置页的出口固定是文件页，不做 history 栈）', () => {
    expect(pageAfterSettingsClick(pageAfterSettingsClick('overview'))).toBe('files')
  })
})

describe('R3-1：设置页返回按钮的文案走 i18n', () => {
  it('settings.back 有真文案（未注册的 key 会原样返回）', () => {
    expect(t('settings.back')).not.toBe('settings.back')
    expect(t('settings.back')).toMatch(/[\u4e00-\u9fff]/)
  })
})
