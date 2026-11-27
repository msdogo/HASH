import type { DeviceSession } from '../../src/shared/types'
import {
  E_ADB_NOT_FOUND,
  E_MIRROR_START_FAILED,
  E_NO_SERIAL,
  E_SCRCPY_NOT_FOUND,
} from '../../src/shared/errors'
import {
  DEFAULT_MAX_SIZE,
  DEFAULT_SCREEN,
  buildScrcpyArgs,
  classifyScrcpyFailure,
  mirrorTitleOf,
  type ScreenSize,
} from '../../src/shared/mirror'
import type { ScrcpyLocation } from './binary'
import type { ScrcpyHandle } from './runner'

/**
 * 投屏会话与会话表（主进程唯一事实源）。
 *
 * ===== 为什么会话表在这里，而不是渲染层 =====
 * 「这台设备是否在投屏」必须由一个**只有一份**的地方说了算：
 * 渲染层可能有多个窗口（主窗口 + 多个投屏窗口），各自记一份必然漂移，
 * 最终表现是「关掉窗口后还显示投屏中」或「重复点开出两个 scrcpy」。
 */

/** 一台设备的投屏会话。 */
export interface MirrorSession {
  serial: string
  /** 子进程 pid（可能为 undefined：极早期就退出的进程拿不到）。 */
  pid: number | undefined
  /** 会话建立时刻（毫秒），用于界面显示时长。 */
  startedAt: number
  /** 窗口标题里的唯一 token（EnumWindows 靠它定位 HWND）。 */
  token: string
  /** scrcpy 来源与版本，供界面/日志显示。 */
  source: 'bundled' | 'path'
  version: string
  /** 显示名（型号 + serial 尾号）。 */
  title: string
  /**
   * 启动前探测到的屏幕尺寸（已按旋转方向）。
   *
   * 投屏窗口据此**一次性**建出正确比例，避免「先竖后横」的跳变。
   * 探测失败时是 DEFAULT_SCREEN —— 那种情况下退化成旧行为，不影响功能。
   */
  screen: ScreenSize
}

/** 会话变化事件（推给渲染层）。 */
export type MirrorEvent =
  | { kind: 'started'; session: MirrorSession }
  | { kind: 'exited'; serial: string; code: number | null }
  | { kind: 'failed'; serial: string; code: string }

/** 起进程的最小面（生产是 startScrcpy，测试注入假实现）。 */
export type SpawnScrcpy = (input: {
  scrcpyPath: string
  adbPath: string
  args: readonly string[]
}) => ScrcpyHandle | null

export interface MirrorServiceDeps {
  /** 设备会话表。 */
  devices: { get(serial: string): DeviceSession | undefined }
  /** 已解析出的 adb 绝对路径；空串表示还没定位到。 */
  adbPath: () => string
  /** scrcpy 定位（异步，每次现查 —— 用户可能中途装了）。 */
  locate: () => Promise<ScrcpyLocation>
  /** 起进程。 */
  spawn: SpawnScrcpy
  /**
   * 探测设备屏幕尺寸（决定投屏窗口一开出来是横的还是竖的）。
   *
   * 可缺省：缺省就不探，窗口退回「先按默认尺寸建、量到视频后再改」的旧行为。
   * 之所以做成可选而不是必填，是为了让既有测试不必全部补桩 ——
   * 但生产（electron/main.ts）必须传，否则「先竖后横」的跳变会回来。
   */
  probeScreen?: (serial: string, adbPath: string) => Promise<ScreenSize>
  /** 推事件给渲染层。 */
  emit: (event: MirrorEvent) => void
  /** 时间源（注入以便测试确定 startedAt）。 */
  now?: () => number
}

/** IPC 层引用的别名（与 capture/apps 的 *Controller 命名保持一致的读法）。 */
export type MirrorController = MirrorService

export interface MirrorService {
  /** 开始投屏；已在投屏则直接返回已有会话（幂等，不 spawn 第二个）。 */
  start(serial: string): Promise<MirrorSession>
  /** 结束投屏；没有会话时是安全空操作。 */
  stop(serial: string): Promise<void>
  /** 当前全部会话（按开始时间排序）。 */
  list(): MirrorSession[]
  /** 设备表变化时调用：掉线/移除的设备自动结束会话。 */
  onDeviceChanged(batch: { changed?: readonly DeviceSession[]; removed?: readonly string[] }): Promise<void>
  /** 应用退出时全部结束（before-quit 接线）。 */
  dispose(): Promise<void>
}

/** 生成窗口标题用的唯一 token。 */
function makeToken(serial: string, now: number): string {
  /*
   * 为什么带时间戳：同一台设备关了再开，旧窗口可能还在销毁过程中，
   * 纯 serial 派生的标题会让新进程认到旧 HWND 上。时间戳把两者分开。
   */
  const tail = serial.replace(/[^A-Za-z0-9]/g, '').slice(-6)
  return tail + '-' + String(now)
}

/**
 * 投屏服务。
 *
 * 生命周期三条铁律：
 *   1. 一台设备最多一个会话（重复 start 幂等返回）；
 *   2. 子进程自己退出（用户关窗口 / 崩溃）→ 清理会话 + 推事件，**不自动重启**；
 *   3. 应用退出 → dispose 全部 kill，不留孤儿（children.ts 的闸门是第二道保险）。
 */
export function createMirrorService(deps: MirrorServiceDeps): MirrorService {
  const sessions = new Map<string, { session: MirrorSession; handle: ScrcpyHandle }>()
  const now = deps.now ?? (() => Date.now())

  const remove = (serial: string): void => {
    sessions.delete(serial)
  }

  /** 统一收尾：杀进程 + 清会话（不推事件，由调用方决定推什么）。 */
  const shutdown = async (serial: string): Promise<void> => {
    const entry = sessions.get(serial)
    if (entry === undefined) return
    remove(serial)
    try {
      await entry.handle.kill()
    } catch {
      /*
       * 杀不掉也要清会话：留着会话会让这台设备永远无法再次投屏，
       * 而「进程还在」是 children.ts 的 shutdownChildren 兜底的事。
       */
    }
  }

  return {
    async start(serial: string): Promise<MirrorSession> {
      const existing = sessions.get(serial)
      // 幂等：已在投屏就返回已有会话（界面据此聚焦窗口，而不是报错）
      if (existing !== undefined) return existing.session

      const adb = deps.adbPath()
      if (adb === '') throw new Error(E_ADB_NOT_FOUND)

      const device = deps.devices.get(serial)
      if (device === undefined) throw new Error(E_NO_SERIAL)

      const located = await deps.locate()
      if (!located.ok) throw new Error(located.code === '' ? E_SCRCPY_NOT_FOUND : located.code)

      const startedAt = now()
      const token = makeToken(serial, startedAt)
      const args = buildScrcpyArgs({ serial, token, maxSize: DEFAULT_MAX_SIZE })

      /*
       * 先问方向，再起进程。
       *
       * 顺序不能反：窗口是收到 started 事件时建的（main.ts 的 emit），
       * 而建窗口要用这个尺寸。放在 spawn 之后探测，窗口已经建错了。
       *
       * 探测失败在这里拿到的就是 DEFAULT_SCREEN（probe 自己保证不 reject），
       * 所以下面不需要再判一次 —— 那只会写出永远不成立的死分支。
       */
      const screen = deps.probeScreen === undefined
        ? DEFAULT_SCREEN
        : await deps.probeScreen(serial, adb)

      const handle = deps.spawn({ scrcpyPath: located.path, adbPath: adb, args })
      if (handle === null) {
        /*
         * 闸门已关（应用正在退出）→ 按**启动失败**处理，不登记会话。
         *
         * 刻意不是 E_MIRROR_ACTIVE：那个码的意思是「这台设备已经在投屏了」，
         * 而这里的真相是「应用要关了，起不了新进程」。给错码会把用户引向
         * 「去关掉已有窗口」这条完全错误的动作。
         */
        throw new Error(E_MIRROR_START_FAILED)
      }

      const session: MirrorSession = {
        serial,
        pid: handle.pid,
        startedAt,
        token,
        source: located.source,
        version: located.version,
        title: mirrorTitleOf({ serial, model: device.model }),
        screen,
      }
      sessions.set(serial, { session, handle })
      deps.emit({ kind: 'started', session })

      /*
       * 子进程退出 → 清会话 + 推事件。
       *
       * 注意这里**不判 code 是否为 0**：用户正常关窗口（code 0）
       * 与崩溃（非 0）对界面是同一件事 —— 投屏结束了。
       * 区别在于崩溃时把 stderr 分类结果带上，让用户看到原因。
       */
      handle.onExit((code) => {
        // 已经主动 stop 掉的会话不会走到这里（sessions 里已无此项）
        if (!sessions.has(serial)) return
        remove(serial)
        if (code === null || code !== 0) {
          const classified = classifyScrcpyFailure(handle.stderrSoFar())
          deps.emit({ kind: 'failed', serial, code: classified })
        } else {
          deps.emit({ kind: 'exited', serial, code })
        }
      })

      return session
    },

    async stop(serial: string): Promise<void> {
      await shutdown(serial)
    },

    list(): MirrorSession[] {
      return [...sessions.values()]
        .map((e) => e.session)
        .sort((a, b) => a.startedAt - b.startedAt)
    },

    async onDeviceChanged(batch): Promise<void> {
      const gone: string[] = [...(batch.removed ?? [])]
      for (const device of batch.changed ?? []) {
        if (device.status !== 'device') gone.push(device.serial)
      }
      for (const serial of gone) {
        if (!sessions.has(serial)) continue
        await shutdown(serial)
        deps.emit({ kind: 'exited', serial, code: null })
      }
    },

    async dispose(): Promise<void> {
      const serials = [...sessions.keys()]
      await Promise.all(serials.map((s) => shutdown(s)))
    },
  }
}
