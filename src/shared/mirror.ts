/**
 * 投屏（scrcpy 嵌入窗口）的共享类型与纯函数。
 *
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块，
 * 也不得出现 Electron / adb 的具体实现 —— 这里只有「拼参数」与「判定」。
 */

/**
 * scrcpy 窗口标题前缀。
 *
 * 嵌入方靠它精确定位 HWND（见 electron/mirror/embed.ts 的 EnumWindows）。
 * 标题里必须带**唯一 token**，否则两台设备同时投屏时会认错窗口 ——
 * 认错的后果是把 A 设备的画面塞进 B 设备的投屏窗口。
 */
export const SCRCPY_WINDOW_PREFIX = 'adbfm-scrcpy-'

/** 默认最大分辨率（设备侧先缩放到这个长边再送 PC，降低解码与带宽压力）。 */
export const DEFAULT_MAX_SIZE = 1024

/**
 * 可选的最大分辨率档位。
 *
 * 1024 是默认值：这个尺寸在 1080p 屏幕上单窗口显示清晰，
 * 又不至于让 4K 原图把解码线程压满。
 */
export const MAX_SIZE_OPTIONS = [720, 1024, 1280, 1920] as const

/**
 * 一台设备的投屏会话。
 *
 * 放在 shared 而不是 electron/mirror/service.ts：渲染层的 DshApi 要引用它，
 * 而渲染层不能 import 主进程目录（tsconfig 的 app 工程不含 electron/）。
 */
export interface MirrorSession {
  serial: string
  /** 子进程 pid（极早期退出时可能为 undefined）。 */
  pid: number | undefined
  /** 会话建立时刻（毫秒）。 */
  startedAt: number
  /** 窗口标题里的唯一 token（EnumWindows 靠它定位 HWND）。 */
  token: string
  /** scrcpy 来源与版本，供界面/日志显示。 */
  source: 'bundled' | 'path'
  version: string
  /** 显示名（型号 + serial 尾号）。 */
  title: string
}

/** 会话变化事件（主进程 → 渲染层）。 */
export type MirrorEvent =
  | { kind: 'started'; session: MirrorSession }
  | { kind: 'exited'; serial: string; code: number | null }
  | { kind: 'failed'; serial: string; code: string }

/** 拼 scrcpy 命令行参数所需的输入。 */
export interface ScrcpyArgsInput {
  /** 设备序列号。**每条 scrcpy 命令都必须带 -s**，与 adb 调用同一条红线。 */
  serial: string
  /** 本窗口的唯一 token（由调用方生成，如 serial 尾号 + 时间戳）。 */
  token: string
  /** 最大分辨率（长边像素）。 */
  maxSize: number
}

/**
 * 拼 scrcpy 命令行参数。
 *
 * 刻意**不加** `--render-driver`：spike 实测（docs/superpowers/spike/scrcpy-embed-result.md）
 * 默认 d3d11 在真子窗口下画面正常，多一个开关就多一个「换台机器就黑屏」的变量。
 *
 * 刻意加 `--no-audio`：本功能不涉及声音，少一个线程模型变量，
 * 也避免与设备的音频焦点打架。
 */
export function buildScrcpyArgs(input: ScrcpyArgsInput): string[] {
  return [
    '-s',
    input.serial,
    '--window-borderless',
    '--window-title=' + SCRCPY_WINDOW_PREFIX + input.token,
    '--no-audio',
    '--max-size=' + String(input.maxSize),
  ]
}

/**
 * 投屏窗口的显示名：型号 + serial 后 4 位。
 *
 * 为什么带后 4 位：同事的机器与自己的机器型号相同是常态，
 * 只显示型号的话任务栏里两个窗口长得一模一样。
 */
export function mirrorTitleOf(device: { serial: string; model?: string }): string {
  const tail = device.serial.slice(-4)
  const name = device.model !== undefined && device.model !== '' ? device.model : '设备'
  return name + ' (' + tail + ')'
}

/**
 * 把 scrcpy 的 stderr 收敛成错误码。
 *
 * 只认两条最关键的失败形态（其余一律归为启动失败）：
 * 认不出设备、找不到 adb。前者用户能自己修（插线/授权），
 * 后者的修法是装 scrcpy 或配 PATH —— 两者给同一句「启动失败」等于把用户堵死。
 */
export function classifyScrcpyFailure(stderr: string): string {
  if (/Could not find any ADB device|Could not find ADB device/i.test(stderr)) return 'E_DEVICE_OFFLINE'
  if (/Could not start adb server|Command not found: \[.*adb/i.test(stderr)) return 'E_SCRCPY_NO_ADB'
  return 'E_MIRROR_START_FAILED'
}
