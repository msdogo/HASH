import type { TransferSnapshot, TransferTask } from './transfer'
import { canCancel, canRetry, isTerminal, progressLabel, progressView } from './transfer'

/**
 * 传输底栏的纯逻辑（任务 8 的界面层）。
 *
 * 与 file-view.ts 同一套路：所有判断都在这里用纯函数表达并可单测，
 * TransferDock / transferStore 只负责渲染与接线。
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块。
 */

/** 底栏一行要显示的内容（已算好，组件不再做判断）。 */
export interface DockRow {
  id: string
  /** 设备尾号（区分多设备同传）。 */
  serialTail: string
  direction: 'push' | 'pull'
  /** 文件名（不含路径）。 */
  fileName: string
  status: TransferTask['status']
  /** 进度条展示态：确定态给百分比，未知给不确定态（裁决 5）。 */
  progress: ReturnType<typeof progressView>
  /** 「1.2 MB / 50.0 MB」或「1.2 MB」（总量未知时）。 */
  progressText: string
  canCancel: boolean
  canRetry: boolean
  /** 覆盖过同名文件（裁决 7：默认覆盖，但界面上要提示）。 */
  overwrote: boolean
  /** 设备离线导致暂停（排队中且设备不在线）。 */
  pausedOffline: boolean
  error?: string
}

/** 取路径里的文件名（远程/本地统一按 / 与 \\ 切）。 */
export function baseNameOf(targetPath: string): string {
  const normalized = targetPath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index < 0 ? normalized : normalized.slice(index + 1)
}

/** 设备尾号：serial 可能很长（9N9CN2G0012A3P），底栏只留后 4 位。 */
export function serialTail(serial: string): string {
  return serial.length <= 4 ? serial : serial.slice(serial.length - 4)
}

/**
 * 把快照变成底栏行。
 *
 * 排序规则：正在跑的在最前（用户最关心），然后是排队中，最后是终态；
 * 同组内保持入队顺序（快照本身就是按入队顺序给的）。
 * 终态任务全部显示会把底栏撑爆，所以只保留最近 MAX_ROWS 条终态。
 */
export const MAX_ROWS = 6

export function dockRows(snapshot: TransferSnapshot, offlineSerials: readonly string[] = []): DockRow[] {
  const offline = new Set(offlineSerials)
  const running: DockRow[] = []
  const queued: DockRow[] = []
  const finished: DockRow[] = []
  for (const task of snapshot.tasks) {
    const row = toRow(task, offline)
    if (task.status === 'running') running.push(row)
    else if (task.status === 'queued') queued.push(row)
    else finished.push(row)
  }
  return [...running, ...queued, ...finished].slice(0, MAX_ROWS)
}

function toRow(task: TransferTask, offline: Set<string>): DockRow {
  return {
    id: task.id,
    serialTail: serialTail(task.serial),
    direction: task.direction,
    fileName: baseNameOf(task.direction === 'push' ? task.src : task.src),
    status: task.status,
    progress: progressView(task.doneBytes, task.totalBytes),
    progressText: progressLabel(task),
    canCancel: canCancel(task),
    canRetry: canRetry(task),
    overwrote: task.overwrote === true,
    pausedOffline: task.status === 'queued' && offline.has(task.serial),
    ...(task.error === undefined ? {} : { error: task.error }),
  }
}

/** 是否还有活跃任务（决定了底栏是否显示「传输空闲」之外的内容）。 */
export function hasActiveTransfer(snapshot: TransferSnapshot): boolean {
  return snapshot.tasks.some((task) => !isTerminal(task.status))
}

/** 是否存在可清除的已完成任务（决定按钮是否可用）。 */
export function hasFinishedTransfer(snapshot: TransferSnapshot): boolean {
  return snapshot.tasks.some((task) => task.status === 'done')
}

/** 是否存在可重试的任务（失败/取消）。 */
export function hasRetryableTransfer(snapshot: TransferSnapshot): boolean {
  return snapshot.tasks.some((task) => canRetry(task))
}

/**
 * 入队前对本地文件的校验结果。
 * 组件调用它把「用户选了什么」翻成「能不能传」。
 */
export type PickCheck = { ok: true } | { ok: false; code: 'E_NOT_A_DIRECTORY' | 'E_INVALID_PATH' }

/** 目标目录是否可用于传输（空串/含控制字符一律不可）。 */
export function checkTargetDir(dir: string): PickCheck {
  if (dir.trim() === '') return { ok: false, code: 'E_INVALID_PATH' }
  if (dir.includes('\n') || dir.includes('\r') || dir.includes('\0')) return { ok: false, code: 'E_INVALID_PATH' }
  return { ok: true }
}

/** 快照是否「与上一次相同」，用于丢掉无意义的重复推送（整份快照推送的代价控制）。 */
export function sameSnapshot(a: TransferSnapshot, b: TransferSnapshot): boolean {
  if (a.tasks.length !== b.tasks.length) return false
  if (a.running !== b.running || a.queued !== b.queued) return false
  for (let i = 0; i < a.tasks.length; i++) {
    const x = a.tasks[i]
    const y = b.tasks[i]
    if (x.id !== y.id || x.status !== y.status || x.doneBytes !== y.doneBytes) return false
    if (x.error !== y.error || x.overwrote !== y.overwrote || x.totalBytes !== y.totalBytes) return false
  }
  return true
}
