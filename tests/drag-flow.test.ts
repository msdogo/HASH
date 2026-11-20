import { describe, it, expect, vi } from 'vitest'
import { createDragFlow, type DragFlowState } from '../src/shared/drag-flow'
import { E_DEVICE_OFFLINE, E_SYNC_FAILED } from '../src/shared/errors'
import { errorText } from '../src/shared/i18n'
import type { DragOutFailure, DragOutProgress } from '../src/shared/drag'

/*
 * 拖出流程的渲染层状态机（简报 C）。
 *
 * 三条必须钉住的行为：
 *   1. 没有路径时**零调用**（拖空白处不该发请求）；
 *   2. 准备期间状态是 preparing（界面靠它显示「正在准备拖拽（N/M）」）；
 *   3. 失败只提示**一次**（主进程的事件 + invoke 的返回码是两条来源）。
 */

interface Fake {
  flow: ReturnType<typeof createDragFlow>
  states: DragFlowState[]
  notices: Array<string | null>
  beginCalls: Array<{ serial: string; paths: string[] }>
  emitProgress: (payload: DragOutProgress) => void
  emitFailed: (payload: DragOutFailure) => void
  unsubscribed: () => number
}

function fake(result: { ok: true; data: void } | { ok: false; error: string } = { ok: true, data: undefined }): Fake {
  const states: DragFlowState[] = []
  const notices: Array<string | null> = []
  const beginCalls: Array<{ serial: string; paths: string[] }> = []
  const progressListeners: Array<(p: DragOutProgress) => void> = []
  const failedListeners: Array<(p: DragOutFailure) => void> = []
  let unsubCount = 0

  const flow = createDragFlow({
    beginDragOut: async (input) => {
      beginCalls.push({ serial: input.serial, paths: [...input.paths] })
      return result
    },
    onProgress: (callback) => {
      progressListeners.push(callback)
      return () => { unsubCount += 1; progressListeners.splice(progressListeners.indexOf(callback), 1) }
    },
    onFailed: (callback) => {
      failedListeners.push(callback)
      return () => { unsubCount += 1; failedListeners.splice(failedListeners.indexOf(callback), 1) }
    },
    setState: (state) => { states.push(state) },
    notify: (text) => { notices.push(text) },
  })

  return {
    flow,
    states,
    notices,
    beginCalls,
    emitProgress: (payload) => { for (const listener of [...progressListeners]) listener(payload) },
    emitFailed: (payload) => { for (const listener of [...failedListeners]) listener(payload) },
    unsubscribed: () => unsubCount,
  }
}

describe('createDragFlow：入参与调用次数', () => {
  it('有路径 → beginDragOut 收到 serial 与完整路径列表（逐字段）', async () => {
    const f = fake()
    const code = await f.flow.start('SERIAL1', ['/sdcard/a.txt', '/sdcard/b.txt'])
    expect(code).toBeNull()
    expect(f.beginCalls).toEqual([{ serial: 'SERIAL1', paths: ['/sdcard/a.txt', '/sdcard/b.txt'] }])
  })

  it('没有路径 → 零调用（绝不发一条空请求去主进程）', async () => {
    const f = fake()
    expect(await f.flow.start('SERIAL1', [])).toBeNull()
    expect(f.beginCalls).toHaveLength(0)
  })

  it('准备期间状态是 preparing（total = 路径条数），结束后回到 idle', async () => {
    const f = fake()
    await f.flow.start('S', ['/sdcard/a.txt', '/sdcard/b.txt'])
    expect(f.states[0]).toEqual({ phase: 'preparing', total: 2, done: 0 })
    expect(f.states.at(-1)).toEqual({ phase: 'idle' })
  })

  it('主进程推的进度被转成 preparing 状态（界面显示 N/M 的来源）', () => {
    const f = fake()
    f.emitProgress({ total: 5, done: 2 })
    expect(f.states.at(-1)).toEqual({ phase: 'preparing', total: 5, done: 2 })
  })
})

describe('createDragFlow：失败只提示一次', () => {
  it('只有事件、invoke 也返回同一个码 → 只弹一句提示', async () => {
    // 模拟真实顺序：主进程先推失败事件，再让 invoke resolve 成同一个码
    const states: DragFlowState[] = []
    const notices: Array<string | null> = []
    const failedListeners: Array<(p: DragOutFailure) => void> = []
    const flow = createDragFlow({
      beginDragOut: async () => {
        for (const listener of [...failedListeners]) listener({ total: 1, done: 0, error: E_DEVICE_OFFLINE })
        return { ok: false, error: E_DEVICE_OFFLINE }
      },
      onProgress: () => () => undefined,
      onFailed: (callback) => { failedListeners.push(callback); return () => undefined },
      setState: (state) => { states.push(state) },
      notify: (text) => { notices.push(text) },
    })
    const code = await flow.start('S', ['/sdcard/a.txt'])
    expect(code).toBe(E_DEVICE_OFFLINE)
    expect(notices).toEqual([errorText(E_DEVICE_OFFLINE)])
    expect(states.at(-1)).toEqual({ phase: 'idle' })
  })

  it('只有 invoke 返回错误（事件没到）→ 也必须提示，不能静默', async () => {
    const f = fake({ ok: false, error: E_SYNC_FAILED })
    const code = await f.flow.start('S', ['/sdcard/a.txt'])
    expect(code).toBe(E_SYNC_FAILED)
    expect(f.notices).toEqual([errorText(E_SYNC_FAILED)])
    // 失败后状态必须回到 idle（否则界面永远停在「正在准备」）
    expect(f.states.at(-1)).toEqual({ phase: 'idle' })
  })

  it('事件先到时提示用事件里的码；随后的返回码不再重复弹', async () => {
    const states: DragFlowState[] = []
    const notices: Array<string | null> = []
    const failedListeners: Array<(p: DragOutFailure) => void> = []
    const flow = createDragFlow({
      beginDragOut: async () => {
        // 模拟「主进程在 resolve 之前先推了失败事件」
        for (const listener of [...failedListeners]) listener({ total: 1, done: 0, error: E_DEVICE_OFFLINE })
        return { ok: false, error: E_SYNC_FAILED }
      },
      onProgress: () => () => undefined,
      onFailed: (callback) => { failedListeners.push(callback); return () => undefined },
      setState: (state) => { states.push(state) },
      notify: (text) => { notices.push(text) },
    })
    const code = await flow.start('S', ['/sdcard/a.txt'])
    // 返回的是主进程的返回码（调用方据此判断），但提示只出现一次
    expect(code).toBe(E_SYNC_FAILED)
    expect(notices).toEqual([errorText(E_DEVICE_OFFLINE)])
    expect(states.at(-1)).toEqual({ phase: 'idle' })
  })

  it('beginDragOut 抛异常 → 收敛成错误码并提示（不留未捕获 Promise）', async () => {
    const states: DragFlowState[] = []
    const notices: Array<string | null> = []
    const flow = createDragFlow({
      beginDragOut: async () => { throw new Error(E_SYNC_FAILED) },
      onProgress: () => () => undefined,
      onFailed: () => () => undefined,
      setState: (state) => { states.push(state) },
      notify: (text) => { notices.push(text) },
    })
    expect(await flow.start('S', ['/sdcard/a.txt'])).toBe(E_SYNC_FAILED)
    expect(notices).toEqual([errorText(E_SYNC_FAILED)])
    expect(states.at(-1)).toEqual({ phase: 'idle' })
  })

  it('下一次拖拽开始时清掉「已提示过」的标志（否则第二次失败会静默）', async () => {
    const notices: Array<string | null> = []
    const failedListeners: Array<(p: DragOutFailure) => void> = []
    let failNext = false
    let emitOnBegin = false
    const flow = createDragFlow({
      beginDragOut: async () => {
        if (emitOnBegin) {
          for (const listener of [...failedListeners]) listener({ total: 1, done: 0, error: E_SYNC_FAILED })
        }
        return failNext ? { ok: false, error: E_SYNC_FAILED } : { ok: true, data: undefined }
      },
      onProgress: () => () => undefined,
      onFailed: (callback) => { failedListeners.push(callback); return () => undefined },
      setState: () => undefined,
      notify: (text) => { notices.push(text) },
    })
    // 第一次：beginDragOut 内部先推事件，再返回同一个码（双重通知，只能弹一句）
    failNext = true
    emitOnBegin = true
    await flow.start('S', ['/sdcard/a.txt'])
    expect(notices).toHaveLength(1)

    // 第二次：只靠返回码（没有事件）—— 必须仍然提示
    notices.length = 0
    failNext = true
    emitOnBegin = false
    await flow.start('S', ['/sdcard/b.txt'])
    expect(notices).toEqual([errorText(E_SYNC_FAILED)])
  })
})

describe('createDragFlow：dispose', () => {
  it('dispose 退订两个事件（不泄漏监听器）', () => {
    const f = fake()
    f.flow.dispose()
    expect(f.unsubscribed()).toBe(2)
    // 退订之后事件不再影响状态
    const before = f.states.length
    f.emitProgress({ total: 9, done: 1 })
    expect(f.states).toHaveLength(before)
  })
})
