import { errorText } from './i18n'
import { toErrorCode } from './errors'
import type { IpcResult } from './types'
import type { DragOutFailure, DragOutProgress, DragOutRequest } from './drag'

/**
 * 拖出流程的【渲染层状态机】（纯逻辑，全部依赖注入）。
 *
 * 为什么要抽这一层：拖出的用户反馈有两条来源 ——
 *   1. invoke 的返回（成功/失败码）；
 *   2. 主进程推送的进度与失败事件（事件与返回值可能先后到达，也可能只有事件）。
 * 「两条来源如何合并成一次提示、状态什么时候回到 idle」是能测的判断，
 * 放在组件里就永远测不到（工程没有 jsdom，DOM 事件观测不到）。
 *
 * 界面契约：下载期间状态是 preparing，界面显示「正在准备拖拽（N/M）」——
 * 用户确认过不设大小门槛，所以大文件一定要看得见这句话，不能像卡死。
 */

/** 界面上的拖拽状态。 */
export type DragFlowState =
  | { phase: 'idle' }
  /** 正在把文件下载到临时目录（done/total 由主进程推送）。 */
  | { phase: 'preparing'; total: number; done: number }

/** 流程依赖（组件/store 负责接 window.api 与 setState）。 */
export interface DragFlowDeps {
  beginDragOut: (input: DragOutRequest) => Promise<IpcResult<void>>
  onProgress: (callback: (payload: DragOutProgress) => void) => () => void
  onFailed: (callback: (payload: DragOutFailure) => void) => () => void
  setState: (state: DragFlowState) => void
  notify: (text: string | null) => void
}

/** 流程句柄。 */
export interface DragFlow {
  /** 发起一次拖出；返回错误码或 null（成功）。没有路径时**不碰主进程**。 */
  start: (serial: string, paths: readonly string[]) => Promise<string | null>
  /** 退订事件（窗口卸载时调）。 */
  dispose: () => void
}

export function createDragFlow(deps: DragFlowDeps): DragFlow {
  /**
   * 同一次失败会有两条通知（主进程的事件 + invoke 的返回码）。
   * 用一个标志合并，保证用户只看到一句提示 —— 两次弹同一句话会让界面像出故障。
   */
  let failedByEvent = false

  const unsubscribeProgress = deps.onProgress((payload) => {
    deps.setState({ phase: 'preparing', total: payload.total, done: payload.done })
  })

  const unsubscribeFailed = deps.onFailed((payload) => {
    failedByEvent = true
    deps.setState({ phase: 'idle' })
    deps.notify(errorText(payload.error))
  })

  const start = async (serial: string, paths: readonly string[]): Promise<string | null> => {
    // 没有路径（比如拖的是文件夹里的空选区）什么都不做：绝不发一条空请求去主进程
    if (paths.length === 0) return null
    failedByEvent = false
    deps.setState({ phase: 'preparing', total: paths.length, done: 0 })
    let result: IpcResult<void>
    try {
      result = await deps.beginDragOut({ serial, paths: [...paths] })
    } catch (err) {
      deps.setState({ phase: 'idle' })
      const code = toErrorCode(err)
      deps.notify(errorText(code))
      return code
    }
    deps.setState({ phase: 'idle' })
    if (result.ok) return null
    // 失败事件已经提示过就不再重复
    if (!failedByEvent) deps.notify(errorText(result.error))
    return result.error
  }

  return {
    start,
    dispose: () => {
      unsubscribeProgress()
      unsubscribeFailed()
    },
  }
}
