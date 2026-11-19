import { describe, it, expect } from 'vitest'
import {
  EMPTY_OP_STATE,
  canConfirm,
  opReducer,
} from '../src/shared/op-view'
import { E_PROTECTED_PATH } from '../src/shared/errors'

/*
 * 文件操作对话框与结果提示的纯状态机（任务 9）。
 *
 * 为什么放 shared：组件里不该有「什么时候能点确认」「确认框要不要显示非空警告」
 * 这类判断 —— 它们正是裁决 1 的安全约束，必须有测试压着。
 */

describe('操作对话框状态机', () => {
  it('初始状态：没有对话框、没有结果', () => {
    expect(EMPTY_OP_STATE.dialog).toBe(null)
    expect(EMPTY_OP_STATE.lastSummary).toBe(null)
  })

  it('打开删除确认框要带上事实（数量 / 前 3 个名字 / 非空标记）', () => {
    const next = opReducer(EMPTY_OP_STATE, {
      type: 'openConfirm',
      kind: 'delete',
      targets: ['/sdcard/Download/a.txt'],
      facts: { count: 5, names: ['a', 'b', 'c'], truncated: true, hasNonEmptyDir: true, blocked: [] },
    })
    expect(next.dialog?.kind).toBe('delete')
    expect(next.dialog?.facts?.count).toBe(5)
    expect(next.dialog?.facts?.hasNonEmptyDir).toBe(true)
  })

  it('删除确认框只在真的看过事实之后才允许确认（防止「没看就删」）', () => {
    const opened = opReducer(EMPTY_OP_STATE, {
      type: 'openConfirm',
      kind: 'delete',
      targets: ['/sdcard/x'],
      facts: { count: 1, names: ['x'], truncated: false, hasNonEmptyDir: false, blocked: [] },
    })
    // facts 齐全 → 可以确认
    expect(canConfirm(opened)).toBe(true)
    // 事实缺失（例如 fs:remove-facts 失败）→ 绝不允许确认
    const noFacts = opReducer(EMPTY_OP_STATE, { type: 'openConfirm', kind: 'delete', targets: ['/sdcard/x'] })
    expect(canConfirm(noFacts)).toBe(false)
  })

  it('所有被拒绝的项都不许确认（没有可删的了）', () => {
    const state = opReducer(EMPTY_OP_STATE, {
      type: 'openConfirm',
      kind: 'delete',
      targets: ['/sdcard'],
      facts: { count: 0, names: [], truncated: false, hasNonEmptyDir: false, blocked: [{ name: 'sdcard', ok: false, code: E_PROTECTED_PATH }] },
    })
    expect(canConfirm(state)).toBe(false)
  })

  it('关闭对话框清空 targets 与 facts（不残留上一次的删除列表）', () => {
    const opened = opReducer(EMPTY_OP_STATE, {
      type: 'openConfirm',
      kind: 'delete',
      targets: ['/sdcard/x'],
      facts: { count: 1, names: ['x'], truncated: false, hasNonEmptyDir: false, blocked: [] },
    })
    const closed = opReducer(opened, { type: 'close' })
    expect(closed.dialog).toBe(null)
  })

  it('提交结果后：对话框关闭，结果按「N 成功 / M 失败」记录', () => {
    const opened = opReducer(EMPTY_OP_STATE, {
      type: 'openConfirm',
      kind: 'delete',
      targets: ['/sdcard/a', '/sdcard/b', '/sdcard/c'],
      facts: { count: 3, names: ['a', 'b', 'c'], truncated: false, hasNonEmptyDir: false, blocked: [] },
    })
    const done = opReducer(opened, {
      type: 'finish',
      summary: { ok: 2, failed: 1, total: 3, failures: [{ name: 'b', ok: false, code: 'E_NO_PERMISSION' }] },
    })
    expect(done.dialog).toBe(null)
    expect(done.lastSummary?.ok).toBe(2)
    expect(done.lastSummary?.failures).toHaveLength(1)
    expect(done.lastSummary?.failures[0].code).toBe('E_NO_PERMISSION')
  })

  it('结果提示可以关闭；关闭后清空（不残留旧失败项）', () => {
    const withSummary = opReducer(EMPTY_OP_STATE, {
      type: 'finish',
      summary: { ok: 1, failed: 1, total: 2, failures: [{ name: 'b', ok: false, code: 'E_X' }] },
    })
    expect(opReducer(withSummary, { type: 'dismissSummary' }).lastSummary).toBe(null)
  })

  it('繁忙时不允许再次打开对话框（避免并发确认）', () => {
    const busy = opReducer(EMPTY_OP_STATE, { type: 'setBusy', busy: true })
    const next = opReducer(busy, {
      type: 'openConfirm',
      kind: 'delete',
      targets: ['/sdcard/x'],
      facts: { count: 1, names: ['x'], truncated: false, hasNonEmptyDir: false, blocked: [] },
    })
    expect(next.dialog).toBe(null)
  })
})

describe('确认框文案要素（裁决 1）', () => {
  it('数量与前 3 个名字来自事实，不是界面自己数的', () => {
    const state = opReducer(EMPTY_OP_STATE, {
      type: 'openConfirm',
      kind: 'delete',
      targets: ['/sdcard/a', '/sdcard/b', '/sdcard/c', '/sdcard/d'],
      facts: { count: 4, names: ['a', 'b', 'c'], truncated: true, hasNonEmptyDir: false, blocked: [] },
    })
    expect(state.dialog?.facts?.count).toBe(4)
    expect(state.dialog?.facts?.names).toHaveLength(3)
    expect(state.dialog?.facts?.truncated).toBe(true)
  })
})

describe('确认按钮的可用性（组件与测试共用同一个 canConfirm）', () => {
  it('新建文件夹不需要选中项：目标目录 + 输入的名字就够了', () => {
    const state = opReducer(EMPTY_OP_STATE, { type: 'openConfirm', kind: 'newFolder', targets: [] })
    expect(canConfirm(state)).toBe(true)
  })

  it('重命名 / 复制 / 移动必须有选中项', () => {
    for (const kind of ['rename', 'copy', 'move'] as const) {
      const empty = opReducer(EMPTY_OP_STATE, { type: 'openConfirm', kind, targets: [] })
      expect(canConfirm(empty), kind).toBe(false)
      const withOne = opReducer(EMPTY_OP_STATE, { type: 'openConfirm', kind, targets: ['/sdcard/a'] })
      expect(canConfirm(withOne), kind).toBe(true)
    }
  })

  it('忙碌时一律不可确认（包括新建）', () => {
    const opened = opReducer(EMPTY_OP_STATE, { type: 'openConfirm', kind: 'newFolder', targets: [] })
    expect(canConfirm(opReducer(opened, { type: 'setBusy', busy: true }))).toBe(false)
  })
})
