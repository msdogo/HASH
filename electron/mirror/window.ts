import { BrowserWindow, screen } from 'electron'
import type { MirrorSession } from '../../src/shared/mirror'
import {
  SCRCPY_WINDOW_PREFIX,
  availableRect,
  fitRect,
  windowFitSize,
  type Rect,
} from '../../src/shared/mirror'
import {
  embedWindow,
  findWindowByTitle,
  resizeEmbedded,
  windowRectOf,
  type EmbeddedWindow,
} from './embed'

/**
 * 投屏窗口（每台设备一个）。
 *
 * ===== 结构 =====
 * 一个 frame:false 的 BrowserWindow，渲染层画左侧 56px 的竖排六个按键（侧边栏），
 * 右侧留空 —— 那块空白**不是** DOM，而是用 SetParent 把 scrcpy 的原生窗口嵌进去。
 * 这样控制区是真正的 HTML（可做悬停/禁用/主题），画面是真正的 scrcpy（零转码延迟）。
 *
 * ===== 为什么画面那块必须留空 =====
 * 嵌入的原生窗口是宿主窗口的**子窗口**，它永远画在渲染层之上。
 * 如果那块区域还画了东西，用户会看到「一个洞」—— 内容被原生窗口盖住。
 * 所以渲染层只画侧边栏，其余部分保持透明/空。
 */

export interface MirrorWindowManagerDeps {
  /** 开发/生产入口（与主窗口同一套 loadURL 逻辑）。 */
  loadView: (win: BrowserWindow, hash: string) => void
  /** 窗口图标与 preload 路径。 */
  preloadPath: string
  iconPath: string
  /** 用户关掉投屏窗口 = 结束这次投屏（杀 scrcpy）。 */
  onClosed: (serial: string) => void
  /** 嵌入失败（原生窗口没出现 / SetParent 不成立）时的上报。 */
  onEmbedFailed: (serial: string, reason: string) => void
}

interface Entry {
  win: BrowserWindow
  session: MirrorSession
  embedded: EmbeddedWindow | null
  cleanup: Array<() => void>
}

export interface MirrorWindowManager {
  /** 打开（或聚焦）某台设备的投屏窗口，并把 scrcpy 窗口嵌进去。 */
  open: (session: MirrorSession) => void
  /** 按 serial 关窗口（会话结束时调用；窗口已关则是空操作）。 */
  close: (serial: string) => void
  /** 全部关掉（应用退出）。 */
  closeAll: () => void
  /** 当前打开的窗口数（测试与日志用）。 */
  count: () => number
}

export function createMirrorWindowManager(deps: MirrorWindowManagerDeps): MirrorWindowManager {
  const entries = new Map<string, Entry>()

  const disposeEntry = (serial: string): void => {
    const entry = entries.get(serial)
    if (entry === undefined) return
    entries.delete(serial)
    for (const fn of entry.cleanup) {
      try {
        fn()
      } catch {
        // 监听器摘除失败不影响收尾
      }
    }
    entry.embedded?.detach()
    if (!entry.win.isDestroyed()) entry.win.destroy()
  }

  return {
    open(session: MirrorSession): void {
      const existing = entries.get(session.serial)
      if (existing !== undefined && !existing.win.isDestroyed()) {
        // 已开着 → 聚焦（幂等，与 service.start 的幂等语义配套）
        if (existing.win.isMinimized()) existing.win.restore()
        existing.win.focus()
        return
      }

      const win = new BrowserWindow({
        width: 480,
        height: 900,
        minWidth: 240,
        minHeight: 320,
        frame: false,
        backgroundColor: '#111827',
        show: false,
        webPreferences: {
          preload: deps.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      if (deps.iconPath !== '') win.setIcon(deps.iconPath)

      const entry: Entry = { win, session, embedded: null, cleanup: [] }
      entries.set(session.serial, entry)

      deps.loadView(win, '#/mirror/' + encodeURIComponent(session.serial))

      win.once('ready-to-show', () => { win.show() })
      win.on('closed', () => {
        entries.delete(session.serial)
        deps.onClosed(session.serial)
      })

      /*
       * 嵌入是异步的：scrcpy 要 6–8 秒才建窗口（spike 实测），
       * 所以不能阻塞 open()。失败要上报 —— 用户看到的是一个空窗口，
       * 没有说明就成了「点了投屏，出来一个黑框」。
       */
      void (async () => {
        const hwnd = await findWindowByTitle(SCRCPY_WINDOW_PREFIX + session.token)
        if (hwnd === 0) {
          deps.onEmbedFailed(session.serial, 'scrcpy 窗口未在 10 秒内出现')
          return
        }
        // 窗口可能在这段时间里被用户关掉了
        if (win.isDestroyed() || !entries.has(session.serial)) return
        const hostHwnd = hwndOfHost(win)

        /*
         * 先从 scrcpy 窗口自己的尺寸读出**视频**的宽高比。
         *
         * 为什么不能「铺满可用区域」：scrcpy 的窗口是无边框的，初始尺寸就等于视频尺寸
         * （实测 1024×640）。把它 MoveWindow 成宽高比完全不同的矩形时，scrcpy 会把自己的
         * 画布铺满那个矩形、再把视频居中留黑边 —— 实测在 424×900 的竖长区域里出现
         * 上下各约 260px 的黑带，看起来像投屏坏了。
         */
        const videoRect = await measureStableVideoRect(hwnd)
        const videoWidth = videoRect === null ? 0 : videoRect.right - videoRect.left
        const videoHeight = videoRect === null ? 0 : videoRect.bottom - videoRect.top

        /*
         * 把窗口收缩到「刚好装下画面」的尺寸。
         *
         * 窗口是 6–8 秒前按固定尺寸建好的（那时还不知道视频多大）。
         * 不这一步的话，16:10 的横屏画面会塞进竖长窗口里 —— 实测上下各留
         * 约 260px 黑带，画面只占窗口中间一小块，看起来像投屏出了问题。
         *
         * 用 setContentSize：它设的是内容区（不含窗口边框），
         * 与 windowFitSize 的语义一致（那个函数已经把顶栏/侧边栏算进去了）。
         */
        if (videoWidth > 0 && videoHeight > 0) {
          const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor
          const fitted = windowFitSize(videoWidth, videoHeight, scale)
          win.setContentSize(fitted.width, fitted.height)
        }

        const result = embedWindow(hostHwnd, hwnd, fitRect(hostArea(win), videoWidth, videoHeight))
        if (!result.ok || result.window === undefined) {
          deps.onEmbedFailed(session.serial, result.reason ?? 'unknown')
          return
        }
        entry.embedded = result.window
        /*
         * 尺寸跟随：宿主被拉大/缩小的时候，子窗口不会自己变 ——
         * 必须显式 MoveWindow。用 'resize' 而不是 'resized'：前者在拖拽过程中
         * 就持续触发，画面能跟着一起变；后者只在松手时触发一次，拖拽期间是个洞。
         */
        const onResize = (): void => {
          if (win.isDestroyed()) return
          // 尺寸变化后按同一宽高比重新居中（拉伸窗口不会拉伸画面）
          resizeEmbedded(result.window!.childHwnd, fitRect(hostArea(win), videoWidth, videoHeight))
        }
        win.on('resize', onResize)
        entry.cleanup.push(() => { win.off('resize', onResize) })
      })()
    },

    close(serial: string): void {
      disposeEntry(serial)
    },

    closeAll(): void {
      for (const serial of [...entries.keys()]) disposeEntry(serial)
    },

    count(): number {
      return entries.size
    },
  }
}

/** 宿主窗口的 HWND。 */
function hwndOfHost(win: BrowserWindow): number {
  const buf = win.getNativeWindowHandle()
  // 64 位下是 8 字节小端；HWND 实际值远小于 2^53
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0)
}

/** 量视频尺寸时的最小可信边长（像素）。比这小说明窗口还没被 scrcpy 定型。 */
const MIN_TRUSTED_VIDEO_SIDE = 320

/**
 * 等 scrcpy 窗口尺寸**稳定**下来，再返回它的矩形。
 *
 * ===== 为什么必须等（实机踩到的第四个缺陷）=====
 * scrcpy 建窗口的时序是：先在屏幕某处建一个小窗口 → 拿到首帧后再 resize 到视频尺寸。
 * 第一次实现在 `findWindowByTitle` 一返回就立刻量尺寸，量到的是那个**中间态**
 * （实测 256×256），于是窗口被算成 328×328 —— 画面缩成一小块。
 *
 * 判据是「连续两次量到同一尺寸 且 边长不低于可信下限」：
 *   - 只比一次不够：scrcpy 可能刚好在两次采样之间又开始 resize；
 *   - 只看稳定也不够：刚建出来的小窗口也可能稳定几百毫秒。
 *
 * @returns 稳定后的矩形；始终不稳（窗口消失等）返回 null，调用方走保底逻辑。
 */
async function measureStableVideoRect(hwnd: number): Promise<{ left: number; top: number; right: number; bottom: number } | null> {
  const deadline = Date.now() + 6_000
  let previous: string | null = null
  for (;;) {
    const rect = windowRectOf(hwnd)
    if (rect !== null) {
      const width = rect.right - rect.left
      const height = rect.bottom - rect.top
      const key = String(width) + 'x' + String(height)
      if (key === previous && width >= MIN_TRUSTED_VIDEO_SIDE && height >= MIN_TRUSTED_VIDEO_SIDE) {
        return rect
      }
      previous = key
    }
    if (Date.now() >= deadline) {
      // 超时：宁可用一个可能是中间态的尺寸，也不要让投屏卡在「等待」上
      return windowRectOf(hwnd)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/**
 * 宿主窗口里「可以放视频」的区域（物理像素）。
 *
 * Electron 给的 bounds 是 DIP，而 MoveWindow 要物理像素 ——
 * 在 125%/150% 缩放的屏幕上直接用 DIP 会让画面比窗口小一圈。
 * 换算与两个减项（顶栏 / 右侧侧边栏）都在 shared 的 availableRect 里，有单测。
 */
function hostArea(win: BrowserWindow): Rect {
  const bounds = win.getContentBounds()
  const scale = screen.getDisplayMatching(bounds).scaleFactor
  return availableRect({ width: bounds.width, height: bounds.height }, scale)
}
