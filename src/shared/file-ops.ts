import type { OpItemResult } from './fs-ops'

/**
 * 文件操作的 IPC 出参类型（任务 9）。
 *
 * 为什么单独一个文件而不是塞进 shared/types：
 * types.ts 是「设备 / 目录列表」的模型，file-ops 是「写操作的结果与本地栏的模型」。
 * 混在一起会让 types.ts 变成什么都往里塞的杂物间，而它现在被文件页与设备栏共用。
 *
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块。
 */

/** 单次写操作（可能是批量）的返回数据。 */
export interface FsOpData {
  /** 逐项结果：长度恒等于入参项数（裁决 4：失败项单独标注，不影响其他）。 */
  results: OpItemResult[]
}

/** 删除确认框需要的事实（裁决 1：数量 + 前 3 个名字 + 非空目录）。 */
export interface FsRemoveFactsData {
  /** 将删除的项数（**以主进程实际检查过的为准**，不是界面自己数的）。 */
  count: number
  /** 前 3 个名字（规格 §9.6）。 */
  names: string[]
  /** 是否还有更多名字没列出。 */
  truncated: boolean
  /** 是否存在非空目录（递归删除必须让用户知道这一点）。 */
  hasNonEmptyDir: boolean
  /**
   * 被安全策略拒绝的项（受保护根路径、非法路径）。
   *
   * 单独列出来而不是混进 results：这些项**根本没有尝试删除**，
   * 用户看到「3 成功 / 1 失败 / 1 被拒绝」才能理解发生了什么。
   */
  blocked: OpItemResult[]
}

/** 本地面板里的一行（与主进程 LocalItem 同构）。 */
export interface LocalItem {
  name: string
  isDir: boolean
  /** 符号链接（不跟随；即使指向目录也按非目录显示，避免点进去越界）。 */
  isLink: boolean
  size: number
  mtime: number
  full: string
}

/** 本地目录列举结果。 */
export interface LocalListData {
  cwd: string
  /** 上一级；已在根目录时为 null。 */
  parent: string | null
  items: LocalItem[]
  /**
   * 起始浏览目录（界面显示「起始目录：…」）。
   *
   * R2-1 之后它**只是打开本地栏时先看哪里**，不再是访问边界 ——
   * 字段名从 root 改成 startDir 就是为了不给读代码的人错误暗示。
   */
  startDir: string
}

/**
 * 单个本地文件的预检结果（R10：双击下载前的「同名同大小」判定）。
 *
 * 形状刻意做成**不可判别成三态**：只有「存在（带大小）」与「不存在」两种，
 * 而「查不到」（stat 抛错 / 权限 / 竞态删除）也收敛成 `{ exists: false }`。
 *
 * 为什么「查不到」不是第三种状态、也不能是错误：
 * 预检的唯一用途是「省掉一次重复传输」。它没有资格拦下一次用户明确要求的下载 ——
 * 查不了就当不存在，照常下载（覆盖是安全的，见 runner 的先写临时文件再原子改名）。
 * 把它做成 ok:false 会诱使调用方走错误提示分支，那正好是「因为查不了就不许下」。
 */
export type LocalFileStat = { exists: false } | { exists: true; size: number }
