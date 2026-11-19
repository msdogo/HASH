import type { BatchActionKind, BatchItemResult, BatchRequest, BatchRunData } from './batch'

/**
 * 批量动作的渲染层流程（任务 10，复审 C1 后从 batchStore 抽出）。
 *
 * 为什么从 store 里搬出来：修前「四个动作分别调到哪个 window.api 方法」这条
 * 唯一的关键接线，是用 ui-contract 里的 expect(source).toContain('window.api.batch.shell(')
 * 兜的 —— 而注释也是源码文本。审查实测：删掉真调用、留一行注释，全套 1063 个用例仍全绿。
 *
 * 与任务 9 的 download-flow 同一手法：把「调 IPC + 落状态」收成只依赖注入的纯函数，
 * 测试就能在 node 里用假 api 驱动完整流程，断言从「源码里有没有这个词」变成
 * 「到底调了哪个方法、带了什么载荷、状态怎么变」。
 *
 * 红线：不 import 任何 node 内置模块，也不碰 window（都由调用方注入）。
 */

/** 一次批量调用的后端（与 DshApi.batch 的四个动作同构）。 */
export interface BatchFlowApi {
  screenshot(input: { serials: string[]; dstDir: string }): Promise<BatchResponse>
  install(input: { serials: string[]; apkPath: string }): Promise<BatchResponse>
  push(input: { serials: string[]; files: string[]; dstDir: string }): Promise<BatchResponse>
  shell(input: { serials: string[]; command: string }): Promise<BatchResponse>
}

/** 与 IpcResult<BatchRunData> 同构；单独写一份是为了能脱离 DOM 类型单测。 */
export type BatchResponse =
  | { ok: true; data: BatchRunData }
  | { ok: false; error: string }

/** 流程结束后的状态（store 直接 set 进去）。 */
export interface BatchFlowState {
  running: boolean
  results: BatchItemResult[] | null
  action: BatchActionKind | null
  error: string | null
  notice: string | null
}

/** 流程依赖：后端 + 状态落地。 */
export interface BatchFlowDeps {
  api: BatchFlowApi
  /** 状态出口（store 传 set；测试传一个数组收集器）。 */
  apply: (state: BatchFlowState) => void
}

/** 运行的初始状态（清掉上一次的结果，避免旧矩阵与新动作混在一起）。 */
export function runningState(action: BatchActionKind): BatchFlowState {
  return { running: true, results: null, action, error: null, notice: null }
}

/**
 * 跑一次批量动作并落状态。
 *
 * 四条不变量（每条都由读者能感知的行为定义）：
 * 1. **四个 action 各自打到对应的后端方法**，载荷逐字段透传 —— 这是 C1 的真判据；
 * 2. **任何出口都要把 running 置回 false**：失败、抛异常、取消都一样，
 *    否则按钮永远禁用（任务 9 的 N1 就是这一类，那次让整个删除入口死锁）；
 * 3. **空结果 = 用户取消选择框**：走 notice（一句提示），不是错误；
 * 4. **抛异常折算成 E_UNKNOWN**：preload 层异常也要让界面脱离 running。
 *
 * @returns 错误码；成功（含取消）返回 null。
 */
export async function runBatchRequest(
  deps: BatchFlowDeps,
  request: BatchRequest,
): Promise<string | null> {
  deps.apply(runningState(request.action))
  try {
    const response = await dispatch(deps.api, request)
    if (!response.ok) {
      deps.apply({ running: false, results: null, action: request.action, error: response.error, notice: null })
      return response.error
    }
    if (response.data.results.length === 0) {
      deps.apply({
        running: false,
        results: null,
        action: request.action,
        error: null,
        notice: 'batch.pickCancelled',
      })
      return null
    }
    deps.apply({
      running: false,
      results: response.data.results,
      action: request.action,
      error: null,
      notice: null,
    })
    return null
  } catch {
    deps.apply({ running: false, results: null, action: request.action, error: 'E_UNKNOWN', notice: null })
    return 'E_UNKNOWN'
  }
}

/** 把判别联合翻译成一次后端调用（唯一一处 switch，避免四个 action 各写一遍）。 */
async function dispatch(api: BatchFlowApi, request: BatchRequest): Promise<BatchResponse> {
  switch (request.action) {
    case 'screenshot':
      return api.screenshot({ serials: request.serials, dstDir: request.dstDir })
    case 'install':
      return api.install({ serials: request.serials, apkPath: request.apkPath })
    case 'push':
      return api.push({ serials: request.serials, files: request.files, dstDir: request.dstDir })
    case 'shell':
      return api.shell({ serials: request.serials, command: request.command })
    default:
      // 判别联合穷尽后不可达；保留是为了让「将来加了 action 忘了写分支」变成编译错误
      return { ok: false, error: 'E_BAD_ARGS' }
  }
}

/**
 * 结果矩阵的一行（已算好，组件不再做判断）。
 *
 * 与 TransferDock 的 dockRows 同一套路：判断留给纯函数，组件只负责画。
 * 一行必须能同时表达「成功带附加信息」「失败带错误码」「成功但输出被截断」。
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
