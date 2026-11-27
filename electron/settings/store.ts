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
  /**
   * 「投屏参数」的默认值（生产传 src/shared/mirror.ts 的 DEFAULT_SCRCPY_ARGS）。
   *
   * 由调用方给而不是在这里 import：存储层只该碰设置文件，
   * 它不需要知道默认参数具体是什么，也就不该因为那个常量改了而重新编译。
   */
  defaultScrcpyArgs: string
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
  /**
   * 该设备上次停留的目录（R9）。
   *
   * 没有记录、或记录是坏值（空串 / 非绝对路径 / 不是字符串）时返回 `undefined`，
   * 并且坏值只 warn 一次 —— 与 getDownloadDir 同一条降级范式：
   * 一条坏记录不该让应用起不来，它本来只是一条「便利记忆」。
   *
   * 【分层边界】这里**不**校验「目录在设备上是否还存在」：那要发一条 adb 命令，
   * 是渲染层恢复时才有的能力。硬塞进存储层会让「设置持久化」依赖设备在线，
   * 而且与这个类「只碰本机设置文件」的职责冲突。
   */
  getDeviceCwd(serial: string): string | undefined
  /**
   * 记住某台设备停留的目录（R9：每次成功进入目录都会调用）。
   *
   * 空 serial（设备没序列号）与空 cwd 一律**拒绝写入**：前者会产生一串垃圾键，
   * 后者没有语义。拒绝是静默的（只 warn）—— 这是便利功能，
   * 写不进去不该让浏览中断。
   */
  setDeviceCwd(serial: string, cwd: string): void
  /**
   * 自定义 scrcpy 参数（原始输入）。
   *
   * 没设过 → 返回 **DEFAULT_SCRCPY_ARGS**（默认那行参数，用户可在输入框里删掉）；
   * 用户显式存了空串 → 返回空串（那是他的选择，不能当成「没设过」再塞回默认值）。
   *
   * 坏值（类型不对 / 存成了 null）降级成默认值并 warn 一次，**不抛错** ——
   * 与 getDownloadDir 同一条降级范式：一条投屏偏好不该让设置页打不开。
   */
  getScrcpyArgs(): string
  /** 默认参数（「恢复默认」写回它，界面也用它判断当前是不是默认）。 */
  getDefaultScrcpyArgs(): string
  /** 恢复默认参数；返回实际写入的值。 */
  resetScrcpyArgs(): string
  /**
   * 写自定义 scrcpy 参数；返回实际写入的值（已 trim）。
   *
   * 空串是合法输入（= 清空，只用内置参数），所以不像 downloadDir 那样拒绝空值。
   * 长度上限由 IPC 层的 zod 管（500），存储层不重复设一个不同的上限。
   */
  setScrcpyArgs(raw: string): string
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
  const store = new Store<{
    downloadDir?: string
    deviceCwds?: Record<string, string>
    scrcpyArgs?: string
  }>({
    cwd: deps.filePath,
    name: SETTINGS_FILE_NAME,
    clearInvalidConfig: true,
    /*
     * deviceCwds（R9）：serial → 该设备上次停留的目录。
     *
     * schema 只能声明到「顶层是个对象」这一层 —— electron-store 12 的 schema 走 ajv，
     * 对**嵌套 record 的内部字段**没有任何校验能力（键是设备序列号，事先不可能枚举）。
     * 所以每个值必须由下面的 getDeviceCwd 自己验（是字符串 / 非空 / 绝对路径）。
     * 这里声明 type: 'object' 只为拦住「整个值不是对象」这种形态，
     * 免得一个手改坏的文件让 electron-store 在读取时抛出去。
     */
    schema: {
      downloadDir: { type: 'string' },
      deviceCwds: { type: 'object' },
      scrcpyArgs: { type: 'string' },
    },
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

  /**
   * 读设备目录表；整体坏值（不是对象 / 是数组）当作空表，并只告警一次。
   *
   * 为什么返回 undefined 而不是空对象：调用方要能区分「没有这张表」
   * 与「有表但这次查不到这个 serial」—— 前者一律没有记录，
   * 后者可能是坏值（要告警）。语义分开后 warnOnce 的键才不会互相污染。
   */
  const readDeviceCwds = (): Record<string, string> | undefined => {
    const raw = store.get('deviceCwds')
    if (raw === undefined) return undefined
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      warnOnce(
        'device-cwds:not-object',
        '[settings] 设备目录记录不是对象：' + JSON.stringify(raw) + '，已忽略全部设备目录',
      )
      return undefined
    }
    return raw
  }

  const getDeviceCwd = (serial: string): string | undefined => {
    const key = serial.trim()
    // 没有序列号的设备不可能是记录来源（setDeviceCwd 也拒绝写），直接当作没有
    if (key === '') return undefined
    const map = readDeviceCwds()
    if (map === undefined) return undefined
    const stored: unknown = map[key]
    if (stored === undefined) return undefined
    if (typeof stored !== 'string') {
      warnOnce(
        'device-cwd:not-string:' + key,
        '[settings] 设备 ' + key + ' 的目录记录不是字符串：' + JSON.stringify(stored) + '，已忽略',
      )
      return undefined
    }
    if (stored === '') {
      warnOnce('device-cwd:empty:' + key, '[settings] 设备 ' + key + ' 的目录记录是空串，已忽略')
      return undefined
    }
    if (!isAbsolutePath(stored)) {
      warnOnce(
        'device-cwd:not-absolute:' + key,
        '[settings] 设备 ' + key + ' 的目录记录不是绝对路径：' + JSON.stringify(stored) + '，已忽略',
      )
      return undefined
    }
    return stored
  }

  const setDeviceCwd = (serial: string, cwd: string): void => {
    const key = serial.trim()
    const value = cwd.trim()
    // 设备没序列号：不产生垃圾键（也不告警 —— 无线调试短暂无序列号时会走到这里）
    if (key === '') return
    if (value === '') {
      warnOnce('device-cwd:set-empty:' + key, '[settings] 拒绝把空目录记为设备 ' + key + ' 的上次目录')
      return
    }
    if (!isAbsolutePath(value)) {
      warnOnce(
        'device-cwd:set-not-absolute:' + key,
        '[settings] 拒绝把非绝对路径记为设备 ' + key + ' 的上次目录：' + JSON.stringify(value),
      )
      return
    }
    // 读-改-写：保留其它设备的记录（裁决：key = 序列号，不设数量上限，永不淘汰）
    const map = readDeviceCwds() ?? {}
    store.set('deviceCwds', { ...map, [key]: value })
  }

  /**
   * 读自定义 scrcpy 参数。
   *
   * electron-store 的 schema 会把**类型错**的值（例如存成数字）清成 undefined，
   * 所以这里只剩「没设过」与「字符串」两种情况；仍然再判一次类型，
   * 因为 schema 校验的是写入时的手改文件，不是每次读取。
   */
  const getScrcpyArgs = (): string => {
    const stored = store.get('scrcpyArgs')
    // 没设过（首次启动 / 整个文件坏掉）→ 默认参数。这与「用户存了空串」是两件事，
    // 后者会命中下面的 typeof 分支并原样返回空串。
    if (stored === undefined) return deps.defaultScrcpyArgs
    if (typeof stored !== 'string') {
      warnOnce(
        'scrcpy-args:not-string',
        '[settings] 自定义投屏参数不是字符串：' + JSON.stringify(stored) + '，已按默认值处理',
      )
      return deps.defaultScrcpyArgs
    }
    return stored
  }

  const setScrcpyArgs = (raw: string): string => {
    const value = raw.trim()
    store.set('scrcpyArgs', value)
    return value
  }

  return {
    getDownloadDir,
    getDefaultDownloadDir: () => deps.defaultDownloadDir,
    setDownloadDir,
    resetDownloadDir: () => setDownloadDir(deps.defaultDownloadDir),
    getDeviceCwd,
    setDeviceCwd,
    getScrcpyArgs,
    getDefaultScrcpyArgs: () => deps.defaultScrcpyArgs,
    setScrcpyArgs,
    resetScrcpyArgs: () => setScrcpyArgs(deps.defaultScrcpyArgs),
    storagePath: () => store.path,
  }
}
