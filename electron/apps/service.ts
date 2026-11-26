import { statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { DeviceSession } from '../../src/shared/types'
import {
  clearDataCommand,
  classifyAppFailure,
  dumpsysPackageCommand,
  forceStopCommand,
  isSafePackageName,
  launchCommand,
  listAppsCommand,
  parseDumpsysPackage,
  parsePackageList,
  installPercent,
  installProgressChanged,
  installTempPath,
  parsePmPath,
  parsePmResult,
  parseRemoteFileSize,
  pmPathCommand,
  uninstallCommand,
  type InstallPhase,
  type InstallProgress,
  type AppDetail,
  type AppEntry,
} from '../../src/shared/apps'
import {
  E_ADB_NOT_FOUND,
  E_BAD_ARGS,
  E_DEVICE_OFFLINE,
  E_NO_PERMISSION,
  E_NO_SERIAL,
  E_NOT_FOUND,
  E_OP_FAILED,
  E_PROTECTED_PATH,
  toErrorCode,
} from '../../src/shared/errors'
import { shellQuote } from '../adb/shellsafe'
import type { ShellRunner } from '../fs/remote'
import { resolveLocalPath } from '../fs/local'

/**
 * 应用管理服务（P1 第二批）。
 *
 * ===== 为什么拉 APK 不走传输队列 =====
 * APK 的源路径在 /data/app/~~xxx==/base.apk，而传输队列的路径闸门
 * （src/shared/path-guard.ts 的 PROTECTED_REMOTE_SUBTREES）**拒绝 /data 整棵子树** ——
 * 那是为「渲染层传来的任意路径」设的安全边界，不能为了这个功能去放宽它。
 *
 * 所以这里直接在主进程发 adb pull。这**不降低**安全性，反而更高：
 *   - 源路径不是用户输入，而是 pm path 的输出（已经过 isSafePackageName 的包名推出）；
 *   - 目标目录由调用方给（设置里的下载目录），并且过 resolveLocalPath + stat 校验；
 *   - 渲染层无法指定任意远程路径 —— 它只能给一个包名。
 */

/** 应用管理依赖（全部注入，测试可用假 client）。 */
export interface AppsServiceDeps {
  devices: { get(serial: string): DeviceSession | undefined }
  clientFor: (serial: string) => ShellRunner
  adbPath: () => string
  /** 默认落地目录（设置里的默认下载路径）。 */
  defaultDstDir: () => string
  /** 时钟注入（临时 apk 名用；测试可固定）。 */
  now?: () => number
}

/** 推送进度的轮询间隔（毫秒）：300ms 在「够平滑」与「不压垮 adb」之间。 */
const POLL_INTERVAL_MS = 300

/** 一次命令的通用前置检查。 */
function precheck(session: DeviceSession | undefined): string | undefined {
  if (session === undefined) return E_NO_SERIAL
  if (session.status === 'device') return undefined
  if (session.status === 'unauthorized') return E_NO_PERMISSION
  return E_DEVICE_OFFLINE
}

/** 拉取一个 APK 的结果。 */
export interface PullApkResult {
  packageName: string
  /** 落到本地的文件（split APK 会有多个）。 */
  files: string[]
}

export class AppsService {
  /** 时钟（安装临时文件命名用；测试可注入固定值）。 */
  private readonly now: () => number

  constructor(private readonly deps: AppsServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** 列表：一条命令，避免逐包 dumpsys 把首屏拖死。 */
  async listApps(serial: string): Promise<AppEntry[]> {
    const client = this.ready(serial)
    const adb = this.deps.adbPath()
    const result = await client.run(['shell', listAppsCommand()], { adbPath: adb, timeoutMs: 30_000 })
    // 非零退出但仍有输出的情况在部分 ROM 上存在：先解析，解析不出再报错
    const entries = parsePackageList(result.stdout)
    if (entries.length === 0 && result.code !== 0) {
      throw new Error(classifyAppFailure(result.stderr, result.code))
    }
    return entries.sort((a, b) => a.packageName.localeCompare(b.packageName))
  }

  /** 详情：逐包 dumpsys（只在用户展开某个包时调）。 */
  async appDetail(serial: string, packageName: string): Promise<AppDetail> {
    const safe = this.readyPackage(packageName)
    const client = this.ready(serial)
    const adb = this.deps.adbPath()
    const result = await client.run(['shell', dumpsysPackageCommand(safe)], { adbPath: adb, timeoutMs: 30_000 })
    if (result.code !== 0 && result.stdout.trim() === '') {
      throw new Error(classifyAppFailure(result.stderr, result.code))
    }
    return parseDumpsysPackage(result.stdout, safe)
  }

  /**
   * 拉取 APK 到本地。
   *
   * split APK 会全部拉下来（一个 app 可能是 base + 若干 split，只拉 base 装不回去）。
   */
  async pullApk(serial: string, packageName: string, dstDir: string): Promise<PullApkResult> {
    const safe = this.readyPackage(packageName)
    const client = this.ready(serial)
    const adb = this.deps.adbPath()

    const target = await this.resolveDir(dstDir)
    const paths = await client.run(['shell', pmPathCommand(safe)], { adbPath: adb, timeoutMs: 30_000 })
    if (paths.code !== 0) throw new Error(classifyAppFailure(paths.stderr, paths.code))
    const apks = parsePmPath(paths.stdout)
    if (apks.length === 0) throw new Error(E_NOT_FOUND)

    await mkdir(target, { recursive: true })
    const files: string[] = []
    for (const remote of apks) {
      const local = path.join(target, safe + '-v' + Date.now() + '-' + path.basename(remote))
      /*
       * adb pull 的源是设备侧路径，必须经 shellQuote？不是 —— 这里走的是 adb 自己的
       * pull 参数（不是 shell 解释），路径作为独立 argv 元素传给 adb，
       * 所以不需要 shell 转义，也不会被 shell 解析。
       */
      const pulled = await client.run(['pull', remote, local], { adbPath: adb, timeoutMs: 300_000 })
      if (pulled.code !== 0) throw new Error(classifyAppFailure(pulled.stderr, pulled.code))
      files.push(local)
    }
    return { packageName: safe, files }
  }

  /**
   * 安装本地 APK —— 带真实进度。
   *
   * ===== 为什么不用 adb install =====
   * 实测：把 adb install 的 stdout/stderr 都接成管道，全程只有最后一行 Success，
   * 没有百分比、没有字节数。它内部走 streamed install，既不落设备可见文件，
   * 也不输出中间态 —— 想显示真进度，只能自己拆成两步：
   *
   *   1. adb push 到 /data/local/tmp（设备侧文件大小会持续增长，
   *      轮询 stat -c %s 就是真实字节进度）；
   *   2. pm install -r <那个路径>（这一步设备不给中间输出，显示不确定态，
   *      但用户知道已经在装了，而不是卡住）。
   *
   * ===== 失败与清理 =====
   * push 失败（存储满 / 目录只读）直接把错误码抛给界面，不静默失败；
   * 装完无论成败都会删设备上的临时 apk（finally），失败路径也不留垃圾。
   */
  async installApk(
    serial: string,
    apkPath: string,
    onProgress?: (payload: InstallProgress) => void,
  ): Promise<void> {
    const client = this.ready(serial)
    const adb = this.deps.adbPath()
    const access = await resolveLocalPath(apkPath)
    if (!access.ok) throw new Error(access.code)
    let size = 0
    try {
      const info = statSync(access.path)
      if (!info.isFile()) throw new Error(E_BAD_ARGS)
      size = info.size
    } catch (err) {
      if (err instanceof Error && err.message === E_BAD_ARGS) throw err
      throw new Error(E_NOT_FOUND)
    }
    if (size === 0) throw new Error(E_BAD_ARGS)

    /*
     * 推给界面前先节流：推送阶段每 300ms 轮询一次，而 stat 拿到的字节数
     * 多数时候不会让百分比进位 —— 不挡的话渲染层每秒重渲染 3 次。
     */
    let lastPushed: InstallProgress | null = null
    const report = (phase: InstallPhase, doneBytes: number): void => {
      if (onProgress === undefined) return
      const next: InstallProgress = {
        serial,
        phase,
        apkName: path.basename(access.path),
        doneBytes,
        totalBytes: size,
        percent: installPercent(phase, doneBytes, size),
      }
      if (!installProgressChanged(lastPushed, next)) return
      lastPushed = next
      onProgress(next)
    }

    report('preparing', 0)
    const stamp = (this.now ?? (() => Date.now()))()
    const remote = installTempPath(stamp, serial)
    let pushed = false
    try {
      // 1) 推送：起 push 后轮询设备侧文件大小（唯一能拿到真实字节进度的办法）
      report('pushing', 0)
      const pushPromise = client.run(['push', access.path, remote], { adbPath: adb, timeoutMs: 600_000 })
      const pollStop = this.pollPushSize(client, adb, remote, size, (done) => { report('pushing', done) })
      const pushResult = await pushPromise
      pollStop()
      if (pushResult.code !== 0) throw new Error(classifyAppFailure(pushResult.stderr, pushResult.code))
      pushed = true
      report('pushing', size)

      // 2) 安装：设备不给中间输出，只能显示不确定态
      report('installing', size)
      const installed = await client.run(['shell', 'pm install -r ' + shellQuote(remote)], {
        adbPath: adb,
        timeoutMs: 300_000,
      })
      const parsed = parsePmResult(installed.stdout + installed.stderr)
      if (!parsed.ok) throw new Error(classifyAppFailure(parsed.reason, installed.code))
      report('done', size)
    } finally {
      // 无论成败都删临时 apk：留着会让 /data/local/tmp 无限增长，
      // 而那里的文件用户既看不见也想不到去清。删不掉只记日志。
      if (pushed) {
        try {
          await client.run(['shell', 'rm -f ' + shellQuote(remote)], { adbPath: adb, timeoutMs: 30_000 })
        } catch {
          console.warn('[apps] 安装临时 apk 清理失败：' + remote)
        }
      }
    }
  }

  /**
   * 轮询设备侧文件大小并把百分比变化推给回调。
   *
   * @returns 停止函数（push 结束必须调用，否则定时器会一直跑）
   */
  private pollPushSize(
    client: ShellRunner,
    adb: string,
    remote: string,
    total: number,
    onSize: (doneBytes: number) => void,
  ): () => void {
    let stopped = false
    let lastPercent = -1
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const result = await client.run(
          ['shell', 'stat -c %s ' + shellQuote(remote)],
          { adbPath: adb, timeoutMs: 10_000 },
        )
        const size = parseRemoteFileSize(result.stdout)
        if (size !== undefined) {
          const percent = installPercent('pushing', size, total)
          // 只在百分比真的变了才推：每次 stat 都推会让渲染层每 300ms 重渲染一次
          if (percent !== lastPercent) {
            lastPercent = percent
            onSize(Math.min(size, total))
          }
        }
      } catch {
        // 文件还没出现（push 刚起）或设备忙：下一轮再试，不算失败
      }
      if (stopped) return
      timer = setTimeout(() => { void tick() }, POLL_INTERVAL_MS)
    }
    void tick()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** 强制停止。 */
  async forceStop(serial: string, packageName: string): Promise<void> {
    await this.runSimple(serial, packageName, forceStopCommand, 'am')
  }

  /** 启动。 */
  async launch(serial: string, packageName: string): Promise<void> {
    await this.runSimple(serial, packageName, launchCommand, 'monkey')
  }

  /** 清空数据（不可撤销，界面必须先二次确认）。 */
  async clearData(serial: string, packageName: string): Promise<void> {
    await this.runPm(serial, packageName, clearDataCommand)
  }

  /** 卸载（不可撤销，界面必须先二次确认）。 */
  async uninstall(serial: string, packageName: string): Promise<void> {
    await this.runPm(serial, packageName, uninstallCommand)
  }

  /* ============ 内部 ============ */

  /** 前置检查并返回 client（设备不在线就没有 client）。 */
  private ready(serial: string): ShellRunner {
    const blocked = precheck(this.deps.devices.get(serial))
    if (blocked !== undefined) throw new Error(blocked)
    if (this.deps.adbPath() === '') throw new Error(E_ADB_NOT_FOUND)
    return this.deps.clientFor(serial)
  }

  /** 包名闸门：畸形包名绝不拼进命令。 */
  private readyPackage(packageName: string): string {
    if (!isSafePackageName(packageName)) throw new Error(E_BAD_ARGS)
    return packageName
  }

  /** 目录闸门：必须存在且是目录。 */
  private async resolveDir(dir: string): Promise<string> {
    const chosen = dir === '' ? this.deps.defaultDstDir() : dir
    if (chosen.trim() === '') throw new Error(E_BAD_ARGS)
    const access = await resolveLocalPath(chosen)
    if (!access.ok) throw new Error(access.code)
    try {
      if (!statSync(access.path).isDirectory()) throw new Error(E_PROTECTED_PATH)
    } catch (err) {
      if (err instanceof Error && err.message === E_PROTECTED_PATH) throw err
      throw new Error(E_NOT_FOUND)
    }
    return access.path
  }

  /** am / monkey 这类「只看退出码」的命令。 */
  private async runSimple(
    serial: string,
    packageName: string,
    build: (pkg: string) => string,
    kind: 'am' | 'monkey',
  ): Promise<void> {
    const safe = this.readyPackage(packageName)
    const client = this.ready(serial)
    const adb = this.deps.adbPath()
    const result = await client.run(['shell', build(safe)], { adbPath: adb, timeoutMs: 30_000 })
    /*
     * monkey 的成败看输出里的 injected 计数：退出码 0 但没有 Events injected
     * 意味着「没找到可启动的 Activity」（应用没装 / 没有 LAUNCHER 入口）。
     * 把它当成功会让用户以为点了启动但屏幕上什么也没发生。
     */
    if (kind === 'monkey') {
      if (result.code !== 0 || !/Events injected:\s*\d+/i.test(result.stdout)) {
        const reason = /No activities found|monkey aborted/i.test(result.stdout + result.stderr)
          ? 'NO_LAUNCHER_ACTIVITY'
          : undefined
        throw new Error(reason === 'NO_LAUNCHER_ACTIVITY' ? E_NOT_FOUND : classifyAppFailure(reason, result.code))
      }
      return
    }
    if (result.code !== 0) throw new Error(classifyAppFailure(result.stderr, result.code))
  }

  /** pm 这类「成败写在 stdout」的命令。 */
  private async runPm(
    serial: string,
    packageName: string,
    build: (pkg: string) => string,
  ): Promise<void> {
    const safe = this.readyPackage(packageName)
    const client = this.ready(serial)
    const adb = this.deps.adbPath()
    const result = await client.run(['shell', build(safe)], { adbPath: adb, timeoutMs: 60_000 })
    const parsed = parsePmResult(result.stdout + result.stderr)
    if (!parsed.ok) {
      const code = classifyAppFailure(parsed.reason, result.code)
      throw new Error(code === E_OP_FAILED && result.code === 0 ? E_OP_FAILED : code)
    }
  }
}

/** 把任意异常收敛成错误码（与其它服务同一出口）。 */
export function appsErrorCode(err: unknown): string {
  return toErrorCode(err)
}
