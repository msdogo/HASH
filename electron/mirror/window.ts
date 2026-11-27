import { BrowserWindow, screen } from 'electron'
import type { MirrorSession } from '../../src/shared/mirror'
import {
  DEFAULT_MAX_SIZE,
  SCRCPY_WINDOW_PREFIX,
  availableRect,
  fitRect,
  needsRaise,
  videoSizeFor,
  windowFitSize,
  type Rect,
} from '../../src/shared/mirror'
import {
  embedWindow,
  findWindowByTitle,
  isEmbeddedOnTop,
  raiseEmbedded,
  resizeEmbedded,
  visibleChildHandles,
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
  /**
   * 把窗口恢复到「刚好装下画面」的默认尺寸。
   *
   * 用户手动放大/缩小之后，画面会按 fitRect 居中并留出黑边（那是用户自己的选择）。
   * 这个操作把窗口退回初始尺寸 —— 也就是第一次打开时的那个尺寸。
   *
   * 幂等 + 安全空操作：窗口不存在 / 已销毁时什么也不做（不抛）。
   */
  resetSize: (serial: string) => void
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

      /*
       * 初始尺寸由**探测到的屏幕方向**决定，不写死。
       *
       * 写死 480×900（竖）时，横屏设备（遥控器）会先出现一个竖窗口，
       * 等 scrcpy 出画面、量到视频尺寸后 setContentSize 再变成横向 ——
       * 用户看到的就是「先竖后横」的跳变。
       *
       * 这里用与后续 setContentSize 完全相同的口径（videoSizeFor 算视频尺寸，
       * windowFitSize 加上顶栏/侧边栏），所以窗口一开出来就是最终尺寸，
       * 后面那次 setContentSize 只是校正，不再有可见跳变。
       */
      const initialVideo = videoSizeFor(session.screen, DEFAULT_MAX_SIZE)
      const initialSize = windowFitSize(
        initialVideo.width,
        initialVideo.height,
        screen.getPrimaryDisplay().scaleFactor,
      )
      const win = new BrowserWindow({
        width: initialSize.width,
        height: initialSize.height,
        minWidth: 240,
        minHeight: 320,
        frame: false,
        // 与主窗口一致（main.ts 的 #F7F8FA）：窗口第一帧到渲染完成之间
        // 露出的底色不能是深色，否则每次开会闪一下黑框。
        backgroundColor: '#F7F8FA',
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
        const childHwnd = result.window.childHwnd
        const onResize = (): void => {
          if (win.isDestroyed()) return
          // 尺寸变化后按同一宽高比重新居中（拉伸窗口不会拉伸画面）
          resizeEmbedded(childHwnd, fitRect(hostArea(win), videoWidth, videoHeight))
          /*
           * resize 之后必须重新提层。
           *
           * 实测（Win32 EnumChildWindows 采样）：宿主每 resize 一次，Chromium 就把自己的
           * Chrome_RenderWidgetHostHWND 重新插回 z 序最顶，把 scrcpy 压到下面；而被压下去的
           * 窗口画面照常有（被合成），鼠标事件却全被渲染层吃掉 ——
           * 这就是「投屏刚开始能点、一会儿之后点不动」的真正成因。
           * 而且覆盖是粘住的：尺寸改回去也不会自己恢复，只能显式 SetWindowPos。
           */
          raiseEmbedded(hostHwnd, childHwnd)
        }
        win.on('resize', onResize)
        entry.cleanup.push(() => { win.off('resize', onResize) })

        /*
         * 看门狗：兜住「不是 resize 引起」的抢层。
         *
         * 已知的触发点除了 resize 还有切焦点、DPI 变化、Chromium 自己重排；逐个去挂监听
         * 既漏又难验证。这里改成轮询**事实**：只读一次子窗口 z 序，发现第一个可见子窗口
         * 不是 scrcpy 才动手。读操作没有副作用，动手的那次也只在真被压住时发生 ——
         * 所以正常情况下这个定时器对画面完全无感（不会每 500ms 抖一下）。
         *
         * 500ms 是「来得及」与「不折腾」的折中：真被压住后最多半秒内自动恢复，
         * 而人手点一下的间隔远大于它。
         */
        const watchdog = setInterval(() => {
          if (win.isDestroyed()) return
          if (!needsRaise(visibleChildHandles(hostHwnd), childHwnd)) return
          raiseEmbedded(hostHwnd, childHwnd)
        }, ZORDER_WATCHDOG_MS)
        // 不让这个定时器拖住应用退出（与 devices/apps 的轮询同一手法）
        watchdog.unref?.()
        entry.cleanup.push(() => { clearInterval(watchdog) })
        // 补一次：嵌入发生在 setContentSize 之后，上一轮 resize 可能已经把子窗口压下去了
        if (!isEmbeddedOnTop(hostHwnd, childHwnd)) raiseEmbedded(hostHwnd, childHwnd)
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

    resetSize(serial: string): void {
      const entry = entries.get(serial)
      if (entry === undefined || entry.win.isDestroyed()) return

      /*
       * 默认尺寸必须用**会话里记下的 screen** 重新算，而不是缓存首次的尺寸。
       *
       * 为什么：设备可能中途转过屏。用缓存值会把横屏设备的窗口"重置"成竖的，
       * 而用户看到的是一个比原来更离谱的窗口。
       * 与 open() 完全同一套算式（videoSizeFor → windowFitSize），
       * 所以「重置」的结果与「重新打开」逐像素一致。
       */
      const video = videoSizeFor(entry.session.screen, DEFAULT_MAX_SIZE)
      const size = windowFitSize(video.width, video.height, screen.getDisplayMatching(entry.win.getBounds()).scaleFactor)
      entry.win.setContentSize(size.width, size.height)

      /*
       * 嵌入的子窗口不会跟着窗口自己变 —— 必须显式 MoveWindow。
       *
       * 顺序：先设窗口尺寸，再摆子窗口。反过来的话 fitRect 用的是**旧的**
       * 客户区大小，画面会按旧尺寸居中，看起来像"重置没生效"。
       */
      if (entry.embedded !== null) {
        resizeEmbedded(
          entry.embedded.childHwnd,
          fitRect(hostArea(entry.win), video.width, video.height),
        )
      }
    },
  }
}

/**
 * z 序看门狗的轮询周期（毫秒）。
 *
 * 与被压住后的恢复延迟等价：用户点下去之前最多有这么久是「点不动」的。
 * 再小没有收益（人手一次点击的间隔远大于 500ms），只会多读几次窗口链。
 */
const ZORDER_WATCHDOG_MS = 500

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
