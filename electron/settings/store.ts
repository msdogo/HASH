import Store from 'electron-store'
import { existsSync, statSync } from 'node:fs'
import { E_INVALID_PATH, E_NOT_FOUND } from '../../src/shared/errors'
import { isAbsolutePath } from '../../src/shared/settings'

/**
 * 设置持久化（R2-2）：唯一职责是「默认下载路径」的读写与坏值降级。
 *
 * ===== 为什么是注入式工厂而不是模块级单例 =====
 * electron-store 依赖 Electron 的 app 对象：直接 `new Store()` 在测试环境（纯 node）
 * 会抛「You can only use this module from the Electron main process」。而本轮要求
 * 「持久化必须用真读写证明：写 → 重建 → 读回」—— 那就必须让测试能指定存储文件位置。
 * 所以这里只接受 `filePath`（目录）与 `defaultDownloadDir`（两个绝对值都由调用方给），
 * 生产在 electron/main.ts 里传 `app.getPath('userData')` 与 `app.getPath('downloads')'。
 *
 * ===== 为什么坏值要降级而不是报错 =====
 * 设置文件是用户可编辑的（也可能被别的版本写坏）。一条坏值如果直接抛，
 * 整个设置页打不开、下载也做不了；而它本来只是一条「偏好」。
 * 所以读到不可用的值时退回系统「下载」目录，并且**只告警一次**
 * （每次读都打日志会把控制台刷满，反而看不到真正的错误）。
 */

/** 存储文件名（electron-store 的 name，落盘为 <filePath>/settings.json）。 */
export const SETTINGS_FILE_NAME = 'settings'

/** 设置存储的依赖（全部由调用方注入，测试才能用临时目录）。 */
export interface SettingsStoreDeps {
  /** 存储目录（生产是 app.getPath('userData')）。electron-store 会自建不存在的子目录。 */
  filePath: string
  /** 本机「下载」目录（生产是 app.getPath('downloads')），默认值与「恢复默认」都用它。 */
  defaultDownloadDir: string
  /** 告警出口（测试可注入以断言「坏值只记一次」）。缺省 console.warn。 */
  warn?: (message: string) => void
}

/** 设置存储对上层暴露的最小面。 */
export interface SettingsStore {
  /** 当前生效的默认下载路径；存储里的坏值已降级为本机「下载」目录。 */
  getDownloadDir(): string
  /** 本机「下载」目录（默认值 / 「恢复默认」的目标）。 */
  getDefaultDownloadDir(): string
  /**
   * 写入默认下载路径。
   *
   * 非法值**抛错**（不是静默回退）：这是用户的显式动作，告诉他没成比假装成了好。
   *   - 不是绝对路径 → E_INVALID_PATH
   *   - 不存在或不是目录 → E_NOT_FOUND
   * @returns 实际写入的值（已 trim）。
   */
  setDownloadDir(dir: string): string
  /** 恢复默认：等价于 setDownloadDir(defaultDownloadDir)。 */
  resetDownloadDir(): string
  /** 存储文件路径（诊断 / 报告用，不参与判定）。 */
  storagePath(): string
}

/** 目录是否真实存在（默认实现；测试若需要可以不必替换 —— 临时目录本身就是真的）。 */
function directoryExists(dir: string): boolean {
  if (!existsSync(dir)) return false
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * 造一个设置存储。
 *
 * 注意 electron-store 的 schema 会先把**类型**错的値清成 undefined
 * （实测：写 "downloadDir": 123 进去，get 回来是 undefined），
 * 而「类型对但语义不可用」（空串 / 相对路径 / 目录已被删）由下面的校验兜住。
 */
export function createSettingsStore(deps: SettingsStoreDeps): SettingsStore {
  const warn = deps.warn ?? ((message: string): void => { console.warn(message) })
  /*
   * clearInvalidConfig：整个文件是坏 JSON 时不要抛 —— 抛了应用就起不来。
   * 实测（node 环境，electron-store 12.0.0）：坏 JSON → get 返回 undefined，
   * 随后一次 set 会把文件重写成合法 JSON。所以「坏值」与「坏文件」走同一条降级路径。
   */
  const store = new Store<{ downloadDir?: string }>({
    cwd: deps.filePath,
    name: SETTINGS_FILE_NAME,
    clearInvalidConfig: true,
    schema: { downloadDir: { type: 'string' } },
  })

  /** 已告警过的原因（同一条坏值只吵一次）。 */
  const warned = new Set<string>()
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return
    warned.add(key)
    warn(message)
  }

  const getDownloadDir = (): string => {
    const stored = store.get('downloadDir')
    // 没设过（首次启动 / 类型被 schema 清掉 / 整个文件坏掉）→ 默认值，且这不是异常
    if (stored === undefined) return deps.defaultDownloadDir
    if (!isAbsolutePath(stored)) {
      warnOnce(
        'not-absolute:' + stored,
        '[settings] 默认下载路径不是绝对路径：' + JSON.stringify(stored) + '，已退回系统下载目录 ' + deps.defaultDownloadDir,
      )
      return deps.defaultDownloadDir
    }
    if (!directoryExists(stored)) {
      warnOnce(
        'missing:' + stored,
        '[settings] 默认下载路径指向的目录不存在：' + stored + '，已退回系统下载目录 ' + deps.defaultDownloadDir,
      )
      return deps.defaultDownloadDir
    }
    return stored
  }

  const setDownloadDir = (dir: string): string => {
    const trimmed = dir.trim()
    if (!isAbsolutePath(trimmed)) throw new Error(E_INVALID_PATH)
    if (!directoryExists(trimmed)) throw new Error(E_NOT_FOUND)
    store.set('downloadDir', trimmed)
    return trimmed
  }

  return {
    getDownloadDir,
    getDefaultDownloadDir: () => deps.defaultDownloadDir,
    setDownloadDir,
    resetDownloadDir: () => setDownloadDir(deps.defaultDownloadDir),
    storagePath: () => store.path,
  }
}
