import { createRequire } from 'node:module'

/**
 * scrcpy 窗口的 Win32 嵌入（方案 C：HWND + SetParent）。
 *
 * ===== 为什么是「原生窗口嵌进我们的窗口」，而不是把画面塞进 DOM =====
 * scrcpy 的画面由它自己的 Direct3D 渲染，要放进渲染进程只能做实时串流 + 逐帧解码，
 * 那是另一个产品的工作量（延迟、带宽、编码全部要重做）。而 Windows 允许把
 * 别人的窗口直接挂到自己窗口的客户区 —— 这正是 Escrcpy 一类工具的做法。
 *
 * ===== spike 实证的红线（见 docs/superpowers/spike/scrcpy-embed-result.md）=====
 * 只调 SetParent 会「看起来成功」而实际没有任何父子关系：窗口样式是 WS_POPUP 时，
 * SetParent 只重写坐标，GetParent 仍返回 0，宿主移动时子窗口纹丝不动。
 * 所以顺序必须是：
 *   ① SetWindowLongPtrW(GWL_STYLE, style | WS_CHILD & ~WS_POPUP ...)
 *   ② SetParent
 *   ③ MoveWindow
 * 验收断言：GetParent(child) === parent。不成立就判失败，**不**当成嵌入成功。
 */

/**
 * 用到的 Win32 常量。
 *
 * GWL_STYLE = -16 是 Windows SDK 里 `#define GWL_STYLE (-16)` 的原值；
 * 其余都是 winuser.h 的位标志，写成十六进制便于与文档对照。
 */
const GWL_STYLE = -16
const WS_CHILD = 0x40000000
const WS_POPUP = 0x80000000
const WS_CAPTION = 0x00c00000
const WS_THICKFRAME = 0x00040000
const SW_SHOW = 5

/** 一个已嵌入的 scrcpy 窗口。 */
export interface EmbeddedWindow {
  /** scrcpy 的原生窗口句柄。 */
  childHwnd: number
  /** 解嵌：把窗口从宿主上摘下来（宿主销毁前应调用）。 */
  detach: () => void
}

export interface EmbedResult {
  ok: boolean
  /** 失败原因（只进日志与错误码，不给用户看原文）。 */
  reason?: string
  window?: EmbeddedWindow
}

export interface EmbedRect {
  x: number
  y: number
  width: number
  height: number
}

/** koffi 用户的签名声明面（只列用到的）。 */
interface Win32 {
  EnumWindows: (callback: (hwnd: number, lParam: number) => boolean, lParam: number) => boolean
  GetWindowTextW: (hwnd: number, buffer: Buffer, maxCount: number) => number
  GetWindowThreadProcessId: (hwnd: number, processId: Buffer) => number
  SetParent: (child: number, parent: number) => number
  GetParent: (hwnd: number) => number
  SetWindowLongPtrW: (hwnd: number, index: number, value: number) => number
  GetWindowLongPtrW: (hwnd: number, index: number) => number
  MoveWindow: (hwnd: number, x: number, y: number, width: number, height: number, repaint: boolean) => boolean
  ShowWindow: (hwnd: number, cmd: number) => boolean
  IsWindow: (hwnd: number) => boolean
}

let win32: Win32 | null = null
let loadError: string | null = null

/**
 * 惰性加载 user32。
 *
 * 为什么惰性：koffi 的 .node 在打包后位于 asar.unpacked 下，
 * 加载失败必须收敛成「投屏不可用」而不是让整个应用起不来；
 * 而且只有真的投屏时才需要它。
 */
function lib(): Win32 {
  if (win32 !== null) return win32
  try {
    const require = createRequire(import.meta.url)
    const koffi = require('koffi') as {
      load: (name: string) => {
        func: (definition: string) => (...args: never[]) => unknown
      }
      proto: (definition: string) => unknown
    }
    const user32 = koffi.load('user32.dll')
    /* 回调原型必须先声明类型，koffi 才肯把 JS 函数传给 EnumWindows。 */
    const enumProc = koffi.proto('bool __stdcall enumProc(void *hwnd, intptr lParam)')
    const raw = {
      EnumWindows: user32.func('bool __stdcall EnumWindows(enumProc *cb, intptr lParam)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *buf, int max)'),
      GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)'),
      SetParent: user32.func('void *__stdcall SetParent(void *child, void *parent)'),
      GetParent: user32.func('void *__stdcall GetParent(void *hwnd)'),
      SetWindowLongPtrW: user32.func('intptr __stdcall SetWindowLongPtrW(void *hwnd, int index, intptr value)'),
      GetWindowLongPtrW: user32.func('intptr __stdcall GetWindowLongPtrW(void *hwnd, int index)'),
      MoveWindow: user32.func('bool __stdcall MoveWindow(void *hwnd, int x, int y, int w, int h, bool repaint)'),
      ShowWindow: user32.func('bool __stdcall ShowWindow(void *hwnd, int cmd)'),
      IsWindow: user32.func('bool __stdcall IsWindow(void *hwnd)'),
    }
    void enumProc
    win32 = raw as unknown as Win32
    return win32
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
    throw new Error('user32 unavailable: ' + loadError)
  }
}

/**
 * 标题缓冲区。
 *
 * Windows 的窗口标题理论上可以更长，但实际用到几百个字符已经很极端；
 * 4096 个 UTF-16 码元给足余量，且只分配一次（每次 EnumWindows 复用）。
 */
const TITLE_BUFFER = Buffer.alloc(4096 * 2)

/** 读出窗口标题；失败返回空串。 */
function titleOf(hwnd: number): string {
  const lib32 = lib()
  const len = lib32.GetWindowTextW(hwnd, TITLE_BUFFER, 4096)
  if (len <= 0) return ''
  return TITLE_BUFFER.subarray(0, len * 2).toString('utf16le')
}

/**
 * 按标题**精确**匹配查找窗口。
 *
 * 为什么精确而不是包含：前缀相同（`adbfm-scrcpy-`）的两个窗口必须靠后缀 token 区分，
 * 用 includes 会让两台设备的投屏互相认错 —— 表现为「B 的画面出现在 A 的窗口里」，
 * 这种缺陷排查起来极其昂贵。
 */
export function findWindowOnce(title: string): number {
  try {
    const lib32 = lib()
    let found = 0
    lib32.EnumWindows((hwnd) => {
      if (titleOf(hwnd) === title) {
        found = hwnd
        return false // 找到即停，不为无关窗口继续枚举
      }
      return true
    }, 0)
    return found
  } catch {
    return 0
  }
}

/**
 * 轮询查找窗口（scrcpy 要 6–8 秒才建窗口，spike 实测）。
 *
 * @returns 找到的 HWND；超时返回 0。
 */
export async function findWindowByTitle(
  title: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const intervalMs = options.intervalMs ?? 200
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hwnd = findWindowOnce(title)
    if (hwnd !== 0) return hwnd
    if (Date.now() >= deadline) return 0
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * 把一个 scrcpy 窗口嵌入宿主窗口的客户区。
 *
 * @param hostHwnd 宿主窗口 HWND（Electron 的 getNativeWindowHandle 转出来）。
 * @param childHwnd scrcpy 的 HWND。
 * @param rect 目标矩形（宿主客户区坐标）。
 */
export function embedWindow(hostHwnd: number, childHwnd: number, rect: EmbedRect): EmbedResult {
  if (hostHwnd === 0 || childHwnd === 0) return { ok: false, reason: 'invalid hwnd' }
  try {
    const lib32 = lib()
    if (!lib32.IsWindow(childHwnd)) return { ok: false, reason: 'child window gone' }

    /* ① 先改样式。顺序反了就是 spike 里那个「假成功」。 */
    const style = Number(lib32.GetWindowLongPtrW(childHwnd, GWL_STYLE))
    const nextStyle = (style | WS_CHILD) & ~WS_POPUP & ~WS_CAPTION & ~WS_THICKFRAME
    lib32.SetWindowLongPtrW(childHwnd, GWL_STYLE, nextStyle)

    /* ② 建立父子关系 */
    lib32.SetParent(childHwnd, hostHwnd)

    /* ③ 摆进客户区 */
    lib32.MoveWindow(childHwnd, rect.x, rect.y, rect.width, rect.height, true)
    lib32.ShowWindow(childHwnd, SW_SHOW)

    /*
     * 验收断言：GetParent 必须真的等于宿主。
     * 不等就说明样式没生效 —— 此时不能当真嵌入继续走，
     * 否则用户看到的是「窗口飘在屏幕左上角」这种更难解释的状态。
     */
    const parent = Number(lib32.GetParent(childHwnd))
    if (parent !== hostHwnd) {
      return { ok: false, reason: 'GetParent mismatch: ' + String(parent) + ' != ' + String(hostHwnd) }
    }

    return {
      ok: true,
      window: {
        childHwnd,
        detach: () => {
          try {
            lib32.SetParent(childHwnd, 0)
          } catch {
            // 解嵌失败无补救动作：调用方随后会直接 kill 进程
          }
        },
      },
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** 宿主窗口尺寸变化时把子窗口重新铺满客户区。 */
export function resizeEmbedded(childHwnd: number, rect: EmbedRect): boolean {
  try {
    return lib().MoveWindow(childHwnd, rect.x, rect.y, rect.width, rect.height, true) as boolean
  } catch {
    return false
  }
}

/**
 * 把 Electron 的 nativeHandle Buffer 转成 HWND。
 *
 * 64 位下是 8 字节小端；HWND 实际值远小于 2^53，降成 number 不会丢精度。
 */
export function hwndOf(nativeHandle: Buffer): number {
  if (nativeHandle.length >= 8) return Number(nativeHandle.readBigUInt64LE(0))
  return nativeHandle.readUInt32LE(0)
}
