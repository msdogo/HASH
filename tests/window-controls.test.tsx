import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WindowControls, type WindowControlsProps } from '../src/components/WindowControls'
import { t } from '../src/shared/i18n'

/*
 * 自绘顶栏的三个按钮（渲染形态）。
 *
 * 为什么必须有这条门禁：这三个按钮是**唯一**能关窗口的入口 ——
 * 窗口是 frame:false，系统标题栏不存在了。少画一个，用户就只能 Alt+F4。
 * 事件接线本身仍属已知无门禁（没有 jsdom），但「三个按钮都在、
 * 图标随状态换、关闭不带标题」这些都能在渲染结果里断言。
 */

type Initial = NonNullable<WindowControlsProps['initial']>
const Controls = WindowControls as unknown as (props: { initial?: Initial }) => React.ReactElement

function html(over: Initial = {}): string {
  return renderToStaticMarkup(React.createElement(Controls, { initial: over }))
}

describe('窗口按钮', () => {
  it('三个按钮都在（少一个就等于关不掉/动不了窗口）', () => {
    const out = html()
    expect(out).toContain(t('window.minimize'))
    expect(out).toContain(t('window.maximize'))
    expect(out).toContain(t('window.close'))
  })

  it('最大化状态下按钮标题变成「还原」', () => {
    expect(html({ maximized: true })).toContain(t('window.restore'))
    // 未最大化时不该出现「还原」，否则用户会以为窗口已经在最大化状态
    expect(html({ maximized: false })).not.toContain(t('window.restore'))
  })

  /*
   * 关闭按钮是红色的：它与另外两个不是同类操作（那两个只是改变窗口形态，
   * 这个是退出程序）。颜色是唯一的视觉区分手段。
   */
  it('关闭按钮用红色悬停（与最小化/最大化区分开）', () => {
    expect(html()).toContain('hover:bg-red-500')
  })
})
