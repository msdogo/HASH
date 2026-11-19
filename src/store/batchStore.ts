import { create } from 'zustand'
import type { BatchActionKind, BatchItemResult, BatchRequest } from '@shared/batch'
import { summarizeBatch } from '@shared/batch'

/**
 * 批量动作的界面状态（任务 10）。
 *
 * 数据来源只有一条：用户点四个按钮之一 → 走 window.api.batch.*。
 * 渲染层不轮询、不猜结果 —— 主进程返回的逐台结果就是唯一的真相。
 *
 * 为什么状态集中在这一个 store：四个动作共用一个「运行中」标志，
 * 分散到组件里就会出现「截图在跑的时候还能点安装」，
 * 而两次批量同时跑会让结果矩阵互相覆盖（用户只能看到最后一次）。
 */

interface BatchState {
  /** 有动作正在跑：按钮必须禁用（简报：避免重复提交）。 */
  running: boolean
  /** 最近一次的结果矩阵（按入参顺序）。null 表示还没有结果。 */
  results: BatchItemResult[] | null
  /**
   * 产生这批结果的动作。
   *
   * 为什么必须记下来：同样的 detail 字段在不同动作里含义完全不同
   * （截图是传输任务 id、推送是文件数、执行命令是 stdout）。没有它，
   * 界面只能把 detail 原样贴出来，用户看到「task-7」根本不知道那是什么。
   */
  action: BatchActionKind | null
  /** 整批级错误码（zod / 会话检查 / 服务抛错）。 */
  error: string | null
  /** 用户取消选择框等「什么都没发生」的提示。 */
  notice: string | null
  /** 运行一个动作；返回错误码或 null。 */
  run: (request: BatchRequest) => Promise<string | null>
  /** 清掉结果与提示。 */
  dismiss: () => void
}

export const useBatchStore = create<BatchState>((set, get) => ({
  running: false,
  results: null,
  action: null,
  error: null,
  notice: null,
  run: async (request) => {
    /*
     * 运行中直接拒绝：两个批量同时跑会让结果矩阵互相覆盖。
     * 这里返回 null 而不是错误码 —— 界面已经把按钮禁用了，
     * 走到这条分支只可能是键盘/竞态，弹一条错误提示反而奇怪。
     */
    if (get().running) return null
    set({ running: true, error: null, notice: null, results: null, action: request.action })
    try {
      const response = await dispatch(request)
      if (!response.ok) {
        set({ running: false, error: response.error })
        return response.error
      }
      /*
       * 空结果 = 用户在选择框上按了取消。
       *
       * 这不是错误，但也不能什么都不发生：界面上要有一条「已取消」的提示，
       * 否则用户会怀疑按钮是不是坏了（点了没反应是最难诊断的一类体验）。
       */
      if (response.data.results.length === 0) {
        set({ running: false, notice: 'batch.pickCancelled' })
        return null
      }
      set({ running: false, results: response.data.results })
      return null
    } catch {
      // preload 层异常（理论上不该发生）：也要让界面脱离 running
      set({ running: false, error: 'E_UNKNOWN' })
      return 'E_UNKNOWN'
    }
  },
  dismiss: () => set({ results: null, action: null, error: null, notice: null }),
}))

/** 把判别联合翻译成一次 IPC 调用（唯一一处 switch，避免四个方法各写一份）。 */
async function dispatch(request: BatchRequest): Promise<
  { ok: true; data: { results: BatchItemResult[] } } | { ok: false; error: string }
> {
  switch (request.action) {
    case 'screenshot':
      return window.api.batch.screenshot({ serials: request.serials })
    case 'install':
      return window.api.batch.install({ serials: request.serials, apkPath: request.apkPath })
    case 'push':
      return window.api.batch.push({ serials: request.serials, files: request.files, dstDir: request.dstDir })
    case 'shell':
      return window.api.batch.shell({ serials: request.serials, command: request.command })
    default:
      return { ok: false, error: 'E_BAD_ARGS' }
  }
}

/**
 * 结果矩阵的一行（已算好，组件不再做判断）。
 *
 * 与 TransferDock 的 dockRows 同一套路：判断留给可单测的纯函数/这里，
 * 组件只负责画。结果行必须能同时表达「成功带附加信息」「失败带错误码」
 * 与「成功但输出被截断」三种状态。
 */
export interface BatchResultRow {
  serial: string
  ok: boolean
  /** 失败错误码；成功时为 undefined。 */
  code?: string
  /** 成功时的附加信息（任务 id / 文件数 / 命令输出摘要）。 */
  detail?: string
  truncated: boolean
}

export function resultRows(results: readonly BatchItemResult[] | null): BatchResultRow[] {
  if (results === null) return []
  return results.map((item) => ({
    serial: item.serial,
    ok: item.ok,
    ...(item.code === undefined ? {} : { code: item.code }),
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    truncated: item.truncated === true,
  }))
}

/** 汇总（「N 成功 / M 失败」），直接复用 shared 的纯函数。 */
export { summarizeBatch }
