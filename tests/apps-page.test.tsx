import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppsPage, type AppsPageProps } from '../src/pages/AppsPage'
import { t, tf } from '../src/shared/i18n'
import type { AppDetail, AppEntry } from '../src/shared/apps'

/*
 * 应用管理页的渲染门禁（P1 第二批）。
 *
 * 本工程没有 jsdom：SSR 只跑一次 render、拿不到任何 onClick，
 * 所以这里断言的是**渲染出的形态**（有没有这一列、危险动作是不是标红、
 * 空态说的是哪句话），事件接线如实登记为「已知无门禁」。
 *
 * 为什么这些断言值得写：这几条都是「改坏了界面照样能开、但用户会做错事」的地方 ——
 * 比如卸载按钮不再标红、或者确认框干脆不渲染，用户一点就直接删了。
 */

const APPS: AppEntry[] = [
  { packageName: 'com.tjh.uav.normal', versionCode: 35 },
  { packageName: 'org.nobody.multitts', versionCode: 82 },
]

const DETAIL: AppDetail = {
  packageName: 'com.tjh.uav.normal',
  versionName: '2.1.2.beta3',
  versionCode: 35,
  firstInstallMs: undefined,
  lastUpdateMs: undefined,
  allowClearData: true,
}

/*
 * 组件签名是 AppsPage(props: AppsPageProps = {})，所以 React.ComponentProps 会推出
 * AppsPageProps | undefined。这里直接引用具名类型，避免在测试里把「可选参数」
 * 误当成「必填的 initial」。
 */
type Initial = NonNullable<AppsPageProps['initial']>

/*
 * 组件签名是 AppsPage(props: AppsPageProps = {})，React 的 createElement 重载
 * 会把它当成「props 可选」，于是对象字面量的 initial 不被接受。
 * 与 app-nav / settings-page 等既有 SSR 用例同一手法：显式收窄成「必收 props 的函数」。
 */
const Page = AppsPage as unknown as (props: { initial?: Initial }) => React.ReactElement

function html(over: Initial = {}): string {
  return renderToStaticMarkup(React.createElement(Page, {
    initial: { serial: 'S1', ...over },
  }))
}

describe('应用管理页的渲染形态', () => {
  it('没有设备时给出明确提示（不是空白页）', () => {
    const out = renderToStaticMarkup(React.createElement(Page, {
      initial: { serial: null },
    }))
    expect(out).toContain(t('apps.noDevice'))
  })

  it('有应用时渲染包名与版本号', () => {
    const out = html({ apps: APPS })
    expect(out).toContain('com.tjh.uav.normal')
    expect(out).toContain('org.nobody.multitts')
    expect(out).toContain('35')
    expect(out).toContain('82')
  })

  it('列表为空且不在加载时显示空态文案', () => {
    expect(html({ apps: [], loading: false })).toContain(t('apps.empty'))
  })

  it('加载中且无数据时显示加载文案', () => {
    expect(html({ apps: [], loading: true })).toContain(t('apps.loading'))
  })

  it('展开的详情用版本名而不是 versionCode', () => {
    const out = html({ apps: APPS, detail: DETAIL })
    expect(out).toContain('2.1.2.beta3')
  })

  it('六个动作按钮都以 title 呈现（图标按钮没有文字时也必须可辨认）', () => {
    const out = html({ apps: APPS })
    for (const key of [
      // 规格验收点：拉下来的 APK 要能装回去，所以这个入口必须在页面上
      'apps.action.installApk',
      'apps.action.pullApk',
      'apps.action.launch',
      'apps.action.forceStop',
      'apps.action.clearData',
      'apps.action.uninstall',
    ]) {
      expect(out, key).toContain(t(key))
    }
  })

  /*
   * 安装期间的入口状态。
   *
   * 进度条**不在本页**（它挂在底部日志栏：横跨整宽、切页也不丢，
   * 而本页切走会被卸载）。这里只守一条：安装进行中入口必须置灰，
   * 否则用户连点会叠加出并发安装。
   */
  it('安装进行中入口置灰（防止连点叠加并发安装）', () => {
    const idle = html({ apps: APPS })
    expect(idle).not.toContain('disabled=""')
    const busy = html({
      apps: APPS,
      installing: { serial: 'S1', phase: 'pushing', apkName: 'a.apk', doneBytes: 30, totalBytes: 100, percent: 27 },
    })
    // 安装按钮带着 title 出现，并且是 disabled 的
    const buttonTag = busy.slice(busy.indexOf(t('apps.action.installApk')) - 400, busy.indexOf(t('apps.action.installApk')))
    expect(buttonTag).toContain('disabled')
  })

  it('错误与提示各自渲染在自己的条里（不混成一句）', () => {
    const out = html({ apps: APPS, error: 'E_TIMEOUT-stub', notice: 'notice-stub' })
    expect(out).toContain('notice-stub')
    expect(out).toContain('E_TIMEOUT-stub')
  })
})

describe('危险动作的确认文案', () => {
  it('清数据与卸载的确认文案都点名了具体包名（不能只说「这个应用」）', () => {
    /*
     * 确认框本身在 pending 状态下才渲染，而 pending 是组件内部 state、SSR 无法触发。
     * 所以这里断言的是**文案函数**的产物：它必须带 {packageName} 占位。
     * 「点了直接删」的风险由 needsConfirm（tests/apps.test.ts）与这段文案共同覆盖。
     */
    const clear = tf('apps.confirm.clearData.body', { packageName: 'com.tjh.uav.normal' })
    const uninstall = tf('apps.confirm.uninstall.body', { packageName: 'com.tjh.uav.normal' })
    expect(clear).toContain('com.tjh.uav.normal')
    expect(uninstall).toContain('com.tjh.uav.normal')
    // 两句话必须不同：同一个确认框文案会让用户分不清自己在删什么
    expect(clear).not.toBe(uninstall)
    // 都要明确说「不可撤销」
    expect(clear).toContain('不可撤销')
    expect(uninstall).toContain('不可撤销')
  })
})
