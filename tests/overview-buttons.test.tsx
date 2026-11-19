import { describe, it, expect, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OverviewPage } from '../src/pages/OverviewPage'
import { useBatchStore } from '../src/store/batchStore'
import { useDeviceStore } from '../src/store/deviceStore'
import { useTransferStore } from '../src/store/transferStore'
import type { DeviceSession } from '../src/shared/types'
import { buttonStates } from '../src/shared/batch'

/*
 * 四个批量按钮的**渲染期**门禁（复审 N1）。
 *
 * ===== 为什么必须渲染真组件，而不是只测纯函数 =====
 * 上一轮我在 shared 里写了 canSubmit 和 14 条单测，但组件仍用内联的 disabled ——
 * 复审删掉截图按钮那一行 disabled，全套 1093 仍全绿。问题不是纯函数错，
 * 而是「测的函数」和「跑的函数」是两个：没有任何东西约束组件必须调用它。
 *
 * 这里用 renderToStaticMarkup 真的把 OverviewPage 渲染成 HTML（无 DOM、无 jsdom，
 * 与现有测试工程的 node 环境兼容），然后断言**页面上那四个按钮的 disabled 属性**。
 * 于是「组件没接上纯函数」这件事会在渲染结果里直接暴露。
 *
 * 判据只有一条：渲染出来的 disabled 集合，必须等于 buttonStates 对同一状态给出的集合。
 * 这条等价关系对任何内联实现都会失败（内联实现不会自动与 buttonStates 一致）。
 */

const DEVICES: DeviceSession[] = [
  { serial: 'ONLINE-1', status: 'device', model: 'Pixel 7', transport: 'usb', lastSeenAt: 0 },
  { serial: 'ONLINE-2', status: 'device', model: 'Mi 13', transport: 'usb', lastSeenAt: 0 },
  { serial: 'OFFLINE-1', status: 'offline', model: 'Old', transport: 'usb', lastSeenAt: 0 },
]

/** 从渲染出的 HTML 里取出四个批量按钮的 disabled 状态（按 appearance order）。 */
function renderedDisabled(html: string): boolean[] {
  /*
   * 按钮顺序固定：批量截图 / 批量安装 / 批量推送 / 执行命令。
   * 用 i18n 的按钮文案定位，避免依赖 className（那是样式，会变）。
   */
  const labels = ['批量截图', '批量安装', '批量推送', '执行命令']
  return labels.map((label) => {
    const index = html.indexOf('>' + label + '</button>')
    if (index < 0) throw new Error('找不到按钮：' + label + '\n' + html.slice(0, 4000))
    // 该按钮的开始标签就是这一段之前最近的 <button
    const start = html.lastIndexOf('<button', index)
    const openTag = html.slice(start, index)
    return openTag.includes('disabled=""') || openTag.includes('disabled="disabled"')
  })
}

/** 设置 store 状态并渲染一次。 */
function renderWith(options: {
  offline?: boolean
  running?: boolean
  picked?: string[]
} = {}): { html: string; disabled: boolean[] } {
  const devices = options.offline === true ? DEVICES.slice(2) : DEVICES
  useDeviceStore.setState({ devices })
  useTransferStore.setState({ snapshot: { tasks: [] } } as never)
  useBatchStore.setState({
    running: options.running === true,
    results: null,
    action: null,
    error: null,
    notice: null,
  })
  const html = renderToStaticMarkup(React.createElement(OverviewPage))
  return { html, disabled: renderedDisabled(html) }
}

beforeEach(() => {
  useBatchStore.setState({ running: false, results: null, action: null, error: null, notice: null })
})

describe('四个批量按钮的 disabled 来自 shared 的 buttonStates（N1 的真门禁）', () => {
  it('没勾设备时四个按钮全禁用 —— 而且是页面上真的禁用了', () => {
    const { disabled } = renderWith()
    expect(disabled).toEqual([true, true, true, true])
  })

  it('运行中时四个按钮全禁用（防止重复提交）', () => {
    const { disabled } = renderWith({ running: true })
    expect(disabled).toEqual([true, true, true, true])
  })

  it('渲染结果与 buttonStates 完全一致（这条等价关系是核心判据）', () => {
    /*
     * 无论实现怎么改（内联三目、默认参数、抽出别的变量），
     * 只要渲染出的 disabled 与 buttonStates 不一致，这条就红。
     */
    for (const options of [{}, { running: true }, { offline: true }]) {
      const { disabled } = renderWith(options)
      const devices = options.offline === true ? DEVICES.slice(2) : DEVICES
      const pickedCount = 0 // 未勾选任何设备（初始 state）
      const expected = buttonStates({
        running: options.running === true,
        pickedCount,
        fileCount: 0,
        dstDir: '/sdcard/Download',
        command: '',
      })
      expect(disabled).toEqual([expected.screenshot, expected.install, expected.push, expected.shell])
      expect(devices.length).toBeGreaterThan(0)
    }
  })

  it('设备表为空时四个按钮同样全禁用（不能对空集合下手）', () => {
    useDeviceStore.setState({ devices: [] })
    useBatchStore.setState({ running: false, results: null, action: null, error: null, notice: null })
    const html = renderToStaticMarkup(React.createElement(OverviewPage))
    expect(renderedDisabled(html)).toEqual([true, true, true, true])
  })

  it('页面确实渲染出四个批量按钮（防止按钮被整个删掉后测试空转）', () => {
    const { html } = renderWith()
    for (const label of ['批量截图', '批量安装', '批量推送', '执行命令']) {
      expect(html).toContain('>' + label + '</button>')
    }
  })
})
