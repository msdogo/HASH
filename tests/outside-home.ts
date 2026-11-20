import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { isInsideRoot } from '../src/shared/path-guard'

/**
 * 造一个**在用户主目录之外**的可写临时目录，供 R2-1 的用例使用。
 *
 * 为什么必须是主目录之外：R2-1 移除的那道闸门在生产里的 root 缺省就是
 * `homedir()`（见 electron/main.ts 的 startDir）。用户的真实工况是
 * 「从资源管理器把 D 盘/资料盘里的文件拖进设备」—— 那些文件在主目录之外。
 *
 * 为什么不能直接用 os.tmpdir()：Windows 上它就在主目录之内
 * （C:\Users\X\AppData\Local\Temp），拿它当「根外」样本，
 * 用例会变成一条空转的「在主目录里传文件」，把根判定加回去也不会红。
 *
 * 按顺序试几个基准目录，挑第一个**真实路径不在主目录内**且可写的；
 * 都不行返回 null（调用方据此 skip 并打印原因，绝不静默降级）。
 */
export function makeOutsideHomeDir(): string | null {
  const home = realpathSync.native(homedir())
  const candidates = [path.parse(process.cwd()).root, process.cwd()]
  for (const base of candidates) {
    let dir = ''
    try {
      dir = mkdtempSync(path.join(base, 'adbfm-outside-'))
      if (!isInsideRoot(home, realpathSync.native(dir))) return dir
    } catch {
      // 这个基准目录不可写（权限/只读盘）：试下一个
    }
    if (dir !== '') { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ } }
  }
  return null
}

/** 主目录的真实路径（用例里自证前提用）。 */
export function realHome(): string {
  return realpathSync.native(homedir())
}
