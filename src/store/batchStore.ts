import { create } from 'zustand'
import type { BatchActionKind, BatchItemResult, BatchRequest } from '@shared/batch'
import { summarizeBatch } from '@shared/batch'
import { runBatchRequest, type BatchFlowState } from '@shared/batch-flow'

export { resultRows } from '@shared/batch-flow'
export type { BatchResultRow } from '@shared/batch-flow'

/**
 * 批量动作的界面状态（任务 10）。
 *
 * ===== 这一层现在只是「一层壳」=====
 * 真正的流程（四个 action → 哪个 window.api 方法 → 状态怎么落）在
 * src/shared/batch-flow.ts 里，并有 tests/batch-flow.test.ts 用假 api 驱动。
 *
 * 为什么搬出去（复审 C1）：修前这段逻辑直接躺在 store 里，而 store 引用了 window，
 * 测试工程（tsconfig.node，无 DOM）import 不进来 —— 于是「四个动作真的调到后端」
 * 这条唯一的接线只能靠 ui-contract 里一句 toContain 源码文本的断言来兜，
 * 而注释就能满足它。审查实测：删掉真调用、留一行注释，全套 1063 个用例仍全绿。
 *
 * 与任务 9 的 download-flow 是同一手法：流程抽到 shared，store 只负责注入 window.api。
 */

interface BatchState extends BatchFlowState {
  /** 运行一个动作；返回错误码或 null。 */
  run: (request: BatchRequest) => Promise<string | null>
  /** 清掉结果与提示。 */
  dismiss: () => void
}

const INITIAL: BatchFlowState = {
  running: false,
  results: null,
  action: null,
  error: null,
  notice: null,
}

export const useBatchStore = create<BatchState>((set, get) => ({
  ...INITIAL,
  run: async (request: BatchRequest) => {
    /*
     * 运行中直接拒绝：两个批量同时跑会让结果矩阵互相覆盖。
     * 返回 null 而不是错误码 —— 界面已经把按钮禁用了，走到这条分支只可能是
     * 键盘/竞态，弹一条错误提示反而奇怪。
     */
    if (get().running) return null
    return runBatchRequest(
      {
        /*
         * 直接把 window.api.batch 交给流程 —— **刻意不手写四个转发函数**。
         *
         * 复审 C1 的教训：手写的转发层是「可以被注释掉而门禁照样绿」的形状 ——
         * 上一个版本这里就是四行 (input) => window.api.batch.x(input)，
         * 而唯一的守卫是一句匹配源码文本的 toContain，注释就能满足它。
         *
         * 现在这里是**同一个对象引用**：BatchFlowApi 的四个方法签名与
         * DshApi.batch 的前四个完全一致（多出的两个选择框不参与流程，
         * 结构化类型允许额外成员）。于是「删掉这段接线」不再是注释掉四行，
         * 而是整个 api 字段消失 → 编译失败。行为面由 tests/batch-flow.test.ts 覆盖。
         */
        api: window.api.batch,
        apply: (state) => { set(state) },
      },
      request,
    )
  },
  dismiss: () => set({ results: null, action: null, error: null, notice: null }),
}))

/** 结果矩阵里的动作类型（组件显示结果文案时要用）。 */
export type BatchActions = BatchActionKind

/** 结果数组的最小形状（组件只需要读它来判定有没有结果）。 */
export type BatchResults = BatchItemResult[]
