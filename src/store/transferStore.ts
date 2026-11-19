import { create } from 'zustand'
import type { TransferSnapshot, TransferTask } from '@shared/transfer'
import { sameSnapshot } from '@shared/transfer-view'

/**
 * 传输队列状态（任务 8 的渲染层）。
 *
 * 数据来源只有两条，与 deviceStore 同构：
 * 1. 启动时 window.api.transfer.list() 拿首屏（迟到的订阅者靠它自愈）；
 * 2. window.api.transfer.onChanged 推送（主进程已按 ≥100ms/≥1% 节流）。
 * 渲染层绝不自己轮询 —— 进度轮询在主进程，渲染层只被动接收。
 */

interface TransferState {
  snapshot: TransferSnapshot
  /** 已加载过至少一次（区分「还没拉到」与「真的空队列」）。 */
  loaded: boolean
  setSnapshot: (snapshot: TransferSnapshot) => void
  /** 入队；返回错误码或 null（成功）。 */
  enqueue: (input: { serial: string; direction: 'push' | 'pull'; src: string; dstDir: string }) => Promise<string | null>
  cancel: (id: string) => Promise<string | null>
  retry: (id: string) => Promise<string | null>
  clearFinished: () => Promise<string | null>
}

const EMPTY: TransferSnapshot = { tasks: [], running: 0, queued: 0 }

export const useTransferStore = create<TransferState>((set, get) => ({
  snapshot: EMPTY,
  loaded: false,
  setSnapshot: (snapshot) => {
    // 整份快照推送：内容相同就保持原引用，避免无意义的整页重渲染
    if (sameSnapshot(get().snapshot, snapshot)) {
      if (!get().loaded) set({ loaded: true })
      return
    }
    set({ snapshot, loaded: true })
  },
  enqueue: async (input) => {
    const result = await window.api.transfer.enqueue(input)
    if (!result.ok) return result.error
    // 入队成功后不等推送，直接把任务并进本地快照：用户点了「上传」要立刻看到行
    const current = get().snapshot
    const tasks: TransferTask[] = [...current.tasks, result.data]
    set({
      snapshot: {
        tasks,
        running: tasks.filter((t) => t.status === 'running').length,
        queued: tasks.filter((t) => t.status === 'queued').length,
      },
      loaded: true,
    })
    return null
  },
  cancel: async (id) => {
    const result = await window.api.transfer.cancel({ id })
    return result.ok ? null : result.error
  },
  retry: async (id) => {
    const result = await window.api.transfer.retry({ id })
    return result.ok ? null : result.error
  },
  clearFinished: async () => {
    const result = await window.api.transfer.clear()
    if (!result.ok) return result.error
    set({ snapshot: result.data, loaded: true })
    return null
  },
}))

/**
 * 订阅传输推送并返回退订函数。
 * 与 subscribeDeviceChanges 一样在 main.tsx 挂一次，避免 StrictMode 双挂。
 * 顺序：先订阅、再拉首屏 —— 反了会丢掉「订阅建立到首屏返回之间」的变化。
 */
export function subscribeTransferChanges(): () => void {
  const { setSnapshot } = useTransferStore.getState()
  const unsubscribe = window.api.transfer.onChanged((snapshot) => { setSnapshot(snapshot) })
  void window.api.transfer.list().then((result) => {
    if (result.ok) setSnapshot(result.data)
  })
  return unsubscribe
}
