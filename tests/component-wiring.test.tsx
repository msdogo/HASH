import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeviceRail, pickRailData } from '../src/components/DeviceRail'
import { OpDialogHost, pickDialogState, type OpDialogProps } from '../src/components/OpDialog'
import { ContextMenu } from '../src/components/ContextMenu'
import type { OpDialog } from '../src/shared/op-view'
import { menuItemsFor } from '../src/shared/context-menu'
import { errorText, t, tf } from '../src/shared/i18n'
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

/* 删除框样本（后面的 isDestructive / canConfirm 用例也共用，故提到模块作用域）。 */
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

describe('终审 I-5：删除确认框必须渲染出事实（OpDialog + DeleteFacts）', () => {
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

/*
 * 【第 14 次假护栏 / 合并前复审】isDestructive 与 canConfirm 的**组件使用**门禁。
 *
 * 删掉的两条文本断言（expect(dialog).toContain('isDestructive(') / toContain('canConfirm(')）
 * 之所以无牙：两者都被 **import 行**满足 —— 文件顶部
 *   import { canConfirm, isDestructive, type OpDialog } from '@shared/op-view'
 * 就含这两个词。复审实测：组件里的判断改成写死的 false / true，全量 1203 仍全绿。
 *
 * 这里改成「用户看得见的东西」：
 *   - isDestructive → 标题是否红（text-red-600）、确认按钮是否红（bg-red-600）；
 *   - canConfirm   → 确认按钮是否 disabled（count=0 必须禁用，count>0 必须可用）。
 * 任一函数被写死或不再被调用，正反两个方向都会红。
 */
function buttonWithTitle(html: string, title: string): string {
  const tags = html.match(/<button\b[^>]*>/g) ?? []
  const hit = tags.find((tag) => tag.includes('title="' + title + '"'))
  if (hit === undefined) throw new Error('找不到 title=' + title + ' 的按钮：' + html)
  return hit
}

/**
 * 按钮是否真的带 disabled **属性**。
 *
 * 不能用 tag.includes('disabled')：类名里有 disabled:opacity-40（Tailwind 变体），
 * 那会让「有没有禁用」这件事永远为真 —— 又是一条无牙断言。
 * React 对布尔属性渲染成 disabled=""，因此只认这个形态。
 */
function isDisabled(tag: string): boolean {
  return /\sdisabled=""/.test(tag)
}

describe('合并前复审：isDestructive 的渲染效果必须跟着 dialog.kind 走', () => {
  it('删除框：标题红色（text-red-600）+ 确认按钮红色（bg-red-600）', () => {
    const html = dialogHtml(DIALOG)
    // 两处 isDestructive(dialog)（OpDialog.tsx:107 标题 / :196 按钮）都要真的生效
    expect(html).toContain('text-red-600')
    expect(buttonWithTitle(html, t('op.confirm'))).toContain('bg-red-600')
    // 对照组：不是空 HTML
    expect(html).toContain(t('op.delete.title'))
  })

  it('新建文件夹框：标题与按钮都不是红色（isDestructive 写死 true 会在这里红）', () => {
    const html = dialogHtml({ dialog: { kind: 'newFolder', targets: [] } })
    expect(html).not.toContain('text-red-600')
    expect(buttonWithTitle(html, t('op.confirm'))).not.toContain('bg-red-600')
    // 对照组：确实渲染出了新建对话框
    expect(html).toContain(t('op.newFolder.title'))
  })
})

describe('合并前复审：canConfirm 真的决定确认按钮的可用性', () => {
  it('删除可删项 count>0：确认按钮没有 disabled 属性', () => {
    expect(isDisabled(buttonWithTitle(dialogHtml(DIALOG), t('op.confirm')))).toBe(false)
  })

  it('删除 count 为 0（整批被拒）：确认按钮必须 disabled', () => {
    const html = dialogHtml({
      dialog: {
        kind: 'delete',
        targets: ['/sdcard/x.txt'],
        facts: { count: 0, names: [], truncated: false, hasNonEmptyDir: false, blocked: [{ name: '/sdcard/x.txt', ok: false, code: 'E_PROTECTED_PATH' }] },
      },
    })
    expect(isDisabled(buttonWithTitle(html, t('op.confirm')))).toBe(true)
  })
})

/*
 * 【合并前复审 I / J】注入点的**生产路径**门禁。
 *
 * 复审实测两个变异都全量 1203 绿、tsc 0 —— 也就是「生产上设备栏永远空 / 确认框永远不弹」
 * 没有任何用例会红：
 *   - DeviceRail:  props.initial?.devices ?? store.devices  →  props.initial?.devices ?? []
 *   - OpDialogHost: props.initial === undefined ? storeDialog : …  →  ? null : …
 *
 * 为什么不能靠「渲染时不传 initial、先把 store 填满再断言 HTML」：
 * zustand v5 的 useSyncExternalStore 在 SSR 下取 **getServerSnapshot = getInitialState()**，
 * 创建时就被冻结。本工程实测（临时探针，已删除）：create({ n: 'INITIAL' }) 之后
 * setState({ n: 'FILLED' }) 再 renderToStaticMarkup，输出仍是 'INITIAL'。
 * 所以「填 store → 渲染 → 看 HTML」这条路根本走不通，不是没写，是写不出来。
 *
 * 可行且真实的做法：把「这一屏取哪份数据」抽成纯函数（生产代码里组件也在用它），
 * 直接喂两种入参断言返回值。这仍是**生产代码**的判定，不是测试里的仿制品 ——
 * 组件若不再调用它，上面两组渲染用例与下面的返回值断言会一起失守。
 */
/*
 * 【R5 事项 1】结果提示条的**渲染期**门禁。
 *
 * 自动消失的时序（2 秒后 dismiss / 失败不 dismiss / 悬停暂停）在
 * tests/notice-auto-dismiss.test.ts 用假时钟逐条断言（20 条）。
 * 这里补的是另一半：「用户到底看不看得见这句话」，以及失败项列表是否随之渲染。
 * 两者合起来才覆盖完整链路：判断走纯函数，呈现走真组件渲染。
 */
function noticeHtml(failed: number, ok: number): string {
  const failures = Array.from({ length: failed }, (_, index) => ({ name: 'f' + index + '.txt', ok: false, code: 'E_NO_PERMISSION' }))
  return dialogHtml({
    dialog: null,
    lastSummary: { ok, failed, total: ok + failed, failures },
  })
}

describe('【R5-1】结果提示条真的渲染出来（成功 / 失败两副样子）', () => {
  it('全部成功 → 显示「N 项全部成功」', () => {
    const html = noticeHtml(0, 3)
    expect(html).toContain(tf('op.result.allOk', { ok: 3 }))
    expect(html).toContain('data-testid="op-result"')
  })

  it('有失败项 → 显示「N 成功 / M 失败」并逐项列出原因', () => {
    const html = noticeHtml(2, 1)
    expect(html).toContain(tf('op.result.title', { ok: 1, failed: 2 }))
    // 错误码的中文文案必须出现（用户才看得懂为什么失败）
    expect(html).toContain(errorText('E_NO_PERMISSION'))
    // 失败项的名字也必须在
    expect(html).toContain('f0.txt')
    expect(html).toContain('f1.txt')
  })

  it('成功与失败的配色不同（emerald vs red），用户一眼能分出结果', () => {
    expect(noticeHtml(0, 1)).toContain('bg-emerald-50')
    expect(noticeHtml(1, 0)).toContain('bg-red-50')
    // 反向：成功提示不得带失败配色，反之亦然
    expect(noticeHtml(0, 1)).not.toContain('bg-red-50')
    expect(noticeHtml(1, 0)).not.toContain('bg-emerald-50')
  })

  it('提示条上有可点的关闭按钮（手动关闭路径始终存在）', () => {
    for (const html of [noticeHtml(0, 1), noticeHtml(1, 0)]) {
      expect(html).toContain('title="' + t('op.result.dismiss') + '"')
    }
  })

  it('对话框打开时不渲染结果条（同一时刻只显示一个）', () => {
    const html = dialogHtml({
      dialog: { kind: 'newFolder', targets: [] },
      lastSummary: { ok: 3, failed: 0, total: 3, failures: [] },
    })
    expect(html).toContain(t('op.newFolder.title'))
    expect(html).not.toContain('data-testid="op-result"')
  })
})

/*
 * 【R5 事项 2】右键菜单的**渲染期**门禁。
 *
 * 「几项 / 什么顺序」由 tests/context-menu.test.ts 表驱动断言（menuItemsFor）。
 * 这里渲染真组件，断言「用户看到的文字与位置」：
 * 单选三项文案齐全、多选时重命名完全不出现、多选时的两项文案正确、
 * 以及 position: fixed + 视口坐标（left/top 直接来自 clampMenuPosition）。
 *
 * 仍然**没有门禁**的部分（如实登记，见 r5-report.md）：
 *   - 真实右键事件（FileTable 的 onContextMenu 回调、event.preventDefault 是否执行）；
 *   - 点击外部 / Esc / 滚动时的关闭（都在 useEffect 里，SSR 不跑 effect）；
 *   - 菜单项被点击后是否真的调用了 FilesPage 的 handleRename/Delete/Download。
 * 这三块需要 jsdom + 事件派发，本工程刻意不引入（会破坏 tsconfig 的工程划分）。
 */
function menuHtml(selectedCount: number): string {
  return renderToStaticMarkup(React.createElement(ContextMenu, {
    x: 100,
    y: 120,
    items: menuItemsFor(selectedCount),
    onAction: () => undefined,
    onClose: () => undefined,
  }))
}

describe('【R5-2】右键菜单真的渲染出用户裁决的菜单项（渲染期）', () => {
  it('选中 1 项 → 重命名 / 删除 / 下载到本地 三项都在', () => {
    const html = menuHtml(1)
    expect(html).toContain(t('op.toolbar.rename'))
    expect(html).toContain(t('op.toolbar.delete'))
    expect(html).toContain(t('op.toolbar.download'))
    expect(html).toContain('data-testid="file-context-menu"')
  })

  it('选中 2 项 → 只剩删除 / 下载到本地，重命名的文字完全不出现', () => {
    const html = menuHtml(2)
    expect(html).not.toContain(t('op.toolbar.rename'))
    expect(html).toContain(t('op.toolbar.delete'))
    expect(html).toContain(t('op.toolbar.download'))
  })

  it('选中 5 项 → 同样只有两项（数量再大也不加回来）', () => {
    const html = menuHtml(5)
    expect(html).not.toContain(t('op.toolbar.rename'))
    expect(html.match(/role="menuitem"/g)?.length).toBe(2)
  })

  it('菜单项数量与 menuItemsFor 完全一致（渲染不自己增删）', () => {
    for (const count of [1, 2, 5]) {
      expect(menuHtml(count).match(/role="menuitem"/g)?.length, String(count)).toBe(menuItemsFor(count).length)
    }
  })

  it('0 项 → 什么都不渲染（不出现空菜单框）', () => {
    expect(menuHtml(0)).toBe('')
  })

  it('定位走 position: fixed（不是会跟着虚拟列表滚走的 absolute）', () => {
    const html = menuHtml(1)
    // Tailwind 的 fixed 类；反向断言排除 absolute —— 后者会被滚动容器裁掉/错位
    expect(html).toMatch(/class="fixed\b/)
    expect(html).not.toMatch(/class="absolute\b/)
    // left/top 是 px 数值（来自 clampMenuPosition 的返回值）
    expect(html).toMatch(/style="left:\d+px;top:\d+px;width:\d+px"/)
  })

  it('SSR 下没有 window：视口回落成菜单自身尺寸，位置夹到边距（只保证不崩、不出负数）', () => {
    /*
     * 这条如实描述一个**测试环境的边界**：renderToStaticMarkup 里没有 window，
     * ContextMenu 用 box 自身当视口兜底，于是 clampMenuPosition 判「菜单比视口还大」
     * 直接贴边距 —— 所以这里断言的是 8,8 而不是传入的 100,120。
     *
     * 真实浏览器里的定位（放得下原样 / 越界翻转 / 夹取）由
     * tests/context-menu.test.ts 的 clampMenuPosition 表驱动用例覆盖；
     * 「组件把 clampMenuPosition 的结果写进 style」由上面那条正则覆盖。
     * 二者之间的「真实浏览器视口尺寸」这一段没有门禁，已登记进 r5-report.md。
     */
    const html = menuHtml(1)
    expect(html).toContain('left:8px')
    expect(html).toContain('top:8px')
    // 反向：绝不能出现负数或 NaN（那会让菜单整个跑到屏幕外）
    expect(html).not.toContain('left:-')
    expect(html).not.toContain('NaN')
  })

  it('菜单项逐个带 title（悬停可读，与工具条同一套 aria 习惯）', () => {
    const html = menuHtml(1)
    for (const label of [t('op.toolbar.rename'), t('op.toolbar.delete'), t('op.toolbar.download')]) {
      expect(html).toContain('title="' + label + '"')
    }
  })

  it('删除项是危险色（红字），与工具条的删除按钮语义一致', () => {
    const html = menuHtml(1)
    const tags = html.match(/<button\b[^>]*>/g) ?? []
    const removeTag = tags.find((tag) => tag.includes('title="' + t('op.toolbar.delete') + '"'))
    expect(removeTag).toBeDefined()
    expect(removeTag).toContain('text-red-700')
    // 反向：重命名不是红的（否则用户分不出哪个是危险动作）
    const renameTag = tags.find((tag) => tag.includes('title="' + t('op.toolbar.rename') + '"'))
    expect(renameTag).not.toContain('text-red-700')
  })

  it('菜单项都不可禁用（用户裁决是出现/不出现，不是变灰）', () => {
    const html = menuHtml(2)
    const tags = html.match(/<button\b[^>]*>/g) ?? []
    for (const tag of tags) expect(isDisabled(tag)).toBe(false)
  })
})

describe('合并前复审 I/J：initial 为 undefined 时必须原样读 store（生产路径）', () => {
  const storeDevices: DeviceSession[] = [dev({ serial: 'PROD1', model: 'Pixel 8' })]
  const storeSlice = { devices: storeDevices, adb: ADB_OK, activeSerial: 'PROD1', loaded: true }

  it('DeviceRail：不传 initial → 四个字段全部来自 store（引用相等）', () => {
    const picked = pickRailData(undefined, storeSlice)
    expect(picked.devices).toBe(storeDevices)
    expect(picked.adb).toBe(ADB_OK)
    expect(picked.activeSerial).toBe('PROD1')
    expect(picked.loaded).toBe(true)
  })

  it('DeviceRail：只注入部分字段时，其余字段仍读 store（不改注入语义）', () => {
    const injected = [dev({ serial: 'INJ1' })]
    const picked = pickRailData({ devices: injected }, storeSlice)
    expect(picked.devices).toBe(injected)
    expect(picked.adb).toBe(ADB_OK)
  })

  it('OpDialogHost：不传 initial → 原样返回 store 的两份引用（退化成 null 会红）', () => {
    const dialog: OpDialog = { kind: 'delete', targets: [], facts: { count: 1, names: ['x'], truncated: false, hasNonEmptyDir: false, blocked: [] } }
    const store = { dialog, lastSummary: null }
    const picked = pickDialogState(undefined, store)
    expect(picked.dialog).toBe(dialog)
    expect(picked.dialog?.kind).toBe('delete')
    expect(picked.lastSummary).toBe(null)
  })

  it('OpDialogHost：传了 initial={{}} → 显式空（不得偷读 store）', () => {
    const dialog: OpDialog = { kind: 'delete', targets: [] }
    const picked = pickDialogState({}, { dialog, lastSummary: null })
    expect(picked.dialog).toBe(null)
  })
})
