import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DshApi } from '../src/shared/api-contract'
import type { DragOutFailure, DragOutProgress } from '../src/shared/drag'
import { errorText } from '../src/shared/i18n'

/*
 * dragStore 的**真调用**门禁（与 tests/store-wiring.test.ts 同一手法）。
 *
 * 为什么需要它：拖出这条链上真正发请求的那一步在 store 里
 * （window.api.transfer.beginDragOut）。FilesPage 只是把 store 的 action 接给
 * FileTable 的 props，而组件在没有 jsdom 的工程里观测不到 ——
 * 也就是说「点了会不会真的发请求」只有这两层能压住：store 层（本文件）与流程层
 * （tests/drag-flow.test.ts，但它注入的是假 beginDragOut）。
 * 少了本文件，「store 里那句 window.api 被换成常量」这类改动会全绿。
 */

interface Fake {
  beginDragOut: ReturnType<typeof vi.fn>
  onDragOutProgress: ReturnType<typeof vi.fn>
  onDragOutFailed: ReturnType<typeof vi.fn>
  emitProgress: (payload: DragOutProgress) => void
  emitFailed: (payload: DragOutFailure) => void
  offCalls: () => string[]
  restore: () => void
}

function installFakeApi(over: { beginError?: string } = {}): Fake {
  const progressListeners: Array<(p: DragOutProgress) => void> = []
  const failedListeners: Array<(p: DragOutFailure) => void> = []
  const offCalls: string[] = []

  const beginDragOut = vi.fn(async () => (over.beginError === undefined
    ? { ok: true, data: undefined }
    : { ok: false, error: over.beginError }))
  const onDragOutProgress = vi.fn((callback: (p: DragOutProgress) => void) => {
    progressListeners.push(callback)
    return () => { offCalls.push('progress'); progressListeners.splice(progressListeners.indexOf(callback), 1) }
  })
  const onDragOutFailed = vi.fn((callback: (p: DragOutFailure) => void) => {
    failedListeners.push(callback)
    return () => { offCalls.push('failed'); failedListeners.splice(failedListeners.indexOf(callback), 1) }
  })

  const api = {
    transfer: {
      beginDragOut,
      onDragOutProgress,
      onDragOutFailed,
      getPathForFile: () => '',
    },
  } as unknown as DshApi
  const holder = globalThis as unknown as { window?: { api: DshApi } }
  const previous = holder.window
  holder.window = { api }
  return {
    beginDragOut,
    onDragOutProgress,
    onDragOutFailed,
    emitProgress: (payload) => { for (const listener of [...progressListeners]) listener(payload) },
    emitFailed: (payload) => { for (const listener of [...failedListeners]) listener(payload) },
    offCalls: () => offCalls,
    restore: () => { holder.window = previous },
  }
}

let fake: Fake

beforeEach(() => {
  fake = installFakeApi()
})

afterEach(() => {
  fake.restore()
})

describe('dragStore：拖出真的走到 window.api.transfer.beginDragOut', () => {
  it('dragOut(serial, paths) → beginDragOut 调用一次，入参逐字段正确', async () => {
    const { useDragStore } = await import('../src/store/dragStore')
    useDragStore.setState({ preparing: null, notice: null })

    const code = await useDragStore.getState().dragOut('SERIAL1', ['/sdcard/a.txt', '/sdcard/b.txt'])

    expect(code).toBeNull()
    expect(fake.beginDragOut).toHaveBeenCalledTimes(1)
    expect(fake.beginDragOut).toHaveBeenCalledWith({
      serial: 'SERIAL1',
      paths: ['/sdcard/a.txt', '/sdcard/b.txt'],
    })
    // 结束之后不能停在「正在准备」
    expect(useDragStore.getState().preparing).toBeNull()
  })

  it('空路径 → beginDragOut 零调用（拖空白处不该发请求）', async () => {
    const { useDragStore } = await import('../src/store/dragStore')
    expect(await useDragStore.getState().dragOut('SERIAL1', [])).toBeNull()
    expect(fake.beginDragOut).not.toHaveBeenCalled()
  })

  it('失败 → 返回错误码且提示落地（不是静默）', async () => {
    fake.restore()
    fake = installFakeApi({ beginError: 'E_DEVICE_OFFLINE' })
    const { useDragStore } = await import('../src/store/dragStore')
    useDragStore.setState({ preparing: null, notice: null })

    const code = await useDragStore.getState().dragOut('SERIAL1', ['/sdcard/a.txt'])
    expect(code).toBe('E_DEVICE_OFFLINE')
    expect(useDragStore.getState().notice).toBe(errorText('E_DEVICE_OFFLINE'))
  })

  it('主进程推的进度被写进 preparing（界面「正在准备拖拽（N/M）」的来源）', async () => {
    const { useDragStore } = await import('../src/store/dragStore')
    useDragStore.setState({ preparing: null, notice: null })

    const first = useDragStore.getState().dragOut('SERIAL1', ['/sdcard/a.txt', '/sdcard/b.txt'])
    await Promise.resolve()
    fake.emitProgress({ total: 2, done: 1 })
    expect(useDragStore.getState().preparing).toEqual({ total: 2, done: 1 })
    await first
  })

  it('拖出进行中收到主进程的失败事件 → notice 落地、preparing 收起', async () => {
    const { useDragStore } = await import('../src/store/dragStore')
    useDragStore.setState({ preparing: null, notice: null })

    // 让 beginDragOut 挂起，模拟「正在准备」期间主进程推失败事件
    let release: (value: unknown) => void = () => undefined
    fake.beginDragOut.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))

    const pending = useDragStore.getState().dragOut('SERIAL1', ['/sdcard/a.txt', '/sdcard/b.txt'])
    await Promise.resolve()
    expect(useDragStore.getState().preparing).toEqual({ total: 2, done: 0 })

    fake.emitFailed({ total: 2, done: 1, error: 'E_NO_PERMISSION' })
    expect(useDragStore.getState().notice).toBe(errorText('E_NO_PERMISSION'))
    expect(useDragStore.getState().preparing).toBeNull()

    release({ ok: false, error: 'E_NO_PERMISSION' })
    await pending
    // 已经提示过，不再重复（同一句话弹两次会让界面像出故障）
    expect(useDragStore.getState().notice).toBe(errorText('E_NO_PERMISSION'))
  })

  it('每次拖出各订阅一次、结束即退订（不泄漏监听器）', async () => {
    const { useDragStore } = await import('../src/store/dragStore')
    useDragStore.setState({ preparing: null, notice: null })

    await useDragStore.getState().dragOut('SERIAL1', ['/sdcard/a.txt'])
    expect(fake.onDragOutProgress).toHaveBeenCalledTimes(1)
    expect(fake.onDragOutFailed).toHaveBeenCalledTimes(1)
    expect(fake.offCalls()).toEqual(['progress', 'failed'])

    // 第二次拖出重新订阅：不是复用第一次的旧桥
    await useDragStore.getState().dragOut('SERIAL1', ['/sdcard/b.txt'])
    expect(fake.onDragOutProgress).toHaveBeenCalledTimes(2)
    expect(fake.onDragOutFailed).toHaveBeenCalledTimes(2)
  })
})
