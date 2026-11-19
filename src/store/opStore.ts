import { create } from 'zustand'
import { opLabel, type OpItemResult } from '@shared/fs-ops'
import type { FsRemoveFactsData } from '@shared/file-ops'
import { EMPTY_OP_STATE, opReducer, summarizeWithBlocked, type OpAction, type OpState } from '@shared/op-view'
import { toErrorCode } from '@shared/errors'

/**
 * 文件操作状态与调用（任务 9）。
 *
 * 设计要点：
 * 1. **状态机在 shared/op-view**（有单测），这里只做「调 IPC + 派发 action」；
 * 2. 每个操作先等结果，再统一 finish —— 界面在任何时刻只有一个「正在跑」的操作，
 *    避免用户连点导致同一批文件被操作两次；
 * 3. 删除**必须先取事实**（removeFacts）再打开确认框：拿不到事实就不打开，
 *    这是裁决 1 的硬约束在渲染层的落点。
 */

/** 逐项结果数据（与主进程 FsOpData 同构）。 */
interface FsOpResult {
  results: OpItemResult[]
}

type OpCall = () => Promise<{ ok: true; data: FsOpResult } | { ok: false; error: string }>

interface OpStoreState extends OpState {
  open: (action: OpAction) => void
  close: () => void
  dismissSummary: () => void
  /** 取删除事实并打开确认框；失败返回错误码且不打开（不允许盲删）。 */
  prepareDelete: (serial: string, targets: string[]) => Promise<string | null>
  remove: (serial: string, targets: string[]) => Promise<void>
  mkdir: (serial: string, dir: string, name: string) => Promise<void>
  rename: (serial: string, from: string, name: string) => Promise<void>
  copy: (serial: string, sources: string[], dstDir: string) => Promise<void>
  move: (serial: string, sources: string[], dstDir: string) => Promise<void>
  /** 下载到本地（走传输队列，裁决 7）。 */
  download: (serial: string, sources: string[], localDir: string) => Promise<string | null>
}

export const useOpStore = create<OpStoreState>((set, get) => {
  /** 统一的「跑一个操作」：置 busy → 调 → finish（成功/失败都收敛成逐项汇总）。 */
  const run = async (call: OpCall): Promise<void> => {
    get().open({ type: 'setBusy', busy: true })
    try {
      const result = await call()
      if (!result.ok) {
        // IPC 层失败（校验/会话/网络）：折算成一项失败，界面照样有话说
        get().open({
          type: 'finish',
          summary: { ok: 0, failed: 1, total: 1, failures: [{ name: '', ok: false, code: result.error }] },
        })
        return
      }
      get().open({ type: 'finish', summary: summarizeWithBlocked(result.data.results) })
    } catch (err) {
      get().open({
        type: 'finish',
        summary: { ok: 0, failed: 1, total: 1, failures: [{ name: '', ok: false, code: toErrorCode(err) }] },
      })
    }
  }

  return {
    ...EMPTY_OP_STATE,
    open: (action) => { set((state) => opReducer(state, action)) },
    close: () => { set((state) => opReducer(state, { type: 'close' })) },
    dismissSummary: () => { set((state) => opReducer(state, { type: 'dismissSummary' })) },

    /**
     * 取删除事实并打开确认框。
     *
     * 顺序不能反：**先取事实，再开框**。反过来的话界面会先弹一个「正在计算…」的空白框，
     * 而那正是用户可能顺手点确认的瞬间 —— 裁决 1 要的「列清单再确认」就落空了。
     */
    prepareDelete: async (serial, targets) => {
      const result = await window.api.fs.removeFacts({ serial, targets })
      if (!result.ok) return result.error
      const facts: FsRemoveFactsData = result.data
      get().open({
        type: 'openConfirm',
        kind: 'delete',
        targets,
        facts: {
          count: facts.count,
          names: facts.names,
          truncated: facts.truncated,
          hasNonEmptyDir: facts.hasNonEmptyDir,
          blocked: facts.blocked,
        },
      })
      return null
    },

    remove: async (serial, targets) => {
      await run(async () => window.api.fs.remove({ serial, targets }))
    },

    mkdir: async (serial, dir, name) => {
      await run(async () => window.api.fs.mkdir({ serial, dir, name }))
    },

    rename: async (serial, from, name) => {
      await run(async () => window.api.fs.rename({ serial, from, name }))
    },

    copy: async (serial, sources, dstDir) => {
      await run(async () => window.api.fs.copy({ serial, sources, dstDir }))
    },

    move: async (serial, sources, dstDir) => {
      await run(async () => window.api.fs.move({ serial, sources, dstDir }))
    },

    /**
     * 下载到本地（裁决 7：任务 8 的队列已有 pull 能力，本任务补界面入口）。
     *
     * 走 transfer.enqueue（**不是** fs.copy —— 跨端传输必须经过队列：
     * 大文件要有进度可取消，而同一设备内的 cp/mv 才允许直接走 shell）。
     */
    download: async (serial, sources, localDir) => {
      /*
       * 【复审 M4】修前这里是「第一项失败就 return」，于是：
       * 前面已经入队的 N-1 项用户完全不知道（它们真的会在队列里跑），
       * 界面只弹一个错误码，看起来像「整批都没下」。用户会重试整批，
       * 结果每一对都变成「目标已存在」。
       *
       * 现在改成逐项收集 + 复用 summarizeWithBlocked：结果对话框与
       * fs.* 的操作结果完全同形（「N 成功 / M 失败」+ 失败项可展开），
       * 用户一眼就能看出哪几个已经进了队列。
       * 返回值仍然是「首个失败码或 null」，这样 FilesPage 的调用点不用改 ——
       * 详细的分项信息走对话框（那是用户真正会看的地方），不是靠一个码去猜。
       */
      get().open({ type: 'setBusy', busy: true })
      const results: OpItemResult[] = []
      try {
        for (const source of sources) {
          const result = await window.api.transfer.enqueue({
            serial,
            direction: 'pull',
            src: source,
            dstDir: localDir,
          })
          results.push(result.ok
            ? { name: opLabel(source), ok: true }
            : { name: opLabel(source), ok: false, code: result.error })
        }
      } catch (err) {
        results.push({ name: '', ok: false, code: toErrorCode(err) })
      }
      const firstFailure = results.find((item) => !item.ok)
      /*
       * 只有**出现失败**时才弹结果框。
       * 全部成功时界面已有既有提示（「已加入下载队列，可在下方查看进度」），
       * 再弹一个「N 项全部成功」纯属噪音 —— 下载成功本来就要用户去 dock 看进度。
       */
      if (firstFailure !== undefined) {
        get().open({ type: 'finish', summary: summarizeWithBlocked(results) })
        return firstFailure.code ?? null
      }
      return null
    },
  }
})
