import { readdir, stat, realpath, lstat } from 'node:fs/promises'
import path from 'node:path'
import { E_INVALID_PATH, E_NOT_A_DIRECTORY, E_NOT_FOUND } from '../../src/shared/errors'
import { checkName, normalizeLocalPath } from '../../src/shared/path-guard'

/**
 * 本地目录访问（任务 9 的「本地栏」）。
 *
 * ===== R2-1：本地根目录沙箱已由用户裁决移除 =====
 * 原先这里有一道「裁决 5」闸门：所有本地访问都必须落在用户选定的根目录内，
 * 越界一律 E_OUTSIDE_ROOT（含符号链接逃逸）。用户的真实需求是「从资源管理器
 * 把任意位置的文件拖到设备」，而那道闸门让根外的文件直接被拒 ——
 * 于是用户明确要求**彻底移除本地根目录限制**。
 *
 * 移除的是「必须在某个根目录内」这一条判定，**不是整个闸门**：
 * 1. **路径合法性校验**仍然保留（空 / 控制字符 / 非绝对路径 → E_INVALID_PATH）；
 * 2. **realpath 归一化**仍然保留（resolveExisting：逐级向上找第一个存在的祖先再
 *    realpath，用于新建文件/目录这类「目标还不存在」的场景）。
 *
 * 第 2 条为什么必须留：调用方拿返回的 path 去做后续 IO（stat、入队、落盘），
 * 「判定用的路径」与「实际用的路径」必须是同一个，否则中间的符号链接
 * 两次解析可能指向不同位置。
 *
 * 注意：``..`` 仍会被 path.resolve 归一化 —— 归一化是为了得到**唯一真实路径**，
 * 不再是为了判越界。符号链接同样会被 realpath 展开到它真正指向的位置。
 */

/**
 * 行与结果类型来自 shared/file-ops 的**单一事实源**（渲染层要拿同一份形状）。
 * 这里只做一次再导出，不重新定义 —— 两份形状一漂移，IPC 边界上就会出现
 * 「主进程给了 full、渲染层按别的字段读」这种静默失败。
 */
export type { LocalFileStat, LocalItem, LocalListData } from '../../src/shared/file-ops'
import type { LocalFileStat, LocalItem, LocalListData } from '../../src/shared/file-ops'

/** 本地栏依赖。 */
export interface LocalFsDeps {
  /**
   * 本地栏的**起始浏览目录**（getter：用户可以在界面上改，不能构造时固化）。
   *
   * 它只是「打开本地栏时先看哪里」，**不再是访问边界** ——
   * 任何合法绝对路径都可以列举、读取、作为传输目标（R2-1）。
   */
  startDir: () => string
}

/** 判定结果。 */
export type AccessVerdict = { ok: true; path: string } | { ok: false; code: string }

/** 含控制字符的路径在任何文件系统上都表达不了（也进不了 IPC 的字符串协议）。 */
function hasControlChars(value: string): boolean {
  return value.includes('\n') || value.includes('\r') || value.includes('\0')
}

/**
 * 把路径解析成「真实路径」。
 *
 * 策略：从目标往上找**第一个存在的祖先**，realpath 它，再按词法把剩余段接回去。
 * 为什么不用 fs.realpath 直接怼目标：目标可能还不存在（新建文件场景），
 * 那时 realpath 抛 ENOENT，整条判定就没法做了。
 *
 * 边界情况：目标自身是符号链接时，realpath 会返回链接**指向**的位置 ——
 * 这正是我们要的（写入会写到那里去）。
 */
async function resolveExisting(pathValue: string): Promise<string> {
  const pending: string[] = []
  let current = pathValue
  // 最多向上 64 层：防御病态路径（也确实不会有更深的合理目录结构）
  for (let i = 0; i < 64; i++) {
    try {
      const resolved = await realpath(current)
      return pending.length === 0 ? resolved : path.join(resolved, ...pending.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return pathValue // 到盘符/根还没解析出来：按词法值处理
      pending.push(path.basename(current))
      current = parent
    }
  }
  return pathValue
}

/**
 * 解析一条本地路径：校验合法性 + realpath 归一化（R2-1 之后的唯一闸门）。
 *
 * 它**不再**判断「是否在某个根目录内」—— 那个限制已被用户裁决移除。
 * 留下的两件事仍不可省：
 *   1. 语法校验：空 / 纯空白 / 含控制字符 / 非绝对路径 → E_INVALID_PATH；
 *   2. 真实路径解析：符号链接与 .. 都收敛到唯一的真实位置。
 *
 * **必须 async**：realpath 是 IO。返回归一化后的真实路径 —— 调用方拿它去做
 * 后续 IO，这样「判定用的路径」与「实际用的路径」是同一个。
 */
export async function resolveLocalPath(target: string): Promise<AccessVerdict> {
  if (target === '' || target.trim() === '') return { ok: false, code: E_INVALID_PATH }
  if (hasControlChars(target)) return { ok: false, code: E_INVALID_PATH }
  if (!path.isAbsolute(target)) return { ok: false, code: E_INVALID_PATH }
  return { ok: true, path: await resolveExisting(path.resolve(target)) }
}

export class LocalFs {
  constructor(private readonly deps: LocalFsDeps) {}

  /** 起始浏览目录（已归一化）。**不是**访问边界。 */
  startDir(): string {
    return normalizeLocalPath(this.deps.startDir())
  }

  /**
   * 预检「目标目录里是否已有同名文件，以及它多大」（R10：双击下载前的跳过判定）。
   *
   * ===== 为什么是「目录 + 名字」而不是「一个完整路径」=====
   * 双击下载的目标路径是「设置里的默认下载路径 / 远端文件名」，而远端文件名**不可信**：
   * 它来自 adb ls 的输出，可能含分隔符、可能是 '..'、可能带首尾空白。
   * 若让渲染层先拼好一个完整本地路径再交进来，主进程只能校验「这串字符像不像
   * 合法绝对路径」，而拼错的后果（名字是 '..' 时上跳一级）在拼接那一刻就已经发生了。
   * 收「目录 + 名字」两个字段，就由这里用 checkName 把名字收成**单个路径段**、
   * 再用 path.join 拼 —— 分隔符的处理只有 node:path 一个来源（渲染层不碰分隔符）。
   *
   * ===== 三条边界 =====
   * 1. 目录走 resolveLocalPath（本项目本地路径的唯一闸门：语法 + realpath 归一化）；
   * 2. 名字不合法（空 / 含分隔符 / 是 . 或 .. / 首尾空白 / 超长）→ 判「不存在」。
   *    那种名字的下载本身也会被传输层的 assertPlainName 拒掉；
   *    但预检绝不能因为「查不了」就抛错拦住流程（见 LocalFileStat 的注释）；
   * 3. stat 失败（不存在 / 权限 / 竞态删除）→ 一律 exists:false ——
   *    宁可多下载一次（先写临时文件再原子改名，覆盖是安全的），
   *    也绝不误判成「已存在」把用户的文件挡在门外。
   *
   * 只认普通文件：目标位置是个同名**目录**时判「不存在」，让传输层去报它自己的错误
   * （那里已经能把「目标不是文件」说清楚），预检不替它下结论。
   */
  async fileStat(dir: string, name: string): Promise<LocalFileStat> {
    const access = await resolveLocalPath(dir)
    if (!access.ok) return { exists: false }
    if (!checkName(name).ok) return { exists: false }
    const full = path.join(access.path, name)
    try {
      const info = await stat(full)
      if (!info.isFile()) return { exists: false }
      return { exists: true, size: info.size }
    } catch {
      return { exists: false }
    }
  }

  /** 列举一个本地目录。dir 缺省时用起始浏览目录。 */
  async list(dir?: string): Promise<LocalListData> {
    const startDir = this.startDir()
    const wanted = dir === undefined || dir === '' ? startDir : dir
    const access = await resolveLocalPath(wanted)
    if (!access.ok) throw new Error(access.code)
    const cwd = access.path

    let info
    try {
      info = await stat(cwd)
    } catch {
      throw new Error(E_NOT_FOUND)
    }
    if (!info.isDirectory()) throw new Error(E_NOT_A_DIRECTORY)

    let names: string[]
    try {
      names = await readdir(cwd)
    } catch {
      throw new Error(E_NOT_FOUND)
    }

    const items: LocalItem[] = []
    for (const name of names) {
      const full = path.join(cwd, name)
      try {
        // lstat：符号链接要按链接本身取（isDir=false）。界面上的「文件夹」若其实
        // 是链接，双击进去会换到另一个位置 —— 按链接显示比假装它是目录更诚实。
        const linkInfo = await lstat(full)
        const isLink = linkInfo.isSymbolicLink()
        if (isLink) {
          items.push({ name, isDir: false, isLink: true, size: linkInfo.size, mtime: linkInfo.mtimeMs, full })
          continue
        }
        items.push({
          name,
          isDir: linkInfo.isDirectory(),
          isLink: false,
          size: linkInfo.isDirectory() ? 0 : linkInfo.size,
          mtime: linkInfo.mtimeMs,
          full,
        })
      } catch {
        // 单个条目 lstat 失败（权限/竞态）不影响整目录
      }
    }

    /*
     * 父目录：到盘符/根就为 null（那是真的没有上一级）。
     *
     * R2-1 之前这里还有一道「父目录不能出根，否则上一级就是越界按钮」的判定 ——
     * 沙箱移除后它没有意义了：上一级只是正常的目录导航。
     */
    const parentRaw = path.dirname(cwd)
    const parent = parentRaw === cwd ? null : parentRaw

    return { cwd, parent, items, startDir }
  }
}
