import type { TransferEnqueueInput } from './api-contract'
import { toErrorCode } from './errors'
import { opLabel, type OpItemResult } from './fs-ops'
import { errorText, t } from './i18n'
import { summarizeWithBlocked, type OpAction } from './op-view'

/**
 * 下载流程（裁决 7 的渲染层落点）—— 任务 9，第 2 轮复审 N1 后抽出。
 *
 * 为什么从 opStore 里搬出来：这段逻辑出过一个**只有真跑起来才看得见**的缺陷 ——
 * 置了 busy 却只在失败分支复位，成功下载一次之后 busy 永久为 true，
 * 而 op-view 的 openConfirm 在 busy 时直接丢弃 action（op-view.ts:96），
 * 于是删除/复制/移动/重命名/新建全部点不动，只有重启应用才能恢复。
 *
 * 缺陷能一路滑到复审，根因是 opStore 零测试覆盖：它一句 window.api 调到底，
 * 测试工程（tsconfig.node，无 DOM）根本 import 不进来。
 * 把「调 IPC + 派发 action」收成一个只依赖注入的纯函数，
 * 就能用真状态机（opReducer）在 node 里跑完整流程 ——
 * 断言也就从「有没有调 setBusy」变成用户真正感知的「下载完还能不能继续点」。
 *
 * 红线：不 import 任何 node 内置模块，也不碰 window（都由调用方注入）。
 */

/** 依赖注入：主进程通道 + 状态机派发。 */
export interface DownloadFlowDeps {
  enqueue: (input: TransferEnqueueInput) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>
  dispatch: (action: OpAction) => void
}

/**
 * 逐项把文件加入下载队列。
 *
 * 三条行为约束（每条都由一次真实事故换来的）：
 * 1. **逐项收集，不在第一项失败时中断**（复审 M4）：前面的项确实已经入队了，
 *    若直接 return，界面只弹一个错误码，看起来像整批都没下，用户重试又全撞「目标已存在」；
 * 2. **busy 在任何出口都复位**（复审 N1）：成功、失败、抛异常三条路径都要回到可用状态，
 *    否则整个操作入口死锁；
 * 3. **成功不弹结果框**：界面已有「已加入下载队列」提示与 dock 进度，
 *    再弹一个「N 项全部成功」只是噪音；只有失败才需要交代。
 *
 * 返回值是首个失败码或 null —— 调用点（FilesPage）用它决定要不要提示，
 * 详细分项信息走结果对话框（那才是用户会看的地方）。
 */
export async function runDownload(
  deps: DownloadFlowDeps,
  serial: string,
  sources: readonly string[],
  localDir: string,
): Promise<string | null> {
  deps.dispatch({ type: 'setBusy', busy: true })
  const results: OpItemResult[] = []
  try {
    for (const source of sources) {
      const result = await deps.enqueue({ serial, direction: 'pull', src: source, dstDir: localDir })
      results.push(result.ok
        ? { name: opLabel(source), ok: true }
        : { name: opLabel(source), ok: false, code: result.error })
    }
  } catch (err) {
    results.push({ name: '', ok: false, code: toErrorCode(err) })
  } finally {
    /*
     * finally 里只做「一定不抛」的收尾。
     * 失败走 finish：它同时承担「复位 busy」与「给用户交代」两件事；
     * 成功只需 setBusy(false) —— 但**这一句绝不能省**，省掉就是 N1。
     */
    const firstFailure = results.find((item) => !item.ok)
    if (firstFailure !== undefined) {
      deps.dispatch({ type: 'finish', summary: summarizeWithBlocked(results) })
    } else {
      deps.dispatch({ type: 'setBusy', busy: false })
    }
  }
  const failed = results.find((item) => !item.ok)
  return failed === undefined ? null : (failed.code ?? null)
}

/**
 * 下载入口所需的依赖（终审 I-2，第 10 次假护栏）。
 *
 * 修前「文件页有下载入口」是用 expect(page).toContain('onDownload=') 兜的：
 * 把 FilesPage 的 onDownload 接到空操作后，按钮照样渲染、照样可点，点击毫无反应，
 * 而全量 1164 仍然全绿（正是任务 9 裁决 7 明令禁止的「有队列没界面」）。
 * 源码文本证明不了接线，所以这段判断搬到这里：FilesPage 只注入四样东西，
 * 测试（tests/download-flow.test.ts + tests/react-wiring.test.tsx）断言真实调用。
 */
export interface DownloadHandlerDeps {
  /** 当前设备；null 表示没有选中设备（什么都不做）。 */
  serial: string | null
  /** 真正的下载入口（store 里是 useOpStore.download，内部再走 runDownload）。 */
  run: (serial: string, sources: string[], localDir: string) => Promise<string | null>
  /** 选中项 → 设备上的绝对路径（FilesPage 从 store 现取）。 */
  selectedTargets: () => string[]
  /** 本地目标目录；undefined 表示本地面板还没选目录。 */
  localDir: () => string | undefined
  /** 提示落地（FilesPage 里是 setQueueNotice；文案由 i18n 决定，不在这里拼）。 */
  notify: (text: string | null) => void
}

/**
 * 造一个「下载按钮」的处理器：返回首个失败码或 null。
 *
 * 三条分支各自对应一句必须给用户看的话（没选文件 / 没选本地目录 / 已入队），
 * 且**没有选中项或没有本地目录时绝不调用 run** —— 否则队列里会多出一条
 * src 为空串的任务，用户看到的是「下载中」然后失败。
 */
export function makeDownloadHandler(deps: DownloadHandlerDeps): () => Promise<string | null> {
  return async () => {
    if (deps.serial === null) return null
    const targets = deps.selectedTargets()
    if (targets.length === 0) {
      deps.notify(t('op.noSelection'))
      return null
    }
    const localDir = deps.localDir()
    if (localDir === undefined) {
      deps.notify(t('op.needLocalDir'))
      return null
    }
    const code = await deps.run(deps.serial, targets, localDir)
    if (code !== null) {
      deps.notify(errorText(code))
      return code
    }
    deps.notify(t('op.downloaded'))
    return null
  }
}