import { dangerousConfirmText, isDangerousCommand } from './batch'

/**
 * 批量执行命令的提交路径（规格 §9.6 二次确认）。
 *
 * ===== 为什么单独一个模块 =====
 * 上一轮二次确认整段写在 OverviewPage 的 useCallback 里。复审把那一整段删掉之后
 * **全套 1093 仍全绿** —— 因为组件里的回调既不能被 renderToStaticMarkup 渲染出来，
 * 也没有任何纯函数测试能约束「组件必须弹确认」。
 *
 * 与 batch-flow（四个动作 → 哪个 IPC）、batch-shell（这条命令要不要确认、取消了还跑不跑）
 * 同一手法：把决策收成只依赖注入的纯函数，测试在 node 里直接驱动，
 * 组件只剩「调用它」这一行。
 *
 * 红线：不 import node 内置模块，也不碰 window（confirm 由调用方注入）。
 */

/** 一条批量命令的提交计划（纯函数产出，组件据此渲染 + 决定是否弹确认）。 */
export interface ShellSubmitPlan {
  /** 这条命令算不算危险（规格 §9.6：kill-server / reboot / root 等）。 */
  needsConfirm: boolean
  /** 危险类别（'reboot' 等）；安全命令为空串。 */
  kind: string
  /** 会在几台设备上执行（字符串，直接喂 i18n）。 */
  count: string
  /** 命令原文。 */
  command: string
  /** 影响设备清单（带 serial 尾号，N7）。 */
  devices: string
}

/**
 * 算出这次提交的确认计划。
 *
 * 组件用它同时做两件事：渲染「这条命令需要确认」的提示、以及弹窗时取文案。
 * 两者同源，所以删掉弹窗或删掉提示都会在测试里暴露。
 */
export function planShellSubmit(
  command: string,
  devices: ReadonlyArray<{ serial: string; model?: string }>,
): ShellSubmitPlan {
  const text = dangerousConfirmText(command, devices)
  return {
    needsConfirm: isDangerousCommand(command),
    kind: text.kind,
    count: text.count,
    command: text.command,
    devices: text.devices,
  }
}

/** 提交依赖：确认框 + 真正执行。 */
export interface ShellSubmitDeps {
  /** 弹确认框；返回 true 表示用户点了「执行」。 */
  confirm: (plan: ShellSubmitPlan) => boolean
  /** 真正发起批量执行。 */
  run: (command: string) => void
}

/** 提交结果（给调用方/测试看的判定）。 */
export type ShellSubmitOutcome =
  /** 命令为空：什么都不做。 */
  | 'empty'
  /** 危险命令且用户取消：**不执行**。 */
  | 'cancelled'
  /** 已提交执行（安全命令直接提交，危险命令经确认后提交）。 */
  | 'submitted'

/**
 * 提交一条批量命令。
 *
 * 三条不变量：
 * 1. **空命令不执行**（与按钮禁用一致，双保险）；
 * 2. **危险命令必须先确认，用户取消就绝不执行** —— 这是规格 §9.6 的核心，
 *    也是「删掉确认」必须变红的地方；
 * 3. **安全命令不弹窗**（每次 echo 都弹确认会让用户学会无脑点确定，反而更危险）。
 */
export function submitShell(
  deps: ShellSubmitDeps,
  command: string,
  devices: ReadonlyArray<{ serial: string; model?: string }>,
): ShellSubmitOutcome {
  if (command.trim() === '') return 'empty'
  const plan = planShellSubmit(command, devices)
  if (plan.needsConfirm) {
    if (!deps.confirm(plan)) return 'cancelled'
  }
  deps.run(command)
  return 'submitted'
}

/**
 * 提交依赖：确认框 + 真正执行。
 *
 * 【第 4 轮 N10】run 的入参是**完整载荷**（action + serials + command），
 * 而不是一个命令字符串 —— 这样「batch:shell 请求长什么样」这件事也落在
 * 可测函数里，组件不再自己拼 BatchRequest。
 */
export interface ShellSubmitterDeps {
  /** 弹确认框；返回 true 表示用户点了「执行」。 */
  confirm: (plan: ShellSubmitPlan) => boolean
  /** 真正发起批量执行（载荷就是 BatchRequest 的 shell 分支）。 */
  run: (payload: ShellSubmitPayload) => void
}

/**
 * batch:shell 的完整载荷 —— 与 src/shared/batch.ts 的 BatchRequest 'shell' 分支同形。
 *
 * 它由 buildShellSubmitter 拼出来，组件不再自己拼：这样「传给主进程的请求长什么样」
 * 也落在可测函数里（测试断言 action === 'shell'、serials 逐项相同）。
 */
export interface ShellSubmitPayload {
  action: 'shell'
  serials: string[]
  command: string
}

/** 一次批量命令提交要用的全部状态（组件从自己的 state 里取）。 */
export interface ShellSubmitRequest {
  /** 勾选的 serial（顺序原样传给主进程，结果矩阵按下标回填）。 */
  serials: string[]
  /** 用户输入的命令原文。 */
  command: string
  /** 勾选且仍存在的设备（确认框的影响清单取它）。 */
  devices: ReadonlyArray<{ serial: string; model?: string }>
}

/**
 * 造一个「提交器」：把组件侧那一次调用做成可注入、可行为测试的函数。
 *
 * 【N10 第 3 轮与第 4 轮的区别 —— 这一条必须写清楚】
 * 第 3 轮我把这段做成 makeShellSubmitter(input)，然后在 ui-contract 里加了一句
 * expect(source).toContain('makeShellSubmitter(') 当门禁。复审证明那句话是**假护栏**：
 * 把真调用删掉、只留一行写着这串字符的注释，断言照样绿（37 passed）。
 *
 * 教训：**任何以「源码里出现过某串字符」为判据的断言都不是门禁**，注释即可满足。
 * 所以第 4 轮删掉那条断言，改为让这个函数自己就是被测试的对象 ——
 * tests/overview-shell.test.ts 直接调用它并断言 confirm / run 的调用次数与载荷。
 *
 * 剩下的、确实测不到的一环（组件里 onClick 那一行把 deps 交给它）如实记录为
 * 「靠 code review」：SSR 渲染不出回调，我也不再为它编造断言。
 */
export function buildShellSubmitter(deps: ShellSubmitterDeps): (request: ShellSubmitRequest) => ShellSubmitOutcome {
  return (request) =>
    submitShell(
      {
        confirm: deps.confirm,
        run: (command) => { deps.run({ action: 'shell', serials: request.serials, command }) },
      },
      request.command,
      request.devices,
    )
}

