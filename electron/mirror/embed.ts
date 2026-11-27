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
 * 验收断言：GetParent(child) === parent，且宿主移动后子窗口矩形跟着变。
 *
 * ===== koffi 指针的坑（实测踩过）=====
 * koffi 把 void* 交回来是一个「外部对象」，**不能**直接 Number() 或做字符串拼接 ——
 * 会抛 "Cannot convert object to primitive value"。必须用 koffi.address() 取数值，
 * 且取回来的仍要是 number 才能与 Electron 的 HWND 比较。
 * 本文件所有 HWND 一律先归一成 number 再参与运算（addr / hwndOf 两个函数）。
 */

/** 用到的 Win32 常量（winuser.h 原值）。 */
const GWL_STYLE = -16
const WS_CHILD = 0x40000000
const WS_POPUP = 0x80000000
const WS_CAPTION = 0x00c00000
const WS_THICKFRAME = 0x00040000
const SW_SHOW = 5
/** 窗口标题上限（Windows 标题实际不会超过这个量级；缓冲区只分配一次）。 */
const TITLE_MAX = 4096

/** 枚举兄弟窗口用（winuser.h 原值）。 */
const GW_CHILD = 5
const GW_HWNDNEXT = 2
/** SetWindowPos：插到 z 序最顶。 */
const HWND_TOP = 0
/** SetWindowPos 标志：只改 z 序，不动位置/尺寸、不抢焦点、不碰 owner 的 z 序。 */
const SWP_ONLY_ZORDER = 0x0001 | 0x0002 | 0x0010 | 0x0200

/** 一个已嵌入的 scrcpy 窗口。 */
export interface EmbeddedWindow {
  /** scrcpy 的原生窗口句柄（number）。 */
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

/** koffi 的指针表示（不能当数字用，必须过 koffi.address）。 */
type KoffiPtr = unknown

interface Win32 {
  address: (ptr: KoffiPtr) => number
  EnumWindows: (callback: (hwnd: KoffiPtr) => boolean, lParam: number) => boolean
  GetWindowTextW: (hwnd: KoffiPtr, buffer: Buffer, maxCount: number) => number
  SetParent: (child: KoffiPtr, parent: KoffiPtr) => KoffiPtr
  GetParent: (hwnd: KoffiPtr) => KoffiPtr
  SetWindowLongPtrW: (hwnd: KoffiPtr, index: number, value: number) => number
  GetWindowLongPtrW: (hwnd: KoffiPtr, index: number) => number
  MoveWindow: (hwnd: KoffiPtr, x: number, y: number, w: number, h: number, repaint: boolean) => boolean
  ShowWindow: (hwnd: KoffiPtr, cmd: number) => boolean
  IsWindow: (hwnd: KoffiPtr) => boolean
  GetWindowRect: (hwnd: KoffiPtr, rect: Buffer) => boolean
  GetWindow: (hwnd: KoffiPtr, cmd: number) => KoffiPtr
  IsWindowVisible: (hwnd: KoffiPtr) => boolean
  SetWindowPos: (
    hwnd: KoffiPtr,
    after: KoffiPtr,
    x: number,
    y: number,
    cx: number,
    cy: number,
    flags: number,
  ) => boolean
}

let win32: Win32 | null = null
let loadError = ''

/**
 * 惰性加载 user32。
 *
 * 为什么惰性：koffi 的 .node 在打包后位于 asar.unpacked 下，
 * 加载失败必须收敛成「投屏不可用」而不是让整个应用起不来；
 * 而且只有真的投屏时才需要它。
 */
function lib(): Win32 {
  if (win32 !== null) return win32
  const require = createRequire(import.meta.url)
  const koffi = require('koffi') as {
    load: (name: string) => { func: (definition: string) => (...args: never[]) => unknown }
    proto: (definition: string) => unknown
    address: (ptr: unknown) => bigint | number
  }
  const user32 = koffi.load('user32.dll')
  /* 回调原型必须先声明类型，koffi 才肯把 JS 函数传给 EnumWindows。 */
  koffi.proto('bool __stdcall enumProc(void *hwnd, intptr lParam)')

  win32 = {
    /*
     * 指针 → number。
     *
     * 两步都必须做：koffi.address 返回 bigint（或 number），
     * 而 koffi 的 pointer 参数既能收 number 也能收原生指针对象 ——
     * 统一成 number 之后，本文件里所有比较（GetParent === 宿主）才有意义。
     */
    address: (ptr) => Number(koffi.address(ptr)),
    EnumWindows: user32.func('bool __stdcall EnumWindows(enumProc *cb, intptr lParam)') as never,
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *buf, int max)') as never,
    SetParent: user32.func('void *__stdcall SetParent(void *child, void *parent)') as never,
    GetParent: user32.func('void *__stdcall GetParent(void *hwnd)') as never,
    SetWindowLongPtrW: user32.func('intptr __stdcall SetWindowLongPtrW(void *hwnd, int index, intptr value)') as never,
    GetWindowLongPtrW: user32.func('intptr __stdcall GetWindowLongPtrW(void *hwnd, int index)') as never,
    MoveWindow: user32.func('bool __stdcall MoveWindow(void *hwnd, int x, int y, int w, int h, bool repaint)') as never,
    ShowWindow: user32.func('bool __stdcall ShowWindow(void *hwnd, int cmd)') as never,
    IsWindow: user32.func('bool __stdcall IsWindow(void *hwnd)') as never,
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ int32_t *rect)') as never,
    GetWindow: user32.func('void *__stdcall GetWindow(void *hwnd, uint32_t cmd)') as never,
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hwnd)') as never,
    SetWindowPos:
      user32.func('bool __stdcall SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, uint32_t flags)') as never,
  }
  return win32
}

/**
 * 宿主窗口里**可见**的子窗口句柄，按 z 序从上到下。
 *
 * 为什么要这个列表（实机踩到的第五个缺陷）：投屏窗口里有两个兄弟子窗口 ——
 * Chromium 的渲染窗口和我们 SetParent 进来的 scrcpy 窗口，谁在上面谁收鼠标。
 * 只要宿主 resize 一次，Chromium 就把它自己重新插回最顶，把 scrcpy 压下去，
 * 于是「画面还在、鼠标点了没反应」。
 *
 * 不可见的子窗口要过滤掉：scrcpy 自己会挂一个 0×0 的 OimeTsfNotifyWindow，
 * 它没有鼠标区域，留在列表里会让「第一个是不是我」这条判定永远为假。
 *
 * @returns 句柄列表；枚举失败返回空数组（调用方据此决定不动手）。
 */
export function visibleChildHandles(parentHwnd: number): number[] {
  if (parentHwnd === 0) return []
  try {
    const l = lib()
    const out: number[] = []
    let cursor: KoffiPtr = l.GetWindow(parentHwnd, GW_CHILD)
    // 防御性上限：正常情况下宿主只有几个子窗口，跑满说明句柄链有问题
    for (let guard = 0; guard < 32; guard++) {
      let handle = 0
      try {
        handle = l.address(cursor)
      } catch {
        // GetWindow 返回 null 时 koffi 的指针转换会抛，按链尾处理
        break
      }
      if (handle === 0) break
      if (l.IsWindowVisible(handle)) out.push(handle)
      cursor = l.GetWindow(cursor, GW_HWNDNEXT)
    }
    return out
  } catch {
    return []
  }
}

/**
 * 把已嵌入的 scrcpy 窗口提到宿主客户区 z 序的最顶层。
 *
 * 只改 z 序：SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER。
 * 前两个保证不打断 fitRect 算好的位置尺寸，NOACTIVATE 保证不把焦点从用户手上的
 * 输入框抢走，NOOWNERZORDER 保证只影响兄弟窗口的顺序。
 *
 * @returns 是否真的把它放到了顶层（false 多半意味着窗口已经没了）。
 */
export function raiseEmbedded(hostHwnd: number, childHwnd: number): boolean {
  if (hostHwnd === 0 || childHwnd === 0) return false
  try {
    const l = lib()
    if (!l.IsWindow(childHwnd)) return false
    l.SetWindowPos(childHwnd, HWND_TOP, 0, 0, 0, 0, SWP_ONLY_ZORDER)
    // 用「再枚举一次」验收，而不是信任 SetWindowPos 的返回值：
    // 它返回 true 只代表调用成功，不代表最终顺序（可能有别的窗口刚好插进来）。
    return isEmbeddedOnTop(hostHwnd, childHwnd)
  } catch {
    return false
  }
}

/**
 * scrcpy 子窗口是不是宿主客户区里最上层的可见子窗口（= 鼠标会落到它身上）。
 *
 * 判定逻辑放在 shared/mirror.ts 的 needsRaise 里（纯函数，有单测）；
 * 这里只负责把 Win32 的事实读出来。
 */
export function isEmbeddedOnTop(hostHwnd: number, childHwnd: number): boolean {
  const order = visibleChildHandles(hostHwnd)
  return order.length > 0 && order[0] === childHwnd
}

/** 标题缓冲区（每次枚举复用，避免每窗口一次分配）。 */
const TITLE_BUFFER = Buffer.alloc(TITLE_MAX * 2)

/** 读出窗口标题；失败返回空串。 */
function titleOf(hwnd: KoffiPtr): string {
  const n = lib().GetWindowTextW(hwnd, TITLE_BUFFER, TITLE_MAX)
  if (n <= 0) return ''
  return TITLE_BUFFER.subarray(0, n * 2).toString('utf16le')
}

/**
 * 按标题**精确**匹配查找窗口（同步一次）。
 *
 * 为什么精确而不是包含：前缀相同（`adbfm-scrcpy-`）的两个窗口必须靠后缀 token 区分，
 * 用 includes 会让两台设备的投屏互相认错 —— 表现为「B 的画面出现在 A 的窗口里」。
 *
 * @returns HWND（number）；没找到返回 0。
 */
export function findWindowOnce(title: string): number {
  try {
    const l = lib()
    let found = 0
    l.EnumWindows((hwnd) => {
      if (titleOf(hwnd) === title) {
        found = l.address(hwnd)
        return false // 找到即停
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
 * @param hostHwnd 宿主 HWND（number，来自 hwndOf）。
 * @param childHwnd scrcpy 的 HWND（number，来自 findWindowByTitle）。
 * @param rect 目标矩形（宿主客户区坐标，物理像素）。
 */
export function embedWindow(hostHwnd: number, childHwnd: number, rect: EmbedRect): EmbedResult {
  if (hostHwnd === 0 || childHwnd === 0) return { ok: false, reason: 'invalid hwnd' }
  try {
    const l = lib()
    if (!l.IsWindow(childHwnd)) return { ok: false, reason: 'child window gone' }

    /* ① 先改样式。顺序反了就是 spike 里那个「假成功」。 */
    const style = Number(l.GetWindowLongPtrW(childHwnd, GWL_STYLE))
    const nextStyle = (style | WS_CHILD) & ~WS_POPUP & ~WS_CAPTION & ~WS_THICKFRAME
    l.SetWindowLongPtrW(childHwnd, GWL_STYLE, nextStyle)

    /* ② 建立父子关系 */
    l.SetParent(childHwnd, hostHwnd)

    /* ③ 摆进客户区 */
    l.MoveWindow(childHwnd, rect.x, rect.y, rect.width, rect.height, true)
    l.ShowWindow(childHwnd, SW_SHOW)

    /*
     * ④ 显式把它提到 z 序最顶。
     *
     * 不依赖 ShowWindow 的副作用：它可能把窗口显示出来但排在 Chromium 渲染子窗口
     * 下面 —— 那种情况下画面能看见（原生窗口被压住也会被合成），鼠标却全被
     * WebView 吃掉，正是「投屏一会儿之后点不动」的现场。窗口一建出来就要在上面。
     */
    l.SetWindowPos(childHwnd, HWND_TOP, 0, 0, 0, 0, SWP_ONLY_ZORDER)

    /*
     * 验收断言：GetParent 必须真的等于宿主。
     * 不等就说明样式没生效 —— 此时不能当真嵌入继续走，
     * 否则用户看到的是「窗口飘在屏幕左上角」这种更难解释的状态。
     */
    const parent = l.address(l.GetParent(childHwnd))
    if (parent !== hostHwnd) {
      return { ok: false, reason: 'GetParent mismatch: ' + String(parent) + ' != ' + String(hostHwnd) }
    }

    return {
      ok: true,
      window: {
        childHwnd,
        detach: () => {
          try {
            l.SetParent(childHwnd, 0)
          } catch {
            // 解嵌失败无补救动作：调用方随后会直接 kill 进程
          }
        },
      },
    }
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: loadError }
  }
}

/** 宿主窗口尺寸变化时把子窗口重新铺满客户区。 */
export function resizeEmbedded(childHwnd: number, rect: EmbedRect): boolean {
  try {
    return lib().MoveWindow(childHwnd, rect.x, rect.y, rect.width, rect.height, true)
  } catch {
    return false
  }
}

/**
 * 子窗口当前的屏幕矩形（验收「跟随宿主」用；坐标系为屏幕坐标）。
 *
 * 为什么需要它：GetParent 相等只证明「父子关系建立了」，
 * 而 spike 里那个假成功的窗口**也**能通过 SetParent 返回非零的弱检查。
 * 真正能证明嵌入生效的是「宿主移动时子窗口跟着动」。
 */
export function windowRectOf(childHwnd: number): { left: number; top: number; right: number; bottom: number } | null {
  try {
    const buffer = Buffer.alloc(16)
    if (!lib().GetWindowRect(childHwnd, buffer)) return null
    return {
      left: buffer.readInt32LE(0),
      top: buffer.readInt32LE(4),
      right: buffer.readInt32LE(8),
      bottom: buffer.readInt32LE(12),
    }
  } catch {
    return null
  }
}

/**
 * 把 Electron 的 nativeHandle Buffer 转成 HWND（number）。
 *
 * 64 位下是 8 字节小端；HWND 实际值远小于 2^53，降成 number 不丢精度。
 */
export function hwndOf(nativeHandle: Buffer): number {
  if (nativeHandle.length >= 8) return Number(nativeHandle.readBigUInt64LE(0))
  return nativeHandle.readUInt32LE(0)
}
