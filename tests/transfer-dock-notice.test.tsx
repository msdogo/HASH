import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TransferDock } from '../src/components/TransferDock'
import { t } from '../src/shared/i18n'

/*
 * R10：提示必须**真的渲染在底部传输栏**（简报明确要求的位置：不是顶部弹窗、不是对话框）。
 *
 * 用真组件 + renderToStaticMarkup（与 tests/component-wiring.test.tsx 同一手法）：
 * 判据是「用户看不看得见这句话」，不是「源码里有没有这个字符串」。
 * TransferDock 支持渲染期注入 notice —— 生产不传就读 store，行为逐字不变。
 */

/**
 * 与本工程 tests/app-nav.test.tsx 的 appHtml 同一手法：
 * 「全部字段可选」的组件在 createElement 的重载解析里会被推成 Attributes，
 * 所以这里显式给出被渲染函数的签名（生产代码不受影响，类型更精确）。
 */
const DOCK = TransferDock as unknown as (props: {
  initial?: { notice?: string | null }
}) => React.ReactElement

function dockHtml(notice: string | null | undefined): string {
  return renderToStaticMarkup(React.createElement(
    DOCK,
    notice === undefined ? {} : { initial: { notice } },
  ))
}

describe('R10：传输底栏显示「文件已存在」提示', () => {
  it('有提示时把那句话渲染出来', () => {
    const text = t('transfer.existsSkipped')
    const html = dockHtml(text)
    expect(html).toContain(text)
  })

  it('i18n 文案本身是「已存在」的语气，不是错误语气', () => {
    const text = t('transfer.existsSkipped')
    expect(text).toBe('文件已存在，未重复下载')
    expect(text).not.toContain('失败')
    expect(text).not.toContain('错误')
    expect(text).not.toContain('无法')
  })

  it('没有提示时什么都不渲染（不能永远挂一行空白）', () => {
    const text = t('transfer.existsSkipped')
    expect(dockHtml(null)).not.toContain(text)
    expect(dockHtml(undefined)).not.toContain(text)
  })

  it('提示区与传输栏主体在同一个 footer 里（位置就在底栏，不是别处浮层）', () => {
    const text = t('transfer.existsSkipped')
    const html = dockHtml(text)
    const footerStart = html.indexOf('<footer')
    const footerEnd = html.indexOf('</footer>')
    expect(footerStart).toBeGreaterThanOrEqual(0)
    expect(footerEnd).toBeGreaterThan(footerStart)
    const footer = html.slice(footerStart, footerEnd)
    expect(footer).toContain(text)
    // 与「传输」标题同处一个容器：这条提示属于传输栏，不是页面别处冒出来的一条
    expect(footer).toContain(t('transfer.title'))
  })

  it('提示用的是中性色（不是错误红）：class 里不含 text-red', () => {
    const text = t('transfer.existsSkipped')
    const html = dockHtml(text)
    const idx = html.indexOf(text)
    // 往回找这条提示所在的那一层 div 的 class
    const before = html.slice(Math.max(0, idx - 400), idx)
    const classIdx = before.lastIndexOf('class="')
    const cls = before.slice(classIdx, classIdx + 200)
    expect(cls).not.toContain('text-red')
  })
})
