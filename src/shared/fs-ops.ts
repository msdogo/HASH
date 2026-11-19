import { toErrorCode } from './errors'

/**
 * 文件操作的【逐项结果】与确认框事实（任务 9 裁决 1 / 4）。
 *
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块。
 * 真正的 adb 命令构造在主进程 electron/fs/operations.ts；这里只放
 * 「怎么跑一批、怎么把结果说清楚」这类纯逻辑，好让测试工程能直接测。
 *
 * ===== 为什么批量操作必须逐项返回 =====
 * 规格要求「失败项单独标注，不影响其他」。若返回值是单个布尔，
 * 用户看到的只有「失败」—— 不知道 10 个里错了哪 1 个，也不知道另外 9 个到底做没做，
 * 于是只能重试整批，而重试又会撞上「目标已存在」而二次失败。逐项结果是唯一能自洽的形状。
 */

/** 单项操作的结果（跨进程下发到渲染层的形状）。 */
export interface OpItemResult {
  /** 被操作的名字（不是完整路径：界面按名字对号入座，且用户看的就是名字）。 */
  name: string
  ok: boolean
  /** 失败错误码；ok 时不出现。 */
  code?: string
}

/** 批量结果的汇总（界面显示「N 成功 / M 失败」+ 失败项可展开）。 */
export interface OpSummary {
  ok: number
  failed: number
  total: number
  /** 失败项（保持原顺序，方便用户按列表顺序查找）。 */
  failures: OpItemResult[]
}

/** 把逐项结果汇总成界面要显示的东西。纯函数，空批次返回全零而不是抛错。 */
export function summarizeResults(results: readonly OpItemResult[]): OpSummary {
  const failures: OpItemResult[] = []
  let ok = 0
  for (const item of results) {
    if (item.ok) ok += 1
    else failures.push(item)
  }
  return { ok, failed: failures.length, total: results.length, failures }
}

/** 单项执行器：拿名字，返回该项结果（或抛错）。 */
export type OpRunner = (name: string) => Promise<OpItemResult> | OpItemResult

/**
 * 依次跑一批操作，**逐项容错**（裁决 4）。
 *
 * 三条必须遵守的性质：
 * 1. **串行**（不 Promise.all）：同一设备上并发 rm 会互相干扰，
 *    而且单设备 adb 通道本来就该一次一条命令；
 * 2. **一项失败不中断**：collect 到结果数组里继续下一项；
 * 3. **异常也折算成该项失败**：runner 抛出的任何东西（E_* 字符串、TypeError、
 *    非 Error 的裸抛）都必须变成 { ok:false, code }，绝不让整批 reject ——
 *    否则渲染层拿到的是一个异常，前面已成功的那些结果全丢了。
 *
 * 返回数组长度**恒等于**入参长度（界面据此判断「是不是每一项都有交代」）。
 */
export async function runSequential(
  names: readonly string[],
  runner: OpRunner,
): Promise<OpItemResult[]> {
  const results: OpItemResult[] = []
  for (const name of names) {
    try {
      const item = await runner(name)
      /*
       * 名字以 runner 给的为准，只补空串。
       *
       * 为什么不强制成入参 name：入参是**路径**（/sdcard/Download/a.txt），
       * 而界面要对号入座的是**名字**（a.txt）。强制覆盖会把友好名字换成整条路径，
       * 结果是「删除失败：/sdcard/Download/a.txt」这种又长又难扫的提示。
       * 只有 runner 忘了填名字时才退回入参（至少不会是 undefined）。
       */
      results.push(item.name === '' ? { ...item, name } : item)
    } catch (err) {
      results.push({ name, ok: false, code: toErrorCode(err) })
    }
  }
  return results
}

/** 操作文案的 key 后缀（i18n 里 fs.op.*）。 */
export type OpKind = 'mkdir' | 'rename' | 'copy' | 'move' | 'delete' | 'download'

/** 名字取自路径最后一段（结果提示里要显示「照片1.jpg 删除失败」而不是整条路径）。 */
export function opLabel(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (normalized === '/' || normalized === '') return normalized === '' ? path : '/'
  const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
  const index = trimmed.lastIndexOf('/')
  const name = index < 0 ? trimmed : trimmed.slice(index + 1)
  return name === '' ? trimmed : name
}

/** 删除确认框要列举的一项（调用方从目录列表里挑）。 */
export interface DeleteCandidate {
  name: string
  isDir: boolean
  /**
   * 目录是否非空。
   *
   * 必须由调用方在**删除前**确认（主进程跑一次 ls），因为：
   * 递归删除一个非空目录与删一个空目录，用户的心智代价完全不同 ——
   * 前者可能带走几百张照片，后者只是清个空壳。确认框必须把这件事说出来（裁决 1）。
   */
  nonEmpty: boolean
}

/** 删除确认框要显示的事实（裁决 1：数量 + 前 3 个名称 + 目录非空）。 */
export interface DeleteConfirmFacts {
  count: number
  /** 前 3 个名字（规格 §9.6）。 */
  names: string[]
  /** 是否还有更多名字没列出来。 */
  truncated: boolean
  /** 是否存在**非空目录**（递归删除时必须提示）。 */
  hasNonEmptyDir: boolean
}

/** 确认框最多列几个名字（规格明确要求 3 个）。 */
export const DELETE_PREVIEW_COUNT = 3

/**
 * 把一批「没有尝试执行」的项整理成结果（受保护路径 / 非法路径）。
 *
 * 为什么单独一类而不是塞进 results 的失败项：这些项**根本没发命令**，
 * 与「发了命令但失败」对用户是两件事 —— 前者是「系统拒绝你这么干」，
 * 后者是「试过了没成」。混在一起用户会一直重试一个永远不会成功的操作。
 */
export function blockedResults(items: ReadonlyArray<{ name: string; code: string }>): OpItemResult[] {
  return items.map((item) => ({ name: item.name, ok: false, code: item.code }))
}

/** 由候选列表算出确认框事实。纯函数，不碰磁盘 —— 非空判定由调用方给。 */
export function deleteConfirmSummary(candidates: readonly DeleteCandidate[]): DeleteConfirmFacts {
  return {
    count: candidates.length,
    names: candidates.slice(0, DELETE_PREVIEW_COUNT).map((item) => item.name),
    truncated: candidates.length > DELETE_PREVIEW_COUNT,
    // 只有**目录**才有「非空」含义：文件永远不是「非空目录」
    hasNonEmptyDir: candidates.some((item) => item.isDir && item.nonEmpty),
  }
}
