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
