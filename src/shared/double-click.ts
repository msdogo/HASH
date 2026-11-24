import type { FileEntry, IpcResult } from './types'
import type { LocalFileStat } from './file-ops'
import { joinEntryPath } from './file-view'
import { t } from './i18n'
import { makeDownloadHandler } from './download-flow'

/**
 * R10：双击文件 → 自动下载（含「同名同大小」跳过预检）。
 *
 * 为什么单独一个 shared 文件：判定的**全部内容**是一张真值表，
 * 而 FilesPage 是组件（本工程 environment: node、无 jsdom，import 不进 src/pages 那一层），
 * 「双击之后到底下不下、下几个」在组件里观测不到。
 * 把判定与编排搬到这里，测试就能喂各种 entry × 本地事实组合，断言用户真正感知的结果。
 *
 * 红线（与其它 shared 文件一致）：不 import node 内置模块，也不碰 window —— 全部由调用方注入。
 */

/** 双击之后的判定结果（三态）。 */
export type DoubleClickDecision = 'enter' | 'download' | 'skip-exists'

/** 判定只需要条目的这三个字段（FileEntry 的子集，便于表驱动测试）。 */
export interface DoubleClickEntry {
  isDir: boolean
  size: number
  /** 缺省视为 true（与 file-view 的 isMetaKnown 同一约定）。 */
  metaKnown?: boolean
}

/**
 * 远端的 size 能不能用来判「同名同大小」。
 *
 * ===== 这是本任务唯一的真实边界 ===== 
 * 真机上大量系统项的 size/mtime 读不出来（降级补齐也失败 → metaKnown=false），
 * 而「读不出来」在数值上被填成 0，与「真的是个 0 字节文件」完全重合。
 * 如果拿这个 0 去比本地大小，就会在「本地恰好有个 0 字节同名文件」时
 * 把用户的下载挡在门外 —— 而更常见的情况是：远端其实有内容，只是 size 没解析出来。
 *
 * 宁可多下载一次（覆盖），也绝不误判成「已存在」，所以下面三种情况一律判「不可信 → 照常下载」：
 *   1. metaKnown === false（明确标记「元数据不是真的」）；
 *   2. size 不是有限数 / 为负数（解析残渣）；
 *   3. size <= 0（0 与「没读到」数值重合，见 FileEntry.metaKnown 的注释）。
 */
export function remoteSizeTrustworthy(entry: DoubleClickEntry): boolean {
  if (entry.metaKnown === false) return false
  if (!Number.isFinite(entry.size)) return false
  if (entry.size <= 0) return false
  return true
}

/**
 * 双击判定（完整真值表，见 tests/double-click.test.ts）：
 *
 * | entry  | 本地               | 结果            |
 * | ------ | ------------------ | --------------- |
 * | 目录   | 任意               | enter           |
 * | 文件   | 不存在             | download        |
 * | 文件   | 存在且大小相同     | skip-exists     |
 * | 文件   | 存在但大小不同     | download（覆盖）|
 * | 文件   | 查询失败（null）   | download        |
 * | 文件   | 远端 size 不可信   | download        |
 *
 * 最后两行的共同原则：**查不了 / 不可信时一律照常下载**。
 * 预检是「省一次重复传输」的优化，它没有资格拦下一次用户明确要求的下载。
 */
export function decideDoubleClick(
  entry: DoubleClickEntry,
  local: LocalFileStat | null,
): DoubleClickDecision {
  if (entry.isDir) return 'enter'
  // 预检失败（stat 报错 / 权限 / 竞态删除）：按「查不到」处理，照常下载
  if (local === null || !local.exists) return 'download'
  // 远端大小不可信：不据此判定跳过（见 remoteSizeTrustworthy）
  if (!remoteSizeTrustworthy(entry)) return 'download'
  return local.size === entry.size ? 'skip-exists' : 'download'
}

/** 单文件下载处理器：返回首个失败码或 null（与 makeDownloadHandler 同一约定）。 */
export type SingleFileDownload = (target: string) => Promise<string | null>

export interface SingleFileDownloadDeps {
  serial: string | null
  /** 真正的下载入口（store 里是 useOpStore.download，内部再走 runDownload → transfer.enqueue）。 */
  run: (serial: string, sources: string[], localDir: string) => Promise<string | null>
  /** 本地目标目录；undefined 表示设置里还没读到下载路径。 */
  localDir: () => string | undefined
  /** 提示落地（FilesPage 里是传输底栏的提示区）。 */
  notify: (text: string | null) => void
}

/**
 * 造一个「只下这一个文件」的下载处理器。
 *
 * ===== 为什么是「每次调用现造一个 makeDownloadHandler」而不是复制一份下载逻辑 ===== 
 * 复用既有流程的三个行为（任何一条都是踩过的坑）：
 *   1. busy 在任何出口都复位（第 2 轮复审 N1：漏复位会让整个操作入口死锁）；
 *   2. 没有本地目录时绝不调 run，只提示 op.needLocalDir；
 *   3. 成功提示 op.downloaded、失败提示 errorText(code)。
 * 而 makeDownloadHandler 取的是**选中集合**（selectedTargets），双击要求「只下这一个」——
 * 所以这里把 selectedTargets 注入成「返回 [target] 的常量函数」：
 * 下载逻辑一行没抄，入参来源从「store 的选中集合」换成「界面上被双击的那一行」。
 * 选中集合里有几个文件与此完全无关（这正是「双击只入队 1 个任务」的来源）。
 */
export function makeSingleFileDownload(deps: SingleFileDownloadDeps): SingleFileDownload {
  return async (target: string) => {
    const handler = makeDownloadHandler({
      serial: deps.serial,
      run: deps.run,
      selectedTargets: () => [target],
      localDir: deps.localDir,
      notify: deps.notify,
    })
    return await handler()
  }
}

/** 双击一个文件之后的结局（供调用方/测试断言，不参与渲染）。 */
export type OpenFileOutcome =
  | { kind: 'skipped-exists' }
  | { kind: 'queued'; code: string | null }
  | { kind: 'no-local-dir' }
  /** 目录 / 没有当前设备：这个入口只处理「文件」。 */
  | { kind: 'not-a-file' }

export interface OpenFileDeps {
  serial: string | null
  /** 当前目录（拼设备侧源路径用，走 joinEntryPath）。 */
  cwd: string
  /** 本地目标目录；undefined = 设置里还没有可用路径。 */
  localDir: () => string | undefined
  /** 本地预检（主进程 local:file-stat）。失败（ok:false）按「查不到」处理。 */
  precheck: (input: { dir: string; name: string }) => Promise<IpcResult<LocalFileStat>>
  /** 只下一个文件的下载处理器（makeSingleFileDownload 的结果）。 */
  downloadOne: SingleFileDownload
  /** 提示落地。 */
  notify: (text: string | null) => void
}

/**
 * 双击一个文件的完整流程：取下载目录 → 预检 → 判定 → 跳过或入队。
 *
 * 注意 handleOpen 里**目录**分支根本不会进来（目录仍然走 openDir 的原逻辑），
 * 这里保留 isDir 的判定只是为了「真值表在同一个函数里完整」，
 * 以及防御未来有人把它当通用入口调。
 */
export async function openFile(
  deps: OpenFileDeps,
  entry: FileEntry,
): Promise<OpenFileOutcome> {
  if (deps.serial === null) return { kind: 'not-a-file' }
  if (decideDoubleClick(entry, null) === 'enter') return { kind: 'not-a-file' }

  const localDir = deps.localDir()
  if (localDir === undefined) {
    // 复用既有文案：这里与「工具条下载没有目标目录」是同一件事
    deps.notify(t('op.needLocalDir'))
    return { kind: 'no-local-dir' }
  }

  const checked = await deps.precheck({ dir: localDir, name: entry.name })
  // 预检失败（权限 / 竞态 / 非法名字）→ 传 null → 判定表落到「照常下载」
  const local = checked.ok ? checked.data : null
  if (decideDoubleClick(entry, local) === 'skip-exists') {
    deps.notify(t('transfer.existsSkipped'))
    return { kind: 'skipped-exists' }
  }

  // 设备侧绝对路径由 joinEntryPath 拼（与其它所有设备路径同一实现，不自己拼分隔符）
  const code = await deps.downloadOne(joinEntryPath(deps.cwd, entry.name))
  return { kind: 'queued', code }
}
