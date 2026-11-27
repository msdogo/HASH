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
  /**
   * 启动前探测到的屏幕尺寸（已按旋转方向）。
   *
   * 投屏窗口据此**一次性**建出正确比例，避免「先竖后横」的跳变。
   * 探测失败时是 DEFAULT_SCREEN —— 那种情况下退化成旧行为，不影响功能。
   */
  screen: ScreenSize
}

/** 会话变化事件（主进程 → 渲染层）。 */
export type MirrorEvent =
  | { kind: 'started'; session: MirrorSession }
  | { kind: 'exited'; serial: string; code: number | null }
  | { kind: 'failed'; serial: string; code: string }

/** 侧边栏宽度（CSS 像素 = DIP；MirrorWindow.tsx 的 w-14 必须与它一致）。 */
export const SIDEBAR_WIDTH = 56

/** 顶栏高度（CSS 像素 = DIP；MirrorWindow.tsx 的 h-9 必须与它一致）。 */
export const HEADER_HEIGHT = 36

/** 矩形（物理像素）。 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 把「视频该占的区域」算出来：在可用区域里按视频宽高比居中。
 *
 * ===== 为什么必须按宽高比，而不是铺满 =====
 * 实机踩到的缺陷（见 docs/superpowers/spike/scrcpy-embed-production.md 第六节）：
 * 直接把 scrcpy 窗口 MoveWindow 成「可用区域那么大」，视频是 1024×640（16:10）而
 * 竖长的窗口是 424×900 —— scrcpy 会把它自己那层画布铺满窗口、视频居中留黑边，
 * 于是屏幕上下各出现一条巨大的黑带，用户以为投屏坏了。
 *
 * 正确做法：保持视频宽高比，在不超出可用区域的前提下尽量放大，然后居中。
 *
 * @param available 可用区域（不含顶栏与侧边栏），物理像素。
 * @param videoWidth 视频原始宽（scrcpy 窗口的初始宽度）。
 * @param videoHeight 视频原始高。
 */
export function fitRect(available: Rect, videoWidth: number, videoHeight: number): Rect {
  // 退化输入（0 或负数）直接回落到铺满，宁可留黑边也不要算出 NaN 让 MoveWindow 失败
  if (videoWidth <= 0 || videoHeight <= 0 || available.width <= 0 || available.height <= 0) {
    return available
  }
  const scale = Math.min(available.width / videoWidth, available.height / videoHeight)
  const width = Math.max(1, Math.round(videoWidth * scale))
  const height = Math.max(1, Math.round(videoHeight * scale))
  return {
    // 居中：两侧/上下平均分配剩余空间
    x: available.x + Math.floor((available.width - width) / 2),
    y: available.y + Math.floor((available.height - height) / 2),
    width,
    height,
  }
}

/**
 * 视频区在窗口里的位置（可用区域）。
 *
 * 三个减项都对应屏幕上真实存在的东西，少减一个就会被原生子窗口盖住：
 *   - 顶栏（HEADER_HEIGHT）：原生窗口永远画在渲染层之上，盖住顶栏会让
 *     「投屏中 / 关闭按钮」全部消失；
 *   - 侧边栏（SIDEBAR_WIDTH）：在**右侧**，所以只减宽度、x 从 0 开始；
 *   - 各乘以 scaleFactor：MoveWindow 要物理像素，Electron 给的是 DIP。
 */
export function availableRect(
  content: { width: number; height: number },
  scaleFactor: number,
): Rect {
  const scale = scaleFactor > 0 ? scaleFactor : 1
  const sidebar = Math.round(SIDEBAR_WIDTH * scale)
  const header = Math.round(HEADER_HEIGHT * scale)
  return {
    x: 0,
    y: header,
    width: Math.max(0, Math.round(content.width * scale) - sidebar),
    height: Math.max(0, Math.round(content.height * scale) - header),
  }
}

/**
 * 窗口内容区该多大（DIP），让画面**刚刚好**装下、不留黑边。
 *
 * ===== 为什么需要这一步（实机踩到的第三个缺陷）=====
 * 一开始窗口固定 480×900。而设备画面是 1024×640（16:10 横屏）——
 * 一个竖长的窗口装横屏画面，无论怎么居中，上下都会留出几百像素的黑带。
 * 实测截图里画面只占窗口中间约 1/3，看起来像「投屏只投了一小块」。
 *
 * 正确做法：窗口尺寸由视频尺寸决定。宽 = 视频宽 + 侧边栏，高 = 视频高 + 顶栏。
 * 这样默认打开就严丝合缝；用户拉窗口时再由 fitRect 居中（那时黑边是用户自己的选择）。
 *
 * @param maxHeight 屏幕可用高度的上限（DIP），防止 4K 设备把窗口撑出屏幕。
 */
export function windowFitSize(
  videoWidth: number,
  videoHeight: number,
  scaleFactor: number,
  maxHeight = 900,
): { width: number; height: number } {
  const scale = scaleFactor > 0 ? scaleFactor : 1
  // 退化输入 → 给一个能用的默认值，不要算出 0×0 的窗口（用户会以为程序没启动）
  if (videoWidth <= 0 || videoHeight <= 0) return { width: 420, height: 780 }

  // 视频换算到 DIP 后再加上顶栏/侧边栏
  let width = Math.round(videoWidth / scale) + SIDEBAR_WIDTH
  let height = Math.round(videoHeight / scale) + HEADER_HEIGHT

  // 太高就按比例缩回去（不能只压高度，否则画面被拉伸）
  if (height > maxHeight) {
    const ratio = maxHeight / height
    width = Math.round(width * ratio)
    height = maxHeight
  }
  // 太窄的窗口连六个按键都放不下（侧边栏 56 + 画面至少 120）
  const minWidth = SIDEBAR_WIDTH + 120
  if (width < minWidth) {
    const ratio = minWidth / width
    width = minWidth
    height = Math.round(height * ratio)
  }
  return { width, height }
}

/**
 * 屏幕尺寸（设备当前生效分辨率，与**旋转方向一致**）。
 *
 * 是旋转后的尺寸：设备横过来时 dumpsys 报 cur=1920x1200，
 * 而不是 Physical size 的 1200x1920。我们要的正是旋转后的那个 ——
 * 它决定了 scrcpy 送来的画面是横的还是竖的。
 */
export interface ScreenSize {
  width: number
  height: number
}

/**
 * 从 `adb shell dumpsys window displays` 的输出里解析当前分辨率。
 *
 * 为什么认 `cur=` 而不是 `init=` / `Physical size`：
 *   - `init=` 与 `Physical size` 不随旋转变化
 *     （实测 DJI RC Plus 2 恒报 1200x1920，即使设备已经横屏）；
 *   - `cur=` 才是当前生效的分辨率（同一台机器横屏时报 1920x1200）。
 * 拿物理尺寸去建窗口，横屏设备就会开出竖窗口 —— 那正是要修的观感问题。
 *
 * @returns 解析失败返回 null（调用方回退默认值，绝不因此让投屏失败）。
 */
export function parseScreenSize(stdout: string): ScreenSize | null {
  /*
   * 一行里可能有多个 `cur=`（多显示器时每个 DisplayDeviceInfo 一段）。
   * 取**第一个**：主显示器在 dumpsys 里排在前面，投屏投的就是主屏。
   */
  const match = /\bcur=(\d+)x(\d+)/.exec(stdout)
  if (match === null) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

/**
 * 按 scrcpy 的 `--max-size` 语义算视频尺寸：**长边**缩到 maxSize，短边等比。
 *
 * 实测对得上：屏幕 1920x1200 + maxSize 1024 → 视频 1024x640（比例 0.533），
 * 与生产环境量到的 scrcpy 子窗口尺寸完全一致；
 * 屏幕 1080x1920 + maxSize 1024 → 视频 1024x576。
 *
 * 只缩不放：设备分辨率比 maxSize 小时保持原样 ——
 * 放大只会让 scrcpy 多传像素，画面并不会更清楚。
 */
export function videoSizeFor(screen: ScreenSize, maxSize: number): ScreenSize {
  if (screen.width <= 0 || screen.height <= 0) return { width: 0, height: 0 }
  const longEdge = Math.max(screen.width, screen.height)
  if (longEdge <= maxSize || maxSize <= 0) return { width: screen.width, height: screen.height }
  const scale = maxSize / longEdge
  return {
    width: Math.max(1, Math.round(screen.width * scale)),
    height: Math.max(1, Math.round(screen.height * scale)),
  }
}

/** 探测不出分辨率时的回退值（常见竖屏手机 1080×1920，缩到 1024 长边）。 */
export const DEFAULT_SCREEN: ScreenSize = { width: 1080, height: 1920 }

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
