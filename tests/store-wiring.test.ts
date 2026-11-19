import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DshApi } from '../src/shared/api-contract'
import type { FsRemoveFactsData } from '../src/shared/file-ops'
import { E_DEVICE_OFFLINE } from '../src/shared/errors'

/*
 * 【终审 I-1 / 第 9 次假护栏】store 层的**真调用**门禁。
 *
 * 终审实测的变异就在 src/store/opStore.ts:77：把
 *   const result = await window.api.fs.removeFacts({ serial, targets })
 * 换成「一行诱饵注释 + 常量桩」后 tsc exit 0、全量 1164 passed ——
 * 因为唯一守它的断言是读源码文本比位置。
 *
 * 本文件把 window.api 换成假的，直接驱动 store，断言的是「到底有没有真的走到 IPC」：
 * 假 removeFacts 若没被调用，事实就只能是 0，用户的确认框会显示「将删除 0 项」。
 *
 * 工程说明：src/store 不在 tsconfig.node 的 include 里（它是渲染层），
 * 所以本文件与 overview-buttons.test.tsx 一样归 tsconfig.app 管（见两个 tsconfig 的 include/exclude）。
 * 运行环境仍是 node：opStore 只在**调用时**才碰 window.api，import 期不依赖 DOM。
 */

const FACTS: FsRemoveFactsData = {
  count: 3,
  names: ['a.txt', 'b.txt', 'c.txt'],
  truncated: false,
  hasNonEmptyDir: true,
  blocked: [],
}

interface Fake {
  removeFacts: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  enqueue: ReturnType<typeof vi.fn>
  restore: () => void
}

/** 装一个只有本次用到的三件套的假 window.api。 */
function installFakeApi(over: { facts?: FsRemoveFactsData; factsError?: string; enqueueError?: string } = {}): Fake {
  const removeFacts = vi.fn(async () => (over.factsError === undefined
    ? { ok: true, data: over.facts ?? FACTS }
    : { ok: false, error: over.factsError }))
  const remove = vi.fn(async () => ({ ok: true, data: { results: [] } }))
  const enqueue = vi.fn(async () => (over.enqueueError === undefined
    ? { ok: true, data: {} }
    : { ok: false, error: over.enqueueError }))
  const api = { fs: { removeFacts, remove }, transfer: { enqueue } } as unknown as DshApi
  const holder = globalThis as unknown as { window?: { api: DshApi } }
  const previous = holder.window
  holder.window = { api }
  return {
    removeFacts,
    remove,
    enqueue,
    restore: () => {
      holder.window = previous
    },
  }
}

let fake: Fake

beforeEach(() => {
  fake = installFakeApi()
})

afterEach(() => {
  fake.restore()
})

describe('终审 I-1：opStore.prepareDelete 真的去主进程取事实（不是界面猜的）', () => {
  it('成功路径：window.api.fs.removeFacts 被调用一次，确认框拿到主进程给的事实', async () => {
    // 动态 import：保证 window.api 在模块初始化前就位（store 在 create() 里读不到也无妨）
    const { useOpStore } = await import('../src/store/opStore')
    const store = useOpStore.getState()

    const code = await store.prepareDelete('SERIAL1', ['/sdcard/a.txt'])

    expect(code).toBeNull()
    expect(fake.removeFacts).toHaveBeenCalledTimes(1)
    expect(fake.removeFacts).toHaveBeenCalledWith({ serial: 'SERIAL1', targets: ['/sdcard/a.txt'] })
    const dialog = useOpStore.getState().dialog
    expect(dialog?.kind).toBe('delete')
    // 数字必须是主进程给的 3；常量桩会给出 0
    expect(dialog?.facts?.count).toBe(3)
    expect(dialog?.facts?.hasNonEmptyDir).toBe(true)
    // 且**没有**偷偷调 remove（取事实阶段绝不删东西）
    expect(fake.remove).not.toHaveBeenCalled()
  })

  it('失败路径：removeFacts 返回错误时不打开确认框（不允许盲删）', async () => {
    fake.restore()
    fake = installFakeApi({ factsError: E_DEVICE_OFFLINE })
    const { useOpStore } = await import('../src/store/opStore')
    useOpStore.setState({ dialog: null, busy: false, lastSummary: null })

    const code = await useOpStore.getState().prepareDelete('SERIAL1', ['/sdcard/a.txt'])

    expect(code).toBe(E_DEVICE_OFFLINE)
    expect(fake.removeFacts).toHaveBeenCalledTimes(1)
    expect(useOpStore.getState().dialog).toBeNull()
  })
})

describe('终审 I-1 邻接：opStore.download 真的走传输队列', () => {
  it('download 逐项 enqueue，direction 固定 pull，serial / dstDir 正确', async () => {
    const { useOpStore } = await import('../src/store/opStore')
    useOpStore.setState({ dialog: null, busy: false, lastSummary: null })

    const code = await useOpStore.getState().download('SERIAL1', ['/sdcard/a.txt'], 'C:/Downloads')

    expect(code).toBeNull()
    expect(fake.enqueue).toHaveBeenCalledTimes(1)
    expect(fake.enqueue).toHaveBeenCalledWith({
      serial: 'SERIAL1',
      direction: 'pull',
      src: '/sdcard/a.txt',
      dstDir: 'C:/Downloads',
    })
    // 下载完 busy 必须复位（复审 N1 的那次事故）
    expect(useOpStore.getState().busy).toBe(false)
  })

  it('下载**进行中** busy 为 true，且此时确认框打不开（防止同一批文件被操作两遍）', async () => {
    const { useOpStore } = await import('../src/store/opStore')
    useOpStore.setState({ dialog: null, busy: false, lastSummary: null })

    // 挂起 enqueue：在它 resolve 之前观察 busy
    let release: (value: unknown) => void = () => undefined
    fake.enqueue.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))

    const pending = useOpStore.getState().download('SERIAL1', ['/sdcard/a.txt'], 'C:/Downloads')
    await Promise.resolve()
    expect(useOpStore.getState().busy).toBe(true)

    // busy 期间 openConfirm 必须被状态机丢弃（否则用户能重入）
    useOpStore.getState().open({ type: 'openConfirm', kind: 'newFolder', targets: [] })
    expect(useOpStore.getState().dialog).toBeNull()

    release({ ok: true, data: {} })
    await pending
    expect(useOpStore.getState().busy).toBe(false)
    // 复位之后才允许打开对话框
    useOpStore.getState().open({ type: 'openConfirm', kind: 'newFolder', targets: [] })
    expect(useOpStore.getState().dialog?.kind).toBe('newFolder')
  })
})
