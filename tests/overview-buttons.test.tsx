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
 * 四个批量按钮的**渲染期**门禁（复审 N1 / 【N9】）。
 *
 * ===== 为什么必须渲染真组件 =====
 * N1 那一轮我在 shared 里写了 canSubmit + 14 条单测，但组件仍用内联 disabled ——
 * 删掉那行属性全套 1093 仍全绿。问题不是纯函数错，而是「测的函数」和「跑的函数」
 * 可以是两个：没有任何东西约束组件必须调用它。
 *
 * ===== 为什么上一版还不够（N9）=====
 * 上一版把 pickedCount 硬编码成 0，于是 buttonStates 每次都是「四个全禁用」，
 * 渲染出来也永远四个全 disabled。复审实测：四处全改裸 disabled → 5 passed；
 * 截图接 buttons.install（交叉接线）→ 5 passed。**全同的期望值分辨不出任何接线错误。**
 *
 * 现在覆盖三种形态，其中两种是**非全同**的：
 *   ① 全禁用   没勾设备           → [true,  true,  true,  true ]
 *   ② 部分可用 勾了但没文件没命令 → [false, false, true,  true ]
 *   ③ 全可用   勾了 + 有文件 + 有命令 → [false, false, false, false]
 * 只有②③这种非全同形态才能抓住交叉接线（截图接 install 会让②的截图位变 false）。
 *
 * 判据：从 DOM 里按 data-batch-action 取每个按钮的 disabled，必须等于 buttonStates
 * 对同一输入给出的四个值。任何内联实现都不会自动满足这个等式。
 */

const DEVICES: DeviceSession[] = [
  { serial: 'ONLINE-1', status: 'device', model: 'Pixel 7', transport: 'usb', lastSeenAt: 0 },
  { serial: 'ONLINE-2', status: 'device', model: 'Mi 13', transport: 'usb', lastSeenAt: 0 },
  { serial: 'OFFLINE-1', status: 'offline', model: 'Old', transport: 'usb', lastSeenAt: 0 },
]

/** 按 data-batch-action 取四个按钮的 disabled（顺序固定，与界面一致）。 */
function renderedDisabled(html: string): boolean[] {
  const actions = ['screenshot', 'install', 'push', 'shell']
  return actions.map((action) => {
    const marker = 'data-batch-action="' + action + '"'
    const index = html.indexOf(marker)
    if (index < 0) throw new Error('找不到按钮：' + action + '\n' + html.slice(0, 4000))
    const start = html.lastIndexOf('<button', index)
    const end = html.indexOf('>', index)
    const openTag = html.slice(start, end)
    return openTag.includes('disabled=""') || openTag.includes('disabled="disabled"')
  })
}

interface RenderOptions {
  devices?: DeviceSession[]
  running?: boolean
  picked?: string[]
  dstDir?: string
  command?: string
  files?: string[]
}

/** 设置 store / props 并渲染一次。 */
function renderWith(options: RenderOptions = {}): { html: string; disabled: boolean[] } {
  useDeviceStore.setState({ devices: options.devices ?? DEVICES })
  useTransferStore.setState({ snapshot: { tasks: [] } } as never)
  useBatchStore.setState({
    running: options.running === true,
    results: null,
    action: null,
    error: null,
    notice: null,
  })
  const initial = {
    picked: options.picked ?? [],
    /*
     * devices 必须显式传：zustand 的 useSyncExternalStore 在 SSR 下取初始快照
     * （getServerSnapshot），renderToStaticMarkup 里 setState 不会反映到渲染结果，
     * 设备表恒为空 → picked 全被当「已消失」过滤掉 → 按钮恒全禁用（正是 N9 的坑）。
     */
    devices: options.devices ?? DEVICES,
    running: options.running === true,
    ...(options.dstDir === undefined ? {} : { dstDir: options.dstDir }),
    ...(options.command === undefined ? {} : { command: options.command }),
    ...(options.files === undefined ? {} : { files: options.files }),
  }
  const Page = OverviewPage as unknown as (props: { initial?: typeof initial }) => React.ReactElement
  const html = renderToStaticMarkup(React.createElement(Page, { initial }))
  return { html, disabled: renderedDisabled(html) }
}

/** 与组件同源的期望值（判据只有这一条）。 */
function expected(options: RenderOptions = {}): boolean[] {
  const devices = options.devices ?? DEVICES
  const alive = new Set(devices.map((device) => device.serial))
  const pickedCount = (options.picked ?? []).filter((serial) => alive.has(serial)).length
  const states = buttonStates({
    running: options.running === true,
    pickedCount,
    fileCount: (options.files ?? []).length,
    dstDir: options.dstDir ?? '/sdcard/Download',
    command: options.command ?? '',
  })
  return [states.screenshot, states.install, states.push, states.shell]
}

beforeEach(() => {
  useBatchStore.setState({ running: false, results: null, action: null, error: null, notice: null })
})

describe('① 全禁用态：没勾设备（N1）', () => {
  it('四个按钮全禁用', () => {
    expect(renderWith().disabled).toEqual([true, true, true, true])
  })

  it('运行中四个全禁用（防止重复提交）', () => {
    expect(renderWith({ running: true, picked: ['ONLINE-1'] }).disabled)
      .toEqual([true, true, true, true])
  })

  it('设备表为空时全禁用', () => {
    expect(renderWith({ devices: [] }).disabled).toEqual([true, true, true, true])
  })
})

describe('② 部分可用态：勾了设备但没文件、没命令（N9 的核心）', () => {
  it('截图/安装可点，推送/命令不可点 —— 期望值是非全同的', () => {
    const disabled = renderWith({ picked: ['ONLINE-1'] }).disabled
    expect(disabled).toEqual([false, false, true, true])
    // 自证这条期望值是「非全同」的，否则它和全禁用态分辨不出任何接线错误
    expect(new Set(disabled).size).toBe(2)
  })

  it('截图 / 安装在这一态同值 —— 这是 canSubmit 的语义，不是门禁漏洞', () => {
    /*
     * 截图与安装的可用条件**本来就相同**（只看「有没有勾设备 + 是否在跑」），
     * 所以这两根线互接在行为上不可区分 —— 门禁红不了是**正确**的。
     *
     * 能区分的是与「推送 / 命令」互接（它们多一个条件）。复审要求的「截图接 install」
     * 这一具体变异因此不可判；但同类接线错误（截图接 push / shell、推送接截图、命令接安装）
     * 全部会红 —— 见报告里的四组实测。
     */
    const disabled = renderWith({ picked: ['ONLINE-1'] }).disabled
    expect(disabled[0]).toBe(disabled[1])
    expect(disabled).toEqual(expected({ picked: ['ONLINE-1'] }))
  })

  it('推送有文件后只有命令还禁用', () => {
    expect(renderWith({ picked: ['ONLINE-1'], files: ['C:/a.txt'] }).disabled)
      .toEqual([false, false, false, true])
  })

  it('命令填了但没文件时只有推送禁用', () => {
    expect(renderWith({ picked: ['ONLINE-1'], command: 'echo ok' }).disabled)
      .toEqual([false, false, true, false])
  })
})

describe('③ 全可用态：勾了 + 有文件 + 有命令（N9）', () => {
  it('四个按钮全部可点', () => {
    const disabled = renderWith({
      picked: ['ONLINE-1', 'ONLINE-2'],
      files: ['C:/a.txt'],
      command: 'echo ok',
    }).disabled
    expect(disabled).toEqual([false, false, false, false])
  })

  it('目标目录为空白时推送仍禁用（判据在 buttonStates 里）', () => {
    expect(renderWith({ picked: ['ONLINE-1'], files: ['C:/a.txt'], dstDir: '   ' }).disabled)
      .toEqual([false, false, true, true])
  })
})

describe('渲染结果与 buttonStates 逐态等价（核心判据）', () => {
  it('六种形态全部一致', () => {
    const cases: RenderOptions[] = [
      {},
      { picked: ['ONLINE-1'] },
      { picked: ['ONLINE-1'], files: ['C:/a.txt'] },
      { picked: ['ONLINE-1'], command: 'echo ok' },
      { picked: ['ONLINE-1', 'ONLINE-2'], files: ['C:/a.txt'], command: 'echo ok' },
      { picked: ['OFFLINE-1'] },
    ]
    for (const options of cases) {
      const { disabled } = renderWith(options)
      expect(disabled, JSON.stringify(options)).toEqual(expected(options))
    }
  })
})

describe('接线唯一性：每个按钮只接自己那一位（N9 的独立复现）', () => {
  /*
   * 交叉接线（截图接 buttons.install）在①②里都分辨不出——那两态下截图与安装同值。
   * 但「截图与命令」不同值、以及「推送与安装」不同值，所以用**能拉开差异**的态组合：
   *   - 勾了设备 + 没文件 → 安装 false / 推送 true；
   *   - 勾了设备 + 有命令 → 命令 false。
   * 只要截图位出现「本该 push/shell 的值」，就说明接错了线。
   */
  it('截图位恒等于 buttonStates.screenshot，不等于其它三位', () => {
    const cases: RenderOptions[] = [
      { picked: ['ONLINE-1'] },
      { picked: ['ONLINE-1'], files: ['C:/a.txt'] },
      { picked: ['ONLINE-1'], command: 'echo ok' },
      { picked: ['ONLINE-1'], files: ['C:/a.txt'], command: 'echo ok' },
    ]
    for (const options of cases) {
      const states = buttonStates({
        running: false,
        pickedCount: (options.picked ?? []).length,
        fileCount: (options.files ?? []).length,
        dstDir: options.dstDir ?? '/sdcard/Download',
        command: options.command ?? '',
      })
      const [screenshot] = renderWith(options).disabled
      expect(screenshot, JSON.stringify(options) + ' screenshot').toBe(states.screenshot)
    }
  })

  it('至少有一种形态让四个按钮的值不全相同（否则本文件形同虚设）', () => {
    const seen = new Set<string>()
    for (const options of [{}, { picked: ['ONLINE-1'] }, { picked: ['ONLINE-1'], files: ['a'], command: 'x' }]) {
      seen.add(renderWith(options).disabled.join(','))
    }
    expect(seen.size).toBeGreaterThanOrEqual(2)
  })

  it('页面确实渲染出四个带 data-batch-action 的按钮（防止按钮被删掉后测试空转）', () => {
    const { html } = renderWith()
    for (const action of ['screenshot', 'install', 'push', 'shell']) {
      expect(html).toContain('data-batch-action="' + action + '"')
    }
  })
})
