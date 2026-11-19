import type { OpItemResult, OpSummary } from './fs-ops'

/**
 * 文件操作对话框与结果提示的纯状态机（任务 9）。
 *
 * 为什么放 shared 而不写在组件里：这里藏着裁决 1 的**安全约束** ——
 * 「没看到删除事实就不许确认」「被拒绝的项不算进可删数量」。
 * 这类判断必须有测试压着，而测试工程 import 不了组件目录。
 *
 * 红线：不得 import 任何 node 内置模块（渲染层要编译它）。
 */

/** 确认框需要的事实（与主进程 FsRemoveFactsData 同构）。 */
export interface OpFacts {
  count: number
  names: string[]
  truncated: boolean
  hasNonEmptyDir: boolean
  /** 被安全策略拒绝的项（受保护路径 / 非法路径 / 不存在）。 */
  blocked: OpItemResult[]
}

/** 对话框种类。 */
export type OpDialogKind = 'delete' | 'copy' | 'move' | 'newFolder' | 'rename'

/** 当前打开的对话框。 */
export interface OpDialog {
  kind: OpDialogKind
  /** 参与本次操作的完整路径（删除/复制/移动是多项；新建/改名由输入框给名字）。 */
  targets: string[]
  /** 删除专用：必须在打开对话框之前由主进程算好。缺省表示「还没拿到」。 */
  facts?: OpFacts
}

/** 操作状态（每个设备一份，随 fileStore 分片一起存）。 */
export interface OpState {
  dialog: OpDialog | null
  /** 正在执行（禁止重复提交）。 */
  busy: boolean
  /** 最近一次操作的「N 成功 / M 失败」；用户可关闭。 */
  lastSummary: OpSummary | null
}

export const EMPTY_OP_STATE: OpState = { dialog: null, busy: false, lastSummary: null }

export type OpAction =
  | { type: 'openConfirm'; kind: OpDialogKind; targets: string[]; facts?: OpFacts }
  | { type: 'close' }
  | { type: 'setBusy'; busy: boolean }
  | { type: 'finish'; summary: OpSummary }
  | { type: 'dismissSummary' }

/**
 * 是否允许点「确认」。
 *
 * 三条禁止（每一条都对应一次真实教训）：
 * 1. **busy**：正在跑的时候再确认一次 = 对同一批文件操作两遍，
 *    第二遍会撞上「目标已存在」而全部失败，用户看到一堆莫名其妙的错误；
 * 2. **删除没有 facts**：说明「将删除 N 项 / 前 3 个名字 / 是否非空」根本没拿到，
 *    这时确认等于让用户盲删 —— 裁决 1 明确禁止；
 * 3. **删除的 count 为 0**：全部项都被安全策略拒了（例如只选了 /sdcard），
 *    确认按钮应该不可用，而不是「点了没反应」。
 */
export function canConfirm(state: OpState): boolean {
  if (state.busy) return false
  const dialog = state.dialog
  if (dialog === null) return false
  if (dialog.kind === 'delete') {
    const facts = dialog.facts
    if (facts === undefined) return false
    return facts.count > 0
  }
  /*
   * 新建文件夹**不需要** targets：它的目标是「当前目录 + 输入的名字」，
   * 而不是列表里的选中项。这里若沿用 targets.length > 0，
   * 新建对话框的「确定」会永远禁用 —— 一个看起来正常但根本点不动的按钮，
   * 比按钮不存在更让人困惑（本任务手工验证时正是这么发现的）。
   */
  if (dialog.kind === 'newFolder') return true
  return dialog.targets.length > 0
}

/**
 * 确认按钮是否应该显示为「危险」（删除用红色）。
 * 纯展示判断放在 shared，组件不必自己判 kind。
 */
export function isDestructive(dialog: OpDialog | null): boolean {
  return dialog !== null && dialog.kind === 'delete'
}

/** 状态机。无变化时返回同一个引用，让 React 跳过重渲染。 */
export function opReducer(state: OpState, action: OpAction): OpState {
  switch (action.type) {
    case 'openConfirm':
      // 繁忙时拒绝打开：否则用户能在一次操作进行中再打开一个对话框并提交
      if (state.busy) return state
      return {
        ...state,
        dialog: {
          kind: action.kind,
          targets: action.targets,
          ...(action.facts === undefined ? {} : { facts: action.facts }),
        },
      }
    case 'close':
      return state.dialog === null ? state : { ...state, dialog: null }
    case 'setBusy':
      return state.busy === action.busy ? state : { ...state, busy: action.busy }
    case 'finish':
      return { ...state, dialog: null, busy: false, lastSummary: action.summary }
    case 'dismissSummary':
      return state.lastSummary === null ? state : { ...state, lastSummary: null }
    default:
      return state
  }
}

/** 操作名称的中文 key 后缀（i18n 里 op.kind.*）。 */
export function opKindLabelKey(kind: OpDialogKind): string {
  switch (kind) {
    case 'delete': return 'op.kind.delete'
    case 'copy': return 'op.kind.copy'
    case 'move': return 'op.kind.move'
    case 'newFolder': return 'op.kind.newFolder'
    case 'rename': return 'op.kind.rename'
    default: return 'op.kind.delete'
  }
}

/** 操作类型 → shared/fs-ops 的 OpKind（下载入口用）。 */
export function opKindOf(kind: OpDialogKind): 'mkdir' | 'rename' | 'copy' | 'move' | 'delete' {
  if (kind === 'newFolder') return 'mkdir'
  return kind
}

/**
 * 汇总一批结果。
 *
 * 单独一份实现（而不是复用 fs-ops 的 summarizeResults）：这里还要把
 * **被拒绝项**算进「失败」里 —— 用户看到「3 成功 / 1 失败」比
 * 「3 成功 / 0 失败（但其实有 1 项被拒了）」更能理解发生了什么。
 */
export function summarizeWithBlocked(results: readonly OpItemResult[], blocked: readonly OpItemResult[] = []): OpSummary {
  const all = [...results, ...blocked]
  const failures: OpItemResult[] = []
  let ok = 0
  for (const item of all) {
    if (item.ok) ok += 1
    else failures.push(item)
  }
  return { ok, failed: failures.length, total: all.length, failures }
}
