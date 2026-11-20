import type { AdbState, AdbSource } from './types'

/**
 * 设置页与「默认下载路径」的共享类型与纯规则（R2-2）。
 *
 * 红线（与其他 shared 文件一致）：本文件同时被渲染层与主进程编译，
 * 不得 import 任何 node 内置模块 —— 所以「绝对路径判定」在这里自己实现，
 * 主进程的设置存储也复用它（规则只有一个来源）。
 */

/* ============ adb 状态的只读快照 ============ */

/**
 * 设置页展示的 adb 信息。
 *
 * 直接复用 types.ts 的 AdbState，但**收窄成设置页真正需要的三个字段**：
 * checking 时没有 path/version，error 时只有一个错误码。
 * 用可判别联合而不是三个 `string | null`：后者会让「正在查找」与「查到了但没路径」
 * 看起来一样，界面就会把未就绪误显示成「无」。
 */
export type SettingsAdb =
  | { state: 'ok'; source: AdbSource; path: string; version: string }
  | { state: 'checking' }
  | { state: 'error'; code: string }

/**
 * AdbState → 设置页快照（纯函数，可单测）。
 *
 * 降维规则：ok 原样带走 source/path/version；checking 与 error 只保留判别标签。
 * 刻意**不**在这里拼中文：文案由 i18n 决定（组件里禁止硬编码中文）。
 */
export function toSettingsAdb(state: AdbState): SettingsAdb {
  if (state.state === 'ok') {
    return { state: 'ok', source: state.source, path: state.path, version: state.version }
  }
  if (state.state === 'checking') return { state: 'checking' }
  return { state: 'error', code: state.code }
}

/* ============ settings:get 的返回数据 ============ */

/** 设置页需要的一份完整数据（settings:get / settings:set-download-dir 都返回它）。 */
export interface SettingsData {
  /**
   * 当前生效的默认下载路径。
   *
   * **一定是可用值**：存储里的坏值（空串 / 相对路径 / 不存在的目录）在读取时
   * 就已经降级为本机「下载」目录（见 electron/settings/store.ts），
   * 所以渲染层拿到它就可以直接当下载目标。
   */
  downloadDir: string
  /** 本机「下载」目录 —— 「恢复默认」按钮写回的値，也用来判断当前是不是默认值。 */
  defaultDownloadDir: string
  /** adb 的只读状态（不给改）。 */
  adb: SettingsAdb
}

/* ============ 绝对路径判定（shared 不能 import node:path） ============ */

/**
 * 这个字符串是不是一个绝对本地路径。
 *
 * 为什么不用 path.isAbsolute：shared 被渲染层编译，不能 import node:path。
 * 规则与 node 在本项目支持的两种平台上的行为对齐：
 *   - POSIX：以 '/' 开头；
 *   - Windows：'C:\' / 'C:/' 形式的盘符，或 '\\\\server\share' 形式的 UNC。
 * 反面例子（必须返回 false）：'relative/dir'、'C:foo'（盘符相对）、''。
 *
 * 主进程的设置存储也用它做校验 —— 渲染层与主进程对「什么算绝对路径」
 * 必须只有一个答案，否则会出现「界面显示已设置、主进程判定它非法」的分叉。
 */
export function isAbsolutePath(candidate: string): boolean {
  if (candidate === '') return false
  if (candidate.startsWith('/')) return true
  if (candidate.startsWith('\\\\')) return true
  return /^[A-Za-z]:[\\/]/.test(candidate)
}

/* ============ 普通下载的目标目录（用户裁决的唯一优先级实现） ============ */

/**
 * 判定普通下载目标时需要看的两个候选。
 *
 * 【用户裁决 / R2-2】本地面板的当前目录**不再是**下载目标：
 * 普通下载一律用设置里持久化的 downloadDir，「拖拽下载」的落点由资源管理器决定
 * （那条路不经过这里，见 electron/drag/service.ts）。
 */
export interface DownloadTargetCandidates {
  /** 设置里持久化的默认下载路径（唯一合法来源）。 */
  settingsDir: string | undefined
  /**
   * 本地面板的当前目录。
   *
   * **它不参与判定** —— 之所以还留在入参里，是为了让「忽略它」这条规则成为
   * 可执行的断言，而不是只能写在注释里：测试可以同时喂两个目录，
   * 断言结果永远取 settingsDir；settingsDir 缺失时返回失败而**绝不**回退到它
   * （那正是用户抱怨的旧行为）。
   */
  localPanelCwd?: string | undefined
}

/** 普通下载目标的判定结果：ok 时给出要用的目录，否则给出降级原因。 */
export type DownloadTarget =
  | { ok: true; dir: string }
  | { ok: false; reason: 'no-settings' | 'invalid-settings' }

/**
 * 普通下载（工具条「下载到本地」）的目标目录（R2-2 用户裁决）。
 *
 * 三条规则，顺序即优先级：
 * 1. 设置里有值且是绝对路径 → 用它；
 * 2. 设置里没有值（还没加载 / 首次启动读失败）→ no-settings，调用方必须给用户提示。
 *    这里**刻意不**回退到本地面板目录：静默换目录会让文件落到用户没想到的地方；
 * 3. 设置里的值不是绝对路径（理论上主进程已经拦掉，这里是第二道）→ invalid-settings。
 */
export function downloadTargetOf(candidates: DownloadTargetCandidates): DownloadTarget {
  const dir = candidates.settingsDir
  if (dir === undefined || dir.trim() === '') return { ok: false, reason: 'no-settings' }
  if (!isAbsolutePath(dir.trim())) return { ok: false, reason: 'invalid-settings' }
  return { ok: true, dir: dir.trim() }
}

/**
 * 普通下载「交给下载流程的目标目录」—— makeDownloadHandler 的 localDir 注入点。
 *
 * 为什么这层薄封装仍值得存在（而不是让 FilesPage 内联两行）：
 * FilesPage 是**组件**，本项目的测试工程（tsconfig.node，无 DOM）import 不进 src/pages，
 * 「下载目标到底取了哪一份」在组件里是观测不到的 —— 而它正是用户抱怨的那件事
 * （普通下载用的是本地面板目录）。把判定放在 shared，测试就能直接喂
 * 「设置目录 + 本地面板目录」两种输入，断言结果永远是设置目录，
 * 且设置缺失时返回 undefined（调用方据此提示），**绝不**回退到本地面板目录。
 *
 * 语义与 makeDownloadHandler 的约定对齐：undefined = 「没有可用的本地目标」，
 * 它会提示 t('op.needLocalDir')；返回目录则直接作为 transfer.enqueue 的 dstDir。
 */
export function downloadDirForDownload(
  settings: SettingsData | null,
  localPanelCwd: string | undefined,
): string | undefined {
  void localPanelCwd // 显式丢弃：本地面板目录不参与判定（用户裁决），保留入参只为让测试能证明这一点
  const target = downloadTargetOf({ settingsDir: settings?.downloadDir })
  return target.ok ? target.dir : undefined
}
