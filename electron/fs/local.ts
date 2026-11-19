import { readdir, stat, realpath, lstat } from 'node:fs/promises'
import path from 'node:path'
import { E_INVALID_PATH, E_NOT_A_DIRECTORY, E_NOT_FOUND, E_OUTSIDE_ROOT } from '../../src/shared/errors'
import { isInsideRoot, normalizeLocalPath } from '../../src/shared/path-guard'

/**
 * 本地目录访问（任务 9 的「本地栏」）。
 *
 * ===== 裁决 5：为什么必须有根目录 =====
 * 桌面端的进程权限等于用户权限。若把渲染层传来的任意路径直接交给 fs，
 * 那么一个被注入的路径就能读遍整台机器（包括 SSH 私钥、浏览器 cookie）。
 * 因此所有本地访问都收敛到「用户选定的根目录」（缺省是用户主目录），
 * 越界一律 E_OUTSIDE_ROOT。
 *
 * ===== 三种逃逸必须分别拦住 =====
 * 1. **直接给根外路径**：词法比较就能拦（但要注意 '/home/me2' 不是 '/home/me' 的子目录）；
 * 2. **用 .. 跳出去**：先 path.resolve 归一化再比，不能只比原串；
 * 3. **符号链接逃逸**：词法完全看不出来（C:\Users\me\link -> D:\secrets 只在 inode 里），
 *    必须 realpath 之后再比。**这是本文件存在的主要理由** ——
 *    前两条用 shared/path-guard 的纯函数就够了，第三条必须碰文件系统。
 *
 * 对「还不存在的路径」（新建文件/新建目录）也要能判：
 * 逐级向上找到第一个存在的祖先，realpath 它，再把剩余段按词法接回去比对。
 * 这样 C:\Users\me\docs\新文件.txt 在不存在的中间目录下也能正确判定。
 */

/**
 * 行与结果类型来自 shared/file-ops 的**单一事实源**（渲染层要拿同一份形状）。
 * 这里只做一次再导出，不重新定义 —— 两份形状一漂移，IPC 边界上就会出现
 * 「主进程给了 full、渲染层按别的字段读」这种静默失败。
 */
export type { LocalItem, LocalListData } from '../../src/shared/file-ops'
import type { LocalItem, LocalListData } from '../../src/shared/file-ops'

/** 本地访问所需的依赖（测试注入根目录）。 */
export interface LocalFsDeps {
  /** 当前根目录（getter：用户可以在设置里改，不能构造时固化）。 */
  root: () => string
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
      if (parent === current) return pathValue // 到盘符/根还没解析出来：按词法值处理，后面再判越界
      pending.push(path.basename(current))
      current = parent
    }
  }
  return pathValue
}

/**
 * 判断某路径能否访问（裁决 5 的唯一闸门）。
 *
 * **必须 async**：符号链接逃逸只有 realpath 能看出来，而它是 IO。
 * 返回归一化后的真实路径 —— 调用方拿它去做后续 IO，
 * 这样「判定用的路径」与「实际用的路径」是同一个，不存在 TOCTOU 之外的误差空间。
 */
export async function checkLocalAccess(root: string, target: string): Promise<AccessVerdict> {
  if (target === '' || target.trim() === '') return { ok: false, code: E_INVALID_PATH }
  if (hasControlChars(target)) return { ok: false, code: E_INVALID_PATH }
  if (!path.isAbsolute(target)) return { ok: false, code: E_INVALID_PATH }

  // 1) 词法快速判定：明显在根外的直接拒，不必碰磁盘
  const lexical = path.resolve(target)
  if (!isInsideRoot(root, lexical)) return { ok: false, code: E_OUTSIDE_ROOT }

  // 2) 真实路径判定：拦住符号链接逃逸（词法看不出来的那一条）
  const realRoot = await resolveExisting(root)
  const realTarget = await resolveExisting(lexical)
  if (!isInsideRoot(realRoot, realTarget)) return { ok: false, code: E_OUTSIDE_ROOT }

  return { ok: true, path: realTarget }
}

export class LocalFs {
  constructor(private readonly deps: LocalFsDeps) {}

  /** 当前根目录（已归一化）。 */
  root(): string {
    return normalizeLocalPath(this.deps.root())
  }

  /** 列举一个本地目录。dir 缺省时用根目录。 */
  async list(dir?: string): Promise<LocalListData> {
    const root = this.root()
    const wanted = dir === undefined || dir === '' ? root : dir
    const access = await checkLocalAccess(root, wanted)
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
        // lstat：符号链接要按链接本身取（isDir=false），否则点进去就换了目录，
        // 而目标可能在根外 —— 界面显示的那个「文件夹」其实是逃逸入口。
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

    // 父目录：不能给出根目录之外的位置（否则「上一级」就成了越界按钮）
    const parentRaw = path.dirname(cwd)
    const parent = parentRaw === cwd ? null : isInsideRoot(root, parentRaw) ? parentRaw : null

    return { cwd, parent, items, root }
  }
}
