/**
 * 「N 项全部成功」提示条要不要自动消失（R5 事项 1）。
 *
 * ===== 用户裁决（已确认，不要自行扩大）=====
 * - 成功（failed === 0）→ ${AUTO_DISMISS_MS} 后自动关闭；
 * - 有失败项 → **永不自动消失**，必须手动点 ✕。
 *   理由：失败信息里有错误码列表，2 秒看不完；自动消失会让人错过原因。
 *
 * ===== 为什么判断必须在这里（shared）而不是组件里 =====
 * 本工程 environment: node、没有 jsdom，SSR（renderToStaticMarkup）只跑 render、**不跑 effect**。
 * 把判断写进 OpDialog 的 useEffect 等于零门禁：改坏也没人红（项目里已有多次先例）。
 * 所以判断（shouldAutoDismiss）与计时器状态机（createAutoDismissTimer）都在这里，
 * 组件只做「创建 + 喂 summary + 悬停转发」三件事。
 *
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块，也不得碰 window。
 */

/** 成功提示自动消失的时长（用户裁决：2 秒）。 */
export const AUTO_DISMISS_MS = 2000

/**
 * 这份结果要不要自动消失：**只有「零失败」才自动消失**。
 *
 * - null（还没有结果）→ false：没有提示条可关，别启动空定时器；
 * - failed > 0（哪怕只失败 1 项）→ false：错误码列表需要用户慢慢看；
 * - failed === 0（含 total 为 0 的「空结果」）→ true：成功提示是纯确认，
 *   留着只会挡住底下的列表。
 *
 * 刻意不看 ok / total：判据就是「有没有失败」这一件事，多一个条件就多一处能写反。
 */
export function shouldAutoDismiss(summary: { failed: number } | null): boolean {
  if (summary === null) return false
  return summary.failed === 0
}

/** 计时器状态：idle（没在计时）/ running（正在走 2 秒）/ paused（鼠标悬停在提示条上）。 */
export type AutoDismissState = 'idle' | 'running' | 'paused'

/**
 * 计时器的外部依赖（全部注入，这样假时钟能在 node 里跑完整流程）。
 *
 * schedule 返回取消函数 —— 与 upload-refresh 的 createTerminalRefreshWatcher 同一手法：
 * 生产传 setTimeout/clearTimeout，测试传一个可控的假时钟。
 */
export interface AutoDismissTimerDeps {
  /** 调度一次延迟回调，返回取消函数（生产 = setTimeout + clearTimeout）。 */
  schedule: (delayMs: number, run: () => void) => () => void
  /** 到点后真正关掉提示条（生产 = opStore.dismissSummary）。 */
  dismiss: () => void
  /** 可覆盖的时长（缺省 AUTO_DISMISS_MS）。 */
  delayMs?: number
}

export interface AutoDismissTimer {
  /** 换了一份结果：重新判断要不要计时（会取消上一个定时器）。 */
  arm: (summary: { failed: number } | null) => void
  /** 鼠标进入提示条：暂停计时（未在计时则无副作用）。 */
  pause: () => void
  /** 鼠标离开提示条：离开后**重新给满**整段时长，而不是接着剩余时间。 */
  resume: () => void
  /** 组件卸载：取消定时器且不再 dismiss（幂等）。 */
  dispose: () => void
  /** 当前状态（测试用；也便于将来做「剩余时间」提示）。 */
  state: () => AutoDismissState
}

/**
 * 把「2 秒后自动关闭 + 悬停暂停」装成一个可注入时钟的状态机。
 *
 * 三条边界（都有用例）：
 * 1. **dispose 之后到点也不能 dismiss** —— 否则组件已卸载还会去改 store
 *    （用户可能已经关掉提示条又做了别的操作）；
 * 2. **pause 只对 running 生效**：还没开始计时时悬停不该凭空造出一个定时器；
 * 3. **resume 重新给满整段**：用户把鼠标挪开时从头数 2 秒 —— 若接着剩余时间算，
 *    「悬停 1.9 秒再挪开」会让提示在 100ms 后消失，等于没暂停。
 */
export function createAutoDismissTimer(deps: AutoDismissTimerDeps): AutoDismissTimer {
  const delayMs = deps.delayMs ?? AUTO_DISMISS_MS
  let state: AutoDismissState = 'idle'
  let cancel: (() => void) | null = null

  const clearPending = (): void => {
    if (cancel !== null) {
      cancel()
      cancel = null
    }
  }

  const start = (): void => {
    // 先取消再排新的：同一时刻只允许有一个定时器，否则连着两份成功结果会 dismiss 两次
    clearPending()
    cancel = deps.schedule(delayMs, () => {
      cancel = null
      state = 'idle'
      deps.dismiss()
    })
    state = 'running'
  }

  return {
    arm: (summary) => {
      if (!shouldAutoDismiss(summary)) {
        // 失败结果：把可能挂着的成功计时撤掉，否则「先成功后失败」会让失败提示被悄悄关掉
        clearPending()
        state = 'idle'
        return
      }
      start()
    },
    pause: () => {
      if (state !== 'running') return
      clearPending()
      state = 'paused'
    },
    resume: () => {
      if (state !== 'paused') return
      start()
    },
    dispose: () => {
      clearPending()
      state = 'idle'
    },
    state: () => state,
  }
}
