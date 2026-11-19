import type { IpcResult } from './types'

/**
 * 传输模块的【纯逻辑与类型】（任务 8）。
 *
 * 为什么类型放 shared 而不是 electron/transfer：
 * 渲染层的 TransferDock 要用它们，而测试工程 import 不了 src/ 下非 shared 的目录。
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块。
 *
 * ===== 裁决 1 的真机结论（详见 tests/transfer-progress.test.ts 的原始字节）=====
 * adb 1.0.41 的 push/pull **不输出百分比**，全程只有结束时的**一行汇总**，且写在 **stderr**。
 * 所以进度不能靠解析百分比，只能靠【轮询目标文件大小】；
 * 汇总行用于拿到权威字节数并在结束时校正 doneBytes。
 */

/* ============ 类型 ============ */

export type Direction = 'push' | 'pull'

export type TransferStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled'

/** 一个传输任务（跨进程下发到渲染层的形状）。 */
export interface TransferTask {
  id: string
  serial: string
  direction: Direction
  /** push 时是本地路径，pull 时是远程路径。 */
  src: string
  /** push 时是远程路径，pull 时是本地路径。 */
  dst: string
  /**
   * 总字节数。
   *
   * null 表示【未知】（拿不到 stat / 超过 JS 安全整数）。界面必须显示不确定态，
   * 绝不能当成 0 或 100 —— 那是假进度（裁决 5）。
   */
  totalBytes: number | null
  doneBytes: number
  status: TransferStatus
  /** 失败错误码；只有 status === 'failed' 时有值。 */
  error?: string
  /** 已重试次数（0 表示从未重试）。 */
  attempt: number
  /** 目标位置原本已有同名文件、本次写入把它覆盖了（裁决 7：默认覆盖但要提示）。 */
  overwrote?: boolean
  /** 入队时间（毫秒）。 */
  createdAt: number
  /** 进入终态的时间（毫秒）；未结束为 undefined。 */
  finishedAt?: number
}

/** 主进程推送给渲染层的传输快照（节流后）。 */
export interface TransferSnapshot {
  tasks: TransferTask[]
  running: number
  queued: number
}

/* ============ 进度解析（裁决 1） ============ */

/**
 * 单文件传输汇总行的结构。
 *
 * 真机原始输出（push）：
 *   `big-50m.bin: 1 file pushed, 0 skipped. 25.1 MB/s (52428800 bytes in 1.992s)\r\n`
 * 真机原始输出（pull，带完整远程路径）：
 *   `/sdcard/Download/x.bin: 1 file pulled, 0 skipped. 34.2 MB/s (419430400 bytes in 11.694s)\r\n`
 * 多文件时每文件一行，最后追加一行总计：
 *   `2 files pushed, 0 skipped. 0.0 MB/s (3 bytes in 0.046s)\r\n`
 */
export interface TransferSummary {
  direction: Direction
  /** 权威总字节数（多文件时取总计行）。 */
  bytes: number
  seconds: number
  skipped: number
  /** 单文件行（不含总计行）。 */
  files: Array<{ name: string; bytes: number }>
}

/** 单条明细行：`<名字>: N file(s) pushed|pulled, M skipped. X MB/s (B bytes in S s)` */
const DETAIL_RE =
  /^(.*?):\s*(\d+)\s+files?\s+(pushed|pulled),\s*(\d+)\s+skipped\.\s*([\d.]+)\s*[KMG]?B\/s\s*\((\d+)\s+bytes\s+in\s+([\d.]+)s\)\s*$/

/** 总计行：`N files pushed, M skipped. ...`（没有前导名字段） */
const TOTAL_RE =
  /^(\d+)\s+files?\s+(pushed|pulled),\s*(\d+)\s+skipped\.\s*([\d.]+)\s*[KMG]?B\/s\s*\((\d+)\s+bytes\s+in\s+([\d.]+)s\)\s*$/

/** 把一段输出按 \r\n / \n / \r 切成行（adb 用 \r\n 结尾，且进度行可能用 \r 覆盖同一行）。 */
export function splitAdbLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/).filter((line) => line !== '')
}

/**
 * 解析传输汇总行。
 *
 * 有总计行时以总计行为准（多文件场景下最后一条明细行的字节数不是总量，
 * 真机实例：a.txt 1 字节、b.txt 2 字节、总计 3 字节，若取明细行会得到 2）。
 * 完全没有汇总行时返回 null —— 由调用方按退出码判失败，绝不臆造进度。
 */
export function parseTransferSummary(text: string): TransferSummary | null {
  let direction: Direction | null = null
  let totalBytes: number | null = null
  let totalSeconds = 0
  let totalSkipped = 0
  const files: Array<{ name: string; bytes: number }> = []

  for (const line of splitAdbLines(text)) {
    const total = TOTAL_RE.exec(line)
    if (total !== null) {
      direction = total[2] === 'pushed' ? 'push' : 'pull'
      totalBytes = Number(total[5])
      totalSkipped = Number(total[3])
      totalSeconds = Number(total[6])
      continue
    }
    const detail = DETAIL_RE.exec(line)
    if (detail !== null) {
      const dir: Direction = detail[3] === 'pushed' ? 'push' : 'pull'
      direction = dir
      const bytes = Number(detail[6])
      files.push({ name: detail[1], bytes })
      // 没有总计行时（单文件场景）用明细行兜底
      if (totalBytes === null) {
        totalBytes = bytes
        totalSeconds = Number(detail[7])
        totalSkipped = Number(detail[4])
      }
    }
  }

  if (direction === null || totalBytes === null) return null
  return { direction, bytes: totalBytes, seconds: totalSeconds, skipped: totalSkipped, files }
}

/**
 * 解析百分比进度行（**兼容路径，真机未观察到**）。
 *
 * adb.exe 里确实存在 `[%3d%%] %s` 这个格式串，但它属于 bugreportz（已用 strings 核实），
 * push/pull 在 1.0.41 上一次都没输出过。保留解析只是为了让别的 adb 版本不至于完全看不懂，
 * **不作为生产进度主通道**（主通道是轮询）。
 *
 * 注意 adb 的进度是**用 \r 覆盖同一行**输出的，不是每行一条，
 * 所以这里按 \r 也切分，才能把同一条物理行里的多个百分比都取出来。
 */
export function parseProgressTicks(text: string): number[] {
  const out: number[] = []
  for (const segment of text.split(/\r|\n/)) {
    const match = /\[\s*(\d{1,3})%\]/.exec(segment)
    if (match === null) continue
    const percent = Number(match[1])
    if (!Number.isNaN(percent) && percent >= 0 && percent <= 100) out.push(percent)
  }
  return out
}

/* ============ 进度展示（裁决 5） ============ */

/** 界面上进度条要显示什么。 */
export type ProgressView =
  | { kind: 'determinate'; percent: number }
  /**
   * 大小未知：显示不确定态。
   *
   * 为什么不能退化成 0% 或 100%：两者都是**假信息** ——
   * 用户会以为传输卡住或已完成，而实际上我们只是不知道总量。
   */
  | { kind: 'indeterminate' }

/**
 * 由 doneBytes / totalBytes 算出进度展示态。
 *
 * 三种必须降级成不确定态的情况（裁决 5）：
 * 1. totalBytes 为 null（stat 拿不到）；
 * 2. totalBytes <= 0 或非有限数（空文件、stat 输出异常）；
 * 3. totalBytes 超过 JS 安全整数 —— 此时任何乘除都会丢精度，
 *    算出来的百分比是错的，宁可不显示（手机不会有 9PB 文件，但这道闸门必须有）。
 */
export function progressView(doneBytes: number, totalBytes: number | null): ProgressView {
  if (totalBytes === null) return { kind: 'indeterminate' }
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return { kind: 'indeterminate' }
  if (totalBytes > Number.MAX_SAFE_INTEGER) return { kind: 'indeterminate' }
  if (!Number.isFinite(doneBytes)) return { kind: 'indeterminate' }
  const raw = (doneBytes / totalBytes) * 100
  const percent = Math.min(100, Math.max(0, raw))
  return { kind: 'determinate', percent }
}

/* ============ 进度推送闸门（裁决 6） ============ */

/** 两次进度推送之间的最小间隔（毫秒）。 */
export const PROGRESS_MIN_INTERVAL_MS = 100

/** 两次进度推送之间的最小百分比变化。 */
export const PROGRESS_MIN_PERCENT_STEP = 1

/**
 * 进度事件的节流闸门。
 *
 * 为什么主进程侧就要节流（而不是让渲染层自己丢）：
 * 轮询每 200ms 一次、多设备并发最多 3 个，若每个 tick 都 send 一次，
 * 渲染层每秒要处理十几次 IPC + 十几次重渲染，传输本身会被 UI 拖慢。
 *
 * 三条放行规则：
 * 1. 首次（lastAt 为 undefined）一定放行；
 * 2. 百分比变化 ≥ PROGRESS_MIN_PERCENT_STEP **且** 间隔 ≥ PROGRESS_MIN_INTERVAL_MS；
 * 3. 到达 100% 一定放行（终态不能被节流吞掉，否则界面永远停在 99%）。
 * 不确定态（null）只在首次推送 —— 反复推 null 没有任何新信息。
 */
export class ProgressGate {
  private lastAt: number | undefined
  private lastPercent: number | null = null

  constructor(
    private readonly minIntervalMs: number = PROGRESS_MIN_INTERVAL_MS,
    private readonly minPercentStep: number = PROGRESS_MIN_PERCENT_STEP,
  ) {}

  /** 这次进度要不要推给渲染层。 */
  accept(percent: number | null, now: number): boolean {
    // 首次：无论什么值都推，界面必须先拿到一条
    if (this.lastAt === undefined) {
      this.lastAt = now
      this.lastPercent = percent
      return true
    }

    if (percent === null) {
      // 不确定态重复推送没有信息量
      return false
    }

    // 终态必须放行，且不重置时间戳之前就要判掉，避免因为间隔不足而漏掉 100%
    if (percent >= 100) {
      const changed = this.lastPercent !== 100
      this.lastAt = now
      this.lastPercent = percent
      return changed
    }

    // 间隔不足：不推，也不更新 lastAt（窗口从「上次推送」起算，避免持续小步变化永不派发）
    if (now - this.lastAt < this.minIntervalMs) return false

    const previous = this.lastPercent
    if (previous !== null && Math.abs(percent - previous) < this.minPercentStep) return false

    this.lastAt = now
    this.lastPercent = percent
    return true
  }
}

/**
 * 进度百分比（节流判断用）：不确定态返回 null。
 * 与 progressView 分开是因为告警/日志要的是数字而不是展示态。
 */
export function percentOf(doneBytes: number, totalBytes: number | null): number | null {
  const view = progressView(doneBytes, totalBytes)
  return view.kind === 'determinate' ? view.percent : null
}

/* ============ 格式化 ============ */

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const

/**
 * 字节数显示。
 * 未知（null / 负数 / NaN）一律返回占位符 '—'，绝不显示 NaN 或 0 B。
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return bytes + ' B'
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return value.toFixed(1) + ' ' + SIZE_UNITS[unit]
}

/* ============ 任务快照工具（渲染层用） ============ */

/** 任务是否已进入终态（不会再有进度变化）。 */
export function isTerminal(status: TransferStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'canceled'
}

/** 该任务现在能不能重试（裁决 7：失败/取消才可重试）。 */
export function canRetry(task: TransferTask): boolean {
  return task.status === 'failed' || task.status === 'canceled'
}

/** 该任务现在能不能取消（排队中或在跑）。 */
export function canCancel(task: TransferTask): boolean {
  return task.status === 'queued' || task.status === 'running'
}

/** 进度条文字：优先显示「已完成/总量」，总量未知时只显示已完成。 */
export function progressLabel(task: TransferTask): string {
  if (task.totalBytes === null) return formatBytes(task.doneBytes)
  return formatBytes(task.doneBytes) + ' / ' + formatBytes(task.totalBytes)
}

/* ============ IPC 契约（与 api-contract 同源） ============ */

/**
 * 渲染层 → 主进程的入参（zod schema 在 api-contract 里，类型从这里派生）。
 * 这里只定义类型的形状，不引任何运行时依赖。
 */
export interface TransferEnqueueInput {
  serial: string
  direction: Direction
  /** push 时是本地绝对路径；pull 时是远程绝对路径。 */
  src: string
  /** push 时是远程目录；pull 时是本地目录。 */
  dstDir: string
}

export type TransferEnqueueResult = IpcResult<TransferTask>

/** transfer:cancel 入参。 */
export interface TransferIdInput {
  id: string
}
