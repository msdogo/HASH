import { toErrorCode } from './errors'
import type { FsRemoveFactsData } from './file-ops'
import type { OpFacts } from './op-view'

/**
 * 删除确认链路（裁决 1 在渲染层的落点）：**先取事实，再开确认框**。
 *
 * 为什么从 store 里搬出来（终审 I-1，第 9 次假护栏）：
 * 修前这条唯一的安全接线是用
 *   expect(fnBody.indexOf('removeFacts(')).toBeLessThan(fnBody.indexOf("type: 'openConfirm'"))
 * 兜的 —— 位置比对的对象是源码文本，写一行注释就满足。终审实测：把真实 IPC 调用换成
 * 「注释 + 常量桩」后 tsc exit 0、全量 1164 passed，而删除确认框会稳定显示「将删除 0 项」。
 * 与 batch-flow / download-flow 是同一个教训：把「调 IPC + 派发状态机」收成只依赖注入的
 * 纯函数，测试才能在 node 里真跑流程，判据从「源码里有没有这个词、谁在前」变成
 * 「到底调没调、调了几次、拿了什么」。
 *
 * 四条行为约束（每一条都对应一次真实教训）：
 * 1. **成功**：openConfirm 被调用**恰好一次**，且拿到的是主进程给的事实（不是界面自造）；
 * 2. **IPC 失败**（ok:false）：openConfirm **零调用** —— 宁可什么都不发生，也不弹空框；
 * 3. **抛异常**：同样零调用，且返回错误码（不让异常逃进 React 事件处理器）；
 * 4. removeFacts 的入参逐字节等于调用方给的 { serial, targets }。
 *
 * 红线：不 import 任何 node 内置模块，也不碰 window（都由调用方注入）。
 */

/** 与 IpcResult<FsRemoveFactsData> 同构；单独写一份是为了脱离 DOM 类型单测。 */
export type RemoveFactsResult =
  | { ok: true; data: FsRemoveFactsData }
  | { ok: false; error: string }

/** 取事实并开框所需的依赖。 */
export interface PrepareDeleteDeps {
  /** 主进程 fs:remove-facts 通道（store 里注入 window.api.fs.removeFacts）。 */
  removeFacts: (input: { serial: string; targets: string[] }) => Promise<RemoveFactsResult>
  /** 拿到事实后打开确认框（store 里注入 opReducer 的 openConfirm）。 */
  openConfirm: (facts: OpFacts, targets: string[]) => void
  /** 异常 → 错误码（缺省 toErrorCode；注入仅为可测）。 */
  toCode?: (err: unknown) => string
}

/**
 * 造一个 prepareDelete：返回首个错误码，或 null 表示「已经打开确认框」。
 *
 * 注意 openConfirm 只在这一条路径上被调用 —— 事实拿到之前根本没有第二个出口，
 * 这就是「不允许盲删」在代码结构上的保证，而不是注释里的约定。
 */
export function makePrepareDelete(
  deps: PrepareDeleteDeps,
): (serial: string, targets: string[]) => Promise<string | null> {
  const toCode = deps.toCode ?? toErrorCode
  return async (serial, targets) => {
    let result: RemoveFactsResult
    try {
      result = await deps.removeFacts({ serial, targets })
    } catch (err) {
      return toCode(err)
    }
    if (!result.ok) return result.error
    const data = result.data
    deps.openConfirm(
      {
        count: data.count,
        names: data.names,
        truncated: data.truncated,
        hasNonEmptyDir: data.hasNonEmptyDir,
        blocked: data.blocked,
      },
      targets,
    )
    return null
  }
}
