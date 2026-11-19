import { describe, it, expect, vi } from 'vitest'
import { makePrepareDelete, type RemoveFactsResult } from '../src/shared/delete-flow'
import { EMPTY_OP_STATE, canConfirm, opReducer, type OpAction, type OpFacts, type OpState } from '../src/shared/op-view'
import { E_DEVICE_OFFLINE, E_UNKNOWN } from '../src/shared/errors'
import type { FsRemoveFactsData } from '../src/shared/file-ops'

/*
 * 【终审 I-1 / 第 9 次假护栏】删除确认链路的行为门禁。
 *
 * 修前守这条的是 tests/ui-contract.test.ts 里的**源码文本位置比较**：
 *   expect(fnBody.indexOf('removeFacts(')).toBeLessThan(fnBody.indexOf("type: 'openConfirm'"))
 * 而注释也是源码文本。终审实测：把 src/store/opStore.ts 里真实的
 * window.api.fs.removeFacts(...) 换成「一行诱饵注释 + 常量桩」，tsc exit 0、
 * 全量 1164 passed —— 而运行时删除确认框会稳定显示「将删除 0 项」，
 * 也就是说裁决 1「不允许盲删」的最后一道落地保障是空的。
 *
 * 现在这段逻辑在 src/shared/delete-flow.ts，依赖全部注入，本文件断言的是**行为**：
 * 调没调、调几次、拿到的事实是不是主进程给的、失败时有没有偷偷开框。
 */

const SERIAL = 'TESTSERIAL'
const TARGETS = ['/sdcard/a.txt', '/sdcard/dir1']

const FACTS: FsRemoveFactsData = {
  count: 7,
  names: ['a.txt', 'dir1', 'b.txt'],
  truncated: true,
  hasNonEmptyDir: true,
  blocked: [{ name: '/sdcard', ok: false, code: 'E_PROTECTED_PATH' }],
}

/** 真状态机接住 openConfirm：断言的是「用户会不会看到一个信息完整的框」。 */
function harness(removeFacts: (input: { serial: string; targets: string[] }) => Promise<RemoveFactsResult>) {
  let state: OpState = { ...EMPTY_OP_STATE }
  const openConfirm = vi.fn((facts: OpFacts, targets: string[]) => {
    state = opReducer(state, { type: 'openConfirm', kind: 'delete', targets, facts } as OpAction)
  })
  const prepareDelete = makePrepareDelete({ removeFacts, openConfirm })
  return {
    prepareDelete,
    openConfirm,
    get state(): OpState { return state },
  }
}

describe('终审 I-1：删除必须先取事实再开确认框（行为断言）', () => {
  it('①成功：openConfirm 恰好一次，且拿到的是主进程给的事实', async () => {
    const removeFacts = vi.fn(async () => ({ ok: true as const, data: FACTS }))
    const h = harness(removeFacts)

    const code = await h.prepareDelete(SERIAL, TARGETS)

    expect(code).toBeNull()
    expect(removeFacts).toHaveBeenCalledTimes(1)
    expect(h.openConfirm).toHaveBeenCalledTimes(1)
    // 事实逐字段透传（不是界面自己数出来的）
    expect(h.openConfirm.mock.calls[0][0]).toEqual({
      count: 7,
      names: ['a.txt', 'dir1', 'b.txt'],
      truncated: true,
      hasNonEmptyDir: true,
      blocked: [{ name: '/sdcard', ok: false, code: 'E_PROTECTED_PATH' }],
    })
    expect(h.openConfirm.mock.calls[0][1]).toEqual(TARGETS)
    // 用户真的能看到那个框，且数字来自主进程
    expect(h.state.dialog?.kind).toBe('delete')
    expect(h.state.dialog?.facts?.count).toBe(7)
    expect(canConfirm(h.state)).toBe(true)
  })

  it('②IPC 失败：openConfirm 零调用，返回主进程给的错误码（不允许盲删）', async () => {
    const removeFacts = vi.fn(async () => ({ ok: false as const, error: E_DEVICE_OFFLINE }))
    const h = harness(removeFacts)

    const code = await h.prepareDelete(SERIAL, TARGETS)

    expect(code).toBe(E_DEVICE_OFFLINE)
    expect(removeFacts).toHaveBeenCalledTimes(1)
    // 核心：拿不到事实就绝不开框 —— 修前这里若被换成常量桩，count 会是 0 而框照开
    expect(h.openConfirm).not.toHaveBeenCalled()
    expect(h.state.dialog).toBeNull()
  })

  it('③抛异常：openConfirm 同样零调用，且异常不外泄（折算成错误码）', async () => {
    const removeFacts = vi.fn(async () => {
      throw new Error(E_DEVICE_OFFLINE)
    })
    const h = harness(removeFacts)

    const code = await h.prepareDelete(SERIAL, TARGETS)

    expect(code).toBe(E_DEVICE_OFFLINE)
    expect(h.openConfirm).not.toHaveBeenCalled()
    expect(h.state.dialog).toBeNull()
  })

  it('③补充：抛出的非错误码异常折算为 E_UNKNOWN（界面永远有话可说）', async () => {
    const h = harness(async () => {
      throw new Error('boom')
    })
    expect(await h.prepareDelete(SERIAL, TARGETS)).toBe(E_UNKNOWN)
    expect(h.openConfirm).not.toHaveBeenCalled()
  })

  it('④removeFacts 的入参逐字节等于调用方入参（serial / targets 不许被改写）', async () => {
    const seen: Array<{ serial: string; targets: string[] }> = []
    const h = harness(async (input) => {
      seen.push(input)
      return { ok: true as const, data: FACTS }
    })

    await h.prepareDelete(SERIAL, TARGETS)

    expect(seen).toEqual([{ serial: SERIAL, targets: TARGETS }])
    // 而且是同一个数组内容（顺序也不能被排序/去重悄悄改掉）
    expect(seen[0].targets).toEqual(['/sdcard/a.txt', '/sdcard/dir1'])
  })

  it('count 为 0 时框照样打开，但确认按钮必须不可用（不误删空清单）', async () => {
    const empty: FsRemoveFactsData = { count: 0, names: [], truncated: false, hasNonEmptyDir: false, blocked: [] }
    const h = harness(async () => ({ ok: true as const, data: empty }))

    expect(await h.prepareDelete(SERIAL, TARGETS)).toBeNull()
    expect(h.openConfirm).toHaveBeenCalledTimes(1)
    expect(canConfirm(h.state)).toBe(false)
  })
})
