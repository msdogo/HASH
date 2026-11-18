import type { AdbState } from '../../src/shared/types'

/**
 * 启动顺序（审查轮 1 / I7、I5）。
 *
 * 为什么要单独抽出来：原来这段逻辑写在 main.ts 的 whenReady 回调里，既有
 * 「注释说的顺序与代码顺序相反」（I7），也有「await probe() 期间退出会留孤儿」
 * 的问题（I5）。抽成纯函数后：
 * - 顺序由代码本身保证，且有断言锁住（tests/boot.test.ts）；
 * - probe 接收 AbortSignal，before-quit 一 abort 就能立刻收尾，不再等自检跑完。
 */

export interface BootDeps {
  installCsp: () => void
  registerHandlers: () => void
  createWindow: () => void | Promise<void>
  /** 自检 adb。必须尊重 signal：被 abort 后应尽快返回。 */
  probeAdb: (signal: AbortSignal) => Promise<AdbState>
  startTracking: () => void
  /** 让界面脱离 checking（自检结果可能比窗口晚到）。 */
  notifyAdbState: () => void
  onAdbError: (code: string) => void
}

/**
 * 返回一个可等待的启动序列。
 *
 * 严格顺序：CSP → 注册 IPC → 建窗口 → 自检 adb → 起 tracker → 通知 adb 状态。
 *
 * 关键约束：
 * - **注册 IPC 必须早于建窗口**。窗口一出现，渲染层立刻会 invoke devices:list，
 *   那一刻 handler 必须在位，否则就是 "No handler registered for channel"。
 *   （修前的代码顺序恰好相反，只因两者在同一 tick 无间隙才没出事 —— 一旦中间插
 *   一个 await 就会立刻炸，所以现在把顺序写死并用测试锁住。）
 * - 自检失败也要起 tracker（它会降级轮询），用户至少看到「无设备」而不是一直转圈。
 * - 调用方 abort（退出）时，自检之后的步骤全部跳过。
 */
export function createBootSequence(deps: BootDeps, signal?: AbortSignal): () => Promise<void> {
  /*
   * 用函数读 aborted 而不是直接写 `signal?.aborted === true`：
   * TS 会把第一次检查的结果收窄成 false，于是后续同样的比较被判定为
   * 「没有重叠」而报 TS2367 —— 而这两次检查之间的 await 恰恰可能改变它的值。
   * 包一层函数既绕过错误的收窄，也让「每次都是重新读取」这个语义显式化。
   */
  const aborted = (): boolean => signal?.aborted === true

  return async () => {
    if (aborted()) return

    deps.installCsp()
    // 先注册 IPC，再建窗口（顺序不可调换，见上方注释）
    deps.registerHandlers()
    await deps.createWindow()

    if (aborted()) return
    const adbState = await deps.probeAdb(signal ?? new AbortController().signal)
    if (aborted()) return

    deps.startTracking()
    deps.notifyAdbState()
    if (adbState.state === 'error') deps.onAdbError(adbState.code)
  }
}