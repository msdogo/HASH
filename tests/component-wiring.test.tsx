import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeviceRail } from '../src/components/DeviceRail'
import { OpDialogHost, type OpDialogProps } from '../src/components/OpDialog'
import { t, tf } from '../src/shared/i18n'
import type { AdbState, DeviceSession } from '../src/shared/types'

/*
 * 【终审 I-4 / I-5 / 第 12、13 次假护栏】接线层的**渲染期**门禁。
 *
 * 这两条以前都只查源码文本，注释就能满足：
 *   - I-4「设备栏会提示未授权」= expect(rail).toContain('hasUnauthorized')（import 行就满足）
 *   - I-5「删除确认框显示事实」 = expect(dialog).toContain("tf('op.delete.count'")（DeleteFacts 函数体里确有这行，
 *     但调用点整块换成 null 时全绿）
 * 终审实测：把 DeviceRail 的 showUnauthorizedHint 换成 false、把 DeleteFacts 整块不渲染，
 * 全量 1164 passed、tsc exit 0。
 *
 * 现在两个组件都支持「渲染期注入」（与 OverviewPage 的 initial 同一手法，
 * tests/overview-buttons.test.tsx 已证明这条路在本工程可行）：生产不传 → 读 store，
 * 行为逐字不变；测试传值 → 用 renderToStaticMarkup 渲染真组件，断言输出文本。
 * 判据从「源码里有没有这个词」变成「用户看不看得见这句话」。
 */

const ADB_OK: AdbState = { state: 'ok', path: 'C:/platform-tools/adb.exe', version: '1.0.41', source: 'bundled' }

function dev(over: Partial<DeviceSession> & { serial: string }): DeviceSession {
  return {
    serial: over.serial,
    status: over.status ?? 'device',
    transport: over.transport ?? 'usb',
    model: over.model,
    lastSeenAt: 1,
  }
}

function railHtml(devices: DeviceSession[]): string {
  return renderToStaticMarkup(React.createElement(DeviceRail, {
    initial: { devices, adb: ADB_OK, activeSerial: devices[0]?.serial ?? null, loaded: true },
  }))
}

describe('终审 I-4：未授权提示必须真的渲染出来（DeviceRail）', () => {
  const hint = t('devices.unauthorizedHint')

  it('有未授权设备 → 渲染出「请在手机上允许 USB 调试」', () => {
    const html = railHtml([dev({ serial: 'A', status: 'device' }), dev({ serial: 'B', status: 'unauthorized' })])
    expect(html).toContain(hint)
  })

  it('全是已授权设备 → 不渲染该提示（不能永远显示）', () => {
    const html = railHtml([dev({ serial: 'A', status: 'device' }), dev({ serial: 'B', status: 'offline' })])
    expect(html).not.toContain(hint)
  })

  it('设备表为空 → 不渲染该提示', () => {
    expect(railHtml([])).not.toContain(hint)
  })

  it('对照组：设备行本身确实渲染了（防止空 HTML 让上面三条空转）', () => {
    const html = railHtml([dev({ serial: 'A', status: 'unauthorized', model: 'Pixel 7' })])
    expect(html).toContain('Pixel 7')
    expect(html).toContain(t('devices.title'))
    expect(html).toContain(hint)
  })
})

describe('终审 I-5：删除确认框必须渲染出事实（OpDialog + DeleteFacts）', () => {
  const DIALOG: OpDialogProps['initial'] = {
    dialog: {
      kind: 'delete',
      targets: ['/sdcard/a.txt', '/sdcard/dir1', '/sdcard/b.txt'],
      facts: {
        count: 5,
        names: ['a.txt', 'dir1', 'b.txt'],
        truncated: true,
        hasNonEmptyDir: true,
        blocked: [{ name: '/sdcard', ok: false, code: 'E_PROTECTED_PATH' }],
      },
    },
  }

  function dialogHtml(initial: OpDialogProps['initial']): string {
    return renderToStaticMarkup(React.createElement(OpDialogHost, {
      serial: 'TESTSERIAL',
      cwd: '/sdcard',
      onRefresh: () => undefined,
      initial,
    }))
  }

  it('数量来自主进程（「将删除 5 项」）', () => {
    expect(dialogHtml(DIALOG)).toContain(tf('op.delete.count', { count: 5 }))
  })

  it('前 3 个名字逐个出现', () => {
    const html = dialogHtml(DIALOG)
    for (const name of ['a.txt', 'dir1', 'b.txt']) expect(html).toContain(name)
  })

  it('还有更多时显示「另有 N 项未列出」', () => {
    // count 5 - names 3 = 2
    expect(dialogHtml(DIALOG)).toContain(tf('op.delete.more', { rest: 2 }))
  })

  it('有非空文件夹时必须出现那句警报', () => {
    expect(dialogHtml(DIALOG)).toContain(t('op.delete.nonEmpty'))
  })

  it('被安全策略拒绝的项要单独说清楚（用户才知道总数为什么对不上）', () => {
    expect(dialogHtml(DIALOG)).toContain(tf('op.delete.blocked', { count: 1 }))
  })

  it('没有非空目录、没有截断时不出现那两句（提示必须跟着事实走）', () => {
    const html = dialogHtml({
      dialog: {
        kind: 'delete',
        targets: ['/sdcard/x.txt'],
        facts: { count: 1, names: ['x.txt'], truncated: false, hasNonEmptyDir: false, blocked: [] },
      },
    })
    expect(html).toContain(tf('op.delete.count', { count: 1 }))
    expect(html).not.toContain(t('op.delete.nonEmpty'))
    expect(html).not.toContain(tf('op.delete.blocked', { count: 1 }))
  })

  it('对照组：删除按钮与不可恢复警告都在（防止整块被删后仍然通过）', () => {
    const html = dialogHtml(DIALOG)
    expect(html).toContain(t('op.delete.irreversible'))
    expect(html).toContain(t('op.delete.title'))
  })

  it('非删除对话框不显示事实块（防止事实渲染串到别的 kind 上）', () => {
    const html = dialogHtml({ dialog: { kind: 'newFolder', targets: [] } })
    expect(html).not.toContain(tf('op.delete.count', { count: 5 }))
    expect(html).toContain(t('op.newFolder.title'))
  })
})
