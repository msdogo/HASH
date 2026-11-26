import {
  E_NO_PERMISSION,
  E_NOT_FOUND,
  E_OP_FAILED,
  E_SYNC_FAILED,
  E_TIMEOUT,
  type ErrorCode,
} from './errors'
import { sanitizeSerial } from './capture'

/**
 * 应用管理的共享类型与纯函数（P1 第二批）。
 *
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块。
 *
 * 为什么解析全部集中在这里：pm list packages / dumpsys package / pm path 的输出
 * 在各厂商 ROM 上差异很大，而解析错了的后果是「用户看到错误的版本号」
 * 「卸载了错的应用」这类不可逆事故。写成纯函数并用真机样本做 fixture，
 * 改坏就红 —— 这是唯一守得住的地方。
 */

/** 列表里的一行（列表页只需这些字段，版本名要逐包 dumpsys，不在这里拿）。 */
export interface AppEntry {
  packageName: string
  /**
   * versionCode。
   *
   * 0 是合法值：真机实测 com.tjh.uav.normal.test 返回 versionCode:0。
   * 不能把 0 当成缺失再显示成 —，那会让用户以为这个包没有版本号。
   */
  versionCode: number
}

/** 详情（展开某个包时才查，每个包一条 dumpsys）。 */
export interface AppDetail {
  packageName: string
  /** 版本名；ROM 没给就是 undefined，界面显示 —，绝不编造。 */
  versionName: string | undefined
  versionCode: number | undefined
  /** 首次安装 / 最后更新时间（毫秒）；解析不出就是 undefined。 */
  firstInstallMs: number | undefined
  lastUpdateMs: number | undefined
  /** 是否为可清除数据的第三方应用（flags 里有 ALLOW_CLEAR_USER_DATA）。 */
  allowClearData: boolean
}

/** 一条 pm list packages 输出的形状。 */
const LIST_RE = /^package:(\S+?)(?:\s+versionCode:(\d+))?$/

/**
 * 解析 pm list packages [-3] [--show-versioncode]。
 *
 * 两种形态都要认：
 *   package:com.foo
 *   package:com.foo versionCode:35
 * 认不出的行直接跳过（不是整批失败）：ROM 会往里塞各种额外字段，
 * 一行怪格式不该让用户看不到其余 200 个应用。
 */
export function parsePackageList(text: string): AppEntry[] {
  const out: AppEntry[] = []
  const seen = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const matched = LIST_RE.exec(line)
    if (matched === null) continue
    const packageName = matched[1]
    if (packageName === undefined || packageName === '') continue
    // 同一个包出现两次时保留第一条（去重但不静默改顺序）
    if (seen.has(packageName)) continue
    seen.add(packageName)
    const rawCode = matched[2]
    const code = rawCode === undefined ? 0 : Number.parseInt(rawCode, 10)
    out.push({ packageName, versionCode: Number.isFinite(code) ? code : 0 })
  }
  return out
}
/*
 * dumpsys 里的字段。真机样本（Android 11 / SDK 30）：
 *
 *     pkg=Package{daa6f7a com.tjh.uav.normal}
 *     codePath=/data/app/~~l7hG2.../com.tjh.uav.normal-_T4...==
 *     versionCode=35 minSdk=24 targetSdk=34
 *     versionName=2.1.2.beta3
 *     flags=[ DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA TEST_ONLY ALLOW_BACKUP LARGE_HEAP ]
 *     firstInstallTime=2026-11-06 11:47:27
 *     lastUpdateTime=2026-11-24 16:00:58
 *
 * 注意 versionCode 与 minSdk 在同一行：只取等号后的第一个数字，
 * 不能整行 parseInt（那会把 minSdk 之类也读进来）。
 */
const VERSION_CODE_RE = /^\s*versionCode=(\d+)/m
const VERSION_NAME_RE = /^\s*versionName=(\S+)/m
const FIRST_INSTALL_RE = /^\s*firstInstallTime=(.+)$/m
const LAST_UPDATE_RE = /^\s*lastUpdateTime=(.+)$/m
const FLAGS_RE = /^\s*flags=\[(.*?)\]/m

/**
 * 解析 dumpsys package <pkg>。
 *
 * 所有字段都是「解析得到就有，得不到就 undefined」——绝不编造默认值。
 * 一个假的 versionName 比一个 — 危险得多：用户会照着它判断装的是哪个版本。
 */
export function parseDumpsysPackage(text: string, packageName: string): AppDetail {
  const versionCode = Number.parseInt(VERSION_CODE_RE.exec(text)?.[1] ?? '', 10)
  const versionName = VERSION_NAME_RE.exec(text)?.[1]?.trim()
  const flags = FLAGS_RE.exec(text)?.[1] ?? ''
  return {
    packageName,
    versionName: versionName === undefined || versionName === '' ? undefined : versionName,
    versionCode: Number.isFinite(versionCode) ? versionCode : undefined,
    firstInstallMs: parseDumpsysTime(FIRST_INSTALL_RE.exec(text)?.[1]),
    lastUpdateMs: parseDumpsysTime(LAST_UPDATE_RE.exec(text)?.[1]),
    allowClearData: /\bALLOW_CLEAR_USER_DATA\b/.test(flags),
  }
}

/**
 * 把 dumpsys 的时间（2026-11-06 11:47:27）转成毫秒。
 *
 * 手动拆字段并按本地时间构造：new Date('2026-11-06 11:47:27') 这种带空格的形态
 * 在各引擎里解析行为不一致，有的当 UTC、有的当本地。dumpsys 给的是设备本地时间。
 * 解析不出返回 undefined，绝不用 0 或当前时间兜底。
 */
export function parseDumpsysTime(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const matched = /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(raw)
  if (matched === null) return undefined
  const [, y, mo, d, h, mi, s] = matched
  const value = new Date(
    Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s),
  ).getTime()
  return Number.isFinite(value) ? value : undefined
}

/**
 * 解析 pm path <pkg>。
 *
 * 一个 app 可能有多个 apk（split APK / AAB 安装），所以返回数组而不是单值。
 * 只认 package: 前缀；其余行忽略。
 */
export function parsePmPath(text: string): string[] {
  const out: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('package:')) continue
    const apkPath = line.slice('package:'.length).trim()
    if (apkPath === '') continue
    out.push(apkPath)
  }
  return out
}
/* ============ 命令构造（唯一副本，全部在这里） ============ */

/** 列出第三方应用（带 versionCode，避免逐包 dumpsys）。 */
export function listAppsCommand(): string {
  return 'pm list packages -3 --show-versioncode'
}

/** 查一个包的详情。 */
export function dumpsysPackageCommand(packageName: string): string {
  return 'dumpsys package ' + packageName
}

/** 查一个包的 apk 路径（可能多条）。 */
export function pmPathCommand(packageName: string): string {
  return 'pm path ' + packageName
}

/** 启动应用（不需要知道 Activity 名，monkey 会用 LAUNCHER 意图）。 */
export function launchCommand(packageName: string): string {
  return 'monkey -p ' + packageName + ' -c android.intent.category.LAUNCHER 1'
}

/** 强制停止。 */
export function forceStopCommand(packageName: string): string {
  return 'am force-stop ' + packageName
}

/**
 * 卸载。
 *
 * 只用最保守的 pm uninstall：带 --user 0 的形态在部分 ROM 上反而失败，
 * 而多用户场景在本产品里并不成立（我们只管当前用户看到的应用）。
 */
export function uninstallCommand(packageName: string): string {
  return 'pm uninstall ' + packageName
}

/** 清空应用数据（不可撤销）。 */
export function clearDataCommand(packageName: string): string {
  return 'pm clear ' + packageName
}

/**
 * 包名是否形如一个合法的 Android 包名。
 *
 * 这条闸门在 packet 拼进 shell 命令之前跑：包名来自 --show-versioncode 的输出，
 * 理论上不会脏，但「理论上」挡不住一个畸形的 ROM 输出拼出奇怪命令。
 */
export function isSafePackageName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value)
}

/* ============ 结果判定 ============ */

/**
 * 解析 pm uninstall / pm clear / pm install 的成败。
 *
 * 必须看 stdout：这几个命令失败时经常仍返回退出码 0，
 * 只在输出里写 Failure [DELETE_FAILED_INTERNAL_ERROR]。
 * 既没有 Success 也没有 Failure 的情况一律判失败 —— 「不知道」不能当成功。
 */
export function parsePmResult(text: string): { ok: boolean; reason: string | undefined } {
  const trimmed = text.trim()
  if (/^Success/m.test(trimmed)) return { ok: true, reason: undefined }
  const failure = /Failure\s*\[([^\]]+)\]/.exec(trimmed)
  if (failure !== null) return { ok: false, reason: failure[1] }
  if (/^Exception|^Error/i.test(trimmed)) return { ok: false, reason: trimmed.split(/\r?\n/)[0] }
  return { ok: false, reason: trimmed === '' ? undefined : trimmed.split(/\r?\n/)[0] }
}

/** 把 pm / am 的失败原因翻成错误码。认不出就 E_OP_FAILED，绝不编一个成功。 */
export function classifyAppFailure(reason: string | undefined, code: number | null): ErrorCode {
  const text = (reason ?? '').toUpperCase()
  if (text.includes('DELETE_FAILED_INTERNAL_ERROR')) return E_OP_FAILED
  if (text.includes('PERMISSION') || text.includes('SECURITYEXCEPTION')) return E_NO_PERMISSION
  /*
   * 真机文案是 "not installed for 0"（空格分隔），而部分 ROM 写成 NOT_INSTALLED。
   * 两种都要认 —— 只认下划线形态会让「包已不存在」被报成笼统的传输失败，
   * 用户据此会以为是网络问题而去重试。
   */
  if (text.includes('NOT_INSTALLED') || text.includes('NOT INSTALLED') || text.includes('UNKNOWN PACKAGE')) return E_NOT_FOUND
  if (code === null) return E_TIMEOUT
  return E_SYNC_FAILED
}

/* ============ 危险动作 ============ */

/** 应用管理的六个动作。 */
export type AppAction = 'pullApk' | 'installApk' | 'forceStop' | 'clearData' | 'uninstall' | 'launch'

/**
 * 是否必须先二次确认。
 *
 * 清数据与卸载都会不可逆地毁掉用户的东西：前者抹掉登录态与本地文件，
 * 后者直接让应用消失。其余四个都可撤销或无害（强停还能重开）。
 */
export function needsConfirm(action: AppAction): boolean {
  return action === 'clearData' || action === 'uninstall'
}


/* ============ 安装进度（真实百分比，不编造） ============ */

/**
 * 安装的三个阶段。
 *
 * 为什么要分阶段而不是一个百分比：adb install 的进度**拿不到** ——
 * 它内部走 streamed install，既不写设备上的可见文件，也不在管道模式下输出百分比
 * （实测：把 stdout/stderr 都接成管道，只有最后一行 Success）。
 *
 * 所以这里改成「先 push 再 pm install」两步：
 *   - push 阶段可以让设备侧文件大小持续增长，轮询 stat -c %s 就能算出**真实**字节进度；
 *   - pm install 阶段设备不给任何中间输出，只能显示不确定态 —— 但那时文件已经在设备上，
 *     用户至少知道「已经在装了」而不是「卡住了」。
 */
export type InstallPhase = 'preparing' | 'pushing' | 'installing' | 'done'

/** 推送到设备时的落点（pm install 支持从文件路径安装）。 */
export const INSTALL_TEMP_DIR = '/data/local/tmp'

/** 推送阶段在总进度里占的比重（剩下的留给 install）。 */
export const PUSH_SHARE = 90

/** 安装进度事件（主进程 → 渲染层）。 */
export interface InstallProgress {
  serial: string
  phase: InstallPhase
  /**
   * 本地 apk 文件名（不含目录）。
   *
   * 为什么进度事件要带它：日志行必须能说「正在安装 doubao.apk」而不是
   * 「正在安装」—— 用户可能连着装好几个包，只有文件名能对上手里那个文件。
   */
  apkName: string
  /** 已推送字节；只有 pushing 阶段有意义。 */
  doneBytes: number
  /** apk 总字节；未知时为 0。 */
  totalBytes: number
  /** 0–100；installing 阶段固定 90，done 为 100。 */
  percent: number
}

/** 设备上的临时 apk 路径（每台设备各自一份，避免并发装包互相覆盖）。 */
export function installTempPath(stamp: number, serial: string): string {
  return INSTALL_TEMP_DIR + '/adbfm-install-' + String(stamp) + '-' + sanitizeSerial(serial) + '.apk'
}

/**
 * 解析 `stat -c %s <file>` 的输出。
 *
 * 设备上如果文件还没出现，stat 会报错并返回非数字 —— 返回 undefined，
 * 调用方保持上一次的进度，不要把它当成 0 让进度条回跳。
 */
export function parseRemoteFileSize(text: string): number | undefined {
  const matched = /^\s*(\d+)\s*$/m.exec(text)
  if (matched === null) return undefined
  const value = Number.parseInt(matched[1] as string, 10)
  return Number.isFinite(value) ? value : undefined
}

/**
 * 按阶段与字节数算总百分比。
 *
 * total 为 0 / 负数（拿不到大小）时推送阶段固定 0，绝不假造一个中间值 ——
 * 一个乱跳的进度条比一条「正在安装…」更让人怀疑。
 */
export function installPercent(phase: InstallPhase, doneBytes: number, totalBytes: number): number {
  if (phase === 'done') return 100
  if (phase === 'installing') return PUSH_SHARE
  if (phase === 'preparing') return 0
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0
  const ratio = Math.min(1, Math.max(0, doneBytes / totalBytes))
  return Math.round(ratio * PUSH_SHARE)
}


/* ============ 安装任务在底栏（日志栏）里的展示 ============ */

/** 底栏里一条安装任务的阶段文案 key（状态必须能一眼看出来，不能只给个百分比）。 */
export function installPhaseKey(phase: InstallPhase): string {
  return 'apps.phase.' + phase
}


/** 两个进度之间是否值得推一次（节流：只在百分比或阶段变化时推送）。 */
export function installProgressChanged(a: InstallProgress | null, b: InstallProgress): boolean {
  if (a === null) return true
  return a.phase !== b.phase || a.percent !== b.percent
}

/** 详情里「版本」一列的展示文本：没有就 —，不编造。 */
export function versionLabel(detail: AppDetail | undefined): string {
  if (detail === undefined) return '—'
  if (detail.versionName !== undefined && detail.versionName !== '') return detail.versionName
  if (detail.versionCode !== undefined) return String(detail.versionCode)
  return '—'
}
