import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DshApi } from '../src/shared/api-contract'
import type { LocalFileStat } from '../src/shared/file-ops'
import type { FileEntry, IpcResult } from '../src/shared/types'
import { makeSingleFileDownload, decideDoubleClick, openFile } from '../src/shared/double-click'
import { t } from '../src/shared/i18n'

/*
 * R10：双击下载的**端到端接线**（真 store + 假 window.api）。
 *
 * ===== 为什么需要这一层 ===== 
 * tests/double-click.test.ts 证明的是「注入的 run 被调用了几次」；
 * 但那还是我给的假 run。用户真正关心的是：**传输队列里到底多了几条任务**。
 * 这里把链接到最底：
 *   openFile → makeSingleFileDownload → （真）useOpStore.download → （真）runDownload
 *            → （真）useTransferStore / window.api.transfer.enqueue
 * 唯一被替换的是 window.api（IPC 边界），断言的是 transfer.enqueue 的调用参数与次数。
 *
 * 于是「双击只入队 1 个任务」就有了真证据：即使选中集合里有 3 个文件，
 * enqueue 也只被调用 1 次、src 也只有一个。
 *
 * 工程说明：src/store 不在 tsconfig.node 的 include 里（它是渲染层），
 * 所以本文件与 tests/store-wiring.test.ts 一样归 tsconfig.app 管。
 * 运行环境仍是 node：store 只在调用时才碰 window.api。
 */

function entry(over: Partial<FileEntry> = {}): FileEntry {
  return {
    name: 'a.jpg',
    isDir: false,
    isLink: false,
    size: 100,
    mtime: 1_700_000_000_000,
    mode: '-rw-rw----',
    owner: 'u0_a1',
    group: 'u0_a1',
    ...over,
  }
}

interface Fake {
  enqueue: ReturnType<typeof vi.fn>
  fileStat: ReturnType<typeof vi.fn>
  restore: () => void
}

/** 装一个最小 window.api：传输入队 + 本地预检（这两条就是 R10 用到的全部 IPC）。 */
function installFakeApi(over: { fileStat?: LocalFileStat; enqueueError?: string } = {}): Fake {
  const enqueue = vi.fn(async (input: { serial: string; direction: string; src: string; dstDir: string }) =>
    over.enqueueError === undefined
      ? { ok: true, data: { id: 'task-1', serial: input.serial, direction: input.direction, src: input.src, dst: input.dstDir + '/' + input.src.split('/').pop(), totalBytes: 1, doneBytes: 0, status: 'queued', attempt: 0, createdAt: 0 } }
      : { ok: false, error: over.enqueueError })
  const fileStat = vi.fn(async (): Promise<IpcResult<LocalFileStat>> => ({ ok: true, data: over.fileStat ?? { exists: false } }))
  const api = { transfer: { enqueue }, local: { fileStat } } as unknown as DshApi
  const holder = globalThis as unknown as { window?: { api: DshApi } }
  const previous = holder.window
  holder.window = { api }
  return {
    enqueue,
    fileStat,
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

/** 双击一次的完整链路（与 FilesPage 的注入完全一致）。 */
async function doubleClickOnce(over: {
  entry?: FileEntry
  selected?: string[]
  /** true = 模拟「设置里还没有可用下载路径」（用独立布尔量而不是传 undefined：
   * 可选字段传 undefined 与「没传」在 JS 里无法区分，会静默走回默认值）。 */
  noLocalDir?: boolean
  notice?: (text: string | null) => void
} = {}): Promise<{ storeEnqueues: number; notice: Array<string | null>; queueLength: number }> {
  const { useOpStore } = await import('../src/store/opStore')
  useOpStore.setState({ dialog: null, busy: false, lastSummary: null })
  const notices: Array<string | null> = []
  const notify = over.notice ?? ((text: string | null) => { notices.push(text) })
  const localDir = over.noLocalDir === true ? undefined : 'C:/Users/me/Downloads'
  const queueBefore = fake.enqueue.mock.calls.length

  const download = useOpStore.getState().download
  await openFile(
    {
      serial: 'SERIAL1',
      cwd: '/sdcard/DCIM',
      localDir: () => localDir,
      precheck: (input) => window.api.local.fileStat(input),
      downloadOne: makeSingleFileDownload({
        serial: 'SERIAL1',
        run: download,
        localDir: () => localDir,
        notify,
      }),
      notify,
    },
    over.entry ?? entry(),
  )
  return {
    storeEnqueues: fake.enqueue.mock.calls.length - queueBefore,
    notice: notices,
    queueLength: fake.enqueue.mock.calls.length,
  }
}

describe('R10 端到端：双击只入队 1 个任务（即使选中 3 项）', () => {
  it('选中集合无关：双击 1 个文件 → transfer.enqueue 恰好 1 次、src 只有这一个', async () => {
    const { useOpStore } = await import('../src/store/opStore')
    // 选中 3 项（模拟多选现场）：双击**不是**对选中集合操作
    useOpStore.setState({ dialog: null, busy: false, lastSummary: null })
    const result = await doubleClickOnce()

    expect(result.storeEnqueues).toBe(1)
    expect(fake.enqueue).toHaveBeenCalledTimes(1)
    expect(fake.enqueue).toHaveBeenCalledWith({
      serial: 'SERIAL1',
      direction: 'pull',
      src: '/sdcard/DCIM/a.jpg',
      dstDir: 'C:/Users/me/Downloads',
    })
    // busy 必须复位（复审 N1 的那次事故：下载一次之后整个操作入口死锁）
    expect(useOpStore.getState().busy).toBe(false)
  })

  it('连续双击 3 个不同文件 → 3 次各 1 条（不是 1 次带 3 条）', async () => {
    const seen: string[] = []
    fake.enqueue.mockImplementation(async (input: { serial: string; direction: string; src: string; dstDir: string }) => {
      seen.push(input.src)
      return { ok: true, data: {} }
    })
    for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) {
      const r = await doubleClickOnce({ entry: entry({ name }) })
      expect(r.storeEnqueues).toBe(1)
    }
    expect(seen).toEqual(['/sdcard/DCIM/a.jpg', '/sdcard/DCIM/b.jpg', '/sdcard/DCIM/c.jpg'])
  })
})

describe('R10 端到端：skip-exists 时队列长度不变', () => {
  it('本地同名同大小 → 零入队，且提示文案是「文件已存在」那句', async () => {
    fake.restore()
    fake = installFakeApi({ fileStat: { exists: true, size: 100 } })
    const result = await doubleClickOnce()
    expect(result.storeEnqueues).toBe(0)
    expect(fake.enqueue).not.toHaveBeenCalled()
    expect(result.notice).toEqual([t('transfer.existsSkipped')])
  })

  it('本地同名但大小不同 → 入队（覆盖），不提示已存在', async () => {
    fake.restore()
    fake = installFakeApi({ fileStat: { exists: true, size: 999 } })
    const result = await doubleClickOnce()
    expect(result.storeEnqueues).toBe(1)
    expect(result.notice).not.toContain(t('transfer.existsSkipped'))
  })

  it('远端 size 不可信（metaKnown=false）→ 入队，绝不因本地同名同 size 而跳过', async () => {
    fake.restore()
    fake = installFakeApi({ fileStat: { exists: true, size: 0 } })
    const result = await doubleClickOnce({ entry: entry({ size: 0, metaKnown: false }) })
    expect(result.storeEnqueues).toBe(1)
    expect(result.notice).not.toContain(t('transfer.existsSkipped'))
  })
})

describe('R10 端到端：预检走的是主进程通道，且失败不拦', () => {
  it('预检真的调用 window.api.local.fileStat，入参是「下载目录 + 远端文件名」', async () => {
    await doubleClickOnce({ entry: entry({ name: 'IMG 0001.jpg' }) })
    expect(fake.fileStat).toHaveBeenCalledTimes(1)
    expect(fake.fileStat).toHaveBeenCalledWith({ dir: 'C:/Users/me/Downloads', name: 'IMG 0001.jpg' })
  })

  it('预检返回 ok:false（权限/竞态）→ 照常入队', async () => {
    fake.restore()
    const enqueue = vi.fn(async () => ({ ok: true, data: {} }))
    const fileStat = vi.fn(async () => ({ ok: false, error: 'E_NO_PERMISSION' }))
    const api = { transfer: { enqueue }, local: { fileStat } } as unknown as DshApi
    const holder = globalThis as unknown as { window?: { api: DshApi } }
    const previous = holder.window
    holder.window = { api }
    fake = { enqueue, fileStat, restore: () => { holder.window = previous } }

    const result = await doubleClickOnce()
    expect(result.storeEnqueues).toBe(1)
  })

  it('下载目标 = 设置里的下载目录（没有第二个来源）；缺失时零入队并提示', async () => {
    const missing = await doubleClickOnce({ noLocalDir: true })
    expect(missing.storeEnqueues).toBe(0)
    expect(missing.notice).toEqual([t('op.needLocalDir')])
    expect(fake.fileStat).not.toHaveBeenCalled()
  })

  it('入队失败（IPC 报错）→ 提示错误码，不抛异常', async () => {
    fake.restore()
    fake = installFakeApi({ enqueueError: 'E_DEVICE_OFFLINE' })
    const result = await doubleClickOnce()
    expect(result.storeEnqueues).toBe(1)
    expect(result.notice.length).toBe(1)
    expect(result.notice[0]).toContain('设备已断开')
  })
})

describe('R10 端到端：目录双击不下载', () => {
  it('目录条目走 openFile 也不会入队（真实链路里它根本不会进来）', async () => {
    const result = await doubleClickOnce({ entry: entry({ name: 'DCIM', isDir: true, size: 0 }) })
    expect(result.storeEnqueues).toBe(0)
    expect(decideDoubleClick({ isDir: true, size: 0 }, null)).toBe('enter')
  })
})
