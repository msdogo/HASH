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
  clearHostTopmost,
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
  /**
   * 投屏成功那一刻的内容区尺寸（DIP），「重置窗口大小」恢复的就是它。
   *
   * open() 里在窗口第一次显示之前记录；嵌入还没走完就被重置时仍为 null
   * （此时 resetSize 回退到旧算式）。
   */
  defaultSize: { width: number; height: number } | null
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
        /*
         * 任务栏按钮显示的名字（Win11 任务栏/Alt-Tab 都取它）。
         *
         * 不写这个的话所有窗口都继承 index.html 的 <title>HASH</title>，
         * 开两台设备就是两个一模一样的「HASH」。session.title 由
         * service.ts 用 mirrorTitleOf 算好（型号 + serial 后 4 位），
         * 开窗这一刻就可用 —— 不用等 started 事件，也就没有「先 HASH 再变」的闪烁。
         *
         * 注意这**不是** scrcpy 的原生窗口标题：那个被红线参数 --window-title
         * 占死成 SCRCPY_WINDOW_PREFIX + token（嵌入靠它找 HWND），两者互不相干。
         */
        title: session.title,
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

      /*
       * 拒绝渲染层改标题。
       *
       * 构造参数里的 title 只在页面加载前有效：渲染层一加载，Chromium 就把
       * document.title（index.html 的 HASH）回写给窗口，任务栏的「MI 6 (1A2B)」
       * 会被瞬间打回「HASH」。page-title-updated 是这条回写的唯一入口，
       * preventDefault 掉之后窗口标题就只归主进程管。
       *
       * 必须挂在 **BrowserWindow** 上，不是 webContents 上 —— 实测（Electron 45，
       * 见下表）只有 BrowserWindow 的 preventDefault 能真的拦住回写：
       *   none       → title=HASH        （构造参数的 MI 6 (1A2B) 被覆盖）
       *   webContents→ title=HASH        （preventDefault 无效，照旧被覆盖）
       *   window     → title=MI 6 (1A2B) （真的拦住了）
       *
       * 主窗口/设置窗口不装这个监听 —— 它们本来就该叫 HASH。
       */
      win.on('page-title-updated', (event) => {
        event.preventDefault()
      })

      const entry: Entry = { win, session, embedded: null, defaultSize: null, cleanup: [] }
      entries.set(session.serial, entry)

      deps.loadView(win, '#/mirror/' + encodeURIComponent(session.serial))

      /*
       * ===== 为什么这里不 show()（用户反馈的第一次/第三次闪烁）=====
       *
       * 以前的写法是 win.once('ready-to-show', () => win.show())：渲染层一就绪就
       * 把窗口推出来。可那时 scrcpy 窗口还没出现，画面区只有深色底 + 一行「正在等待
       * 设备画面出现」—— 这就是用户说的「投屏界面 A」。实机采样：宿主窗口在
       * t=2.66s 显示，scrcpy 窗口 t=3.31s 才建出来、t=3.67s 才嵌进来。
       *
       * 之后再 setContentSize 校正尺寸，窗口又在画面已经出现之后**跳一次**（界面 C）。
       *
       * 现在改成「全部就绪才露一次脸」：等 scrcpy 窗口出现 → 量到稳定视频尺寸 →
       * 按最终尺寸 setContentSize → 嵌入 → 提层 → 才 show()。窗口首次出现就是最终
       * 样子，中间所有尺寸/位置变化都发生在不可见状态下。
       *
       * 代价是点「投屏」到窗口出现之间有一段（实测约 1 秒、冷启动更久）什么都没有。
       * 所以每条失败路径都必须把窗口显示出来 —— 否则用户会以为点了没反应。
       */
      const revealOnce = (): void => {
        if (win.isDestroyed()) return
        if (win.isVisible()) return
        win.show()
      }
      win.on('closed', () => {
        entries.delete(session.serial)
        deps.onClosed(session.serial)
      })

      /*
       * 嵌入是异步的：scrcpy 要 6–8 秒才建窗口（spike 实测），
       * 所以不能阻塞 open()。失败要上报 —— 用户看到的是一个空窗口，
       * 没有说明就成了「点了投屏，出来一个黑框」。
       */
      /*
       * 兜底：无论嵌入流程卡在哪一步，这些毫秒之后窗口必须出现。
       *
       * 只靠每条分支自己 reveal 是不够的 —— 漏掉一条分支的后果是「点了投屏，
       * 屏幕上什么也没发生」，而那时 scrcpy 进程还在后台跑，用户看不到任何线索。
       * findWindowByTitle 自己最多等 10 秒，这里留 12 秒。
       */
      const revealTimer = setTimeout(revealOnce, REVEAL_TIMEOUT_MS)
      revealTimer.unref?.()
      entry.cleanup.push(() => { clearTimeout(revealTimer) })

      void (async () => {
        const hwnd = await findWindowByTitle(SCRCPY_WINDOW_PREFIX + session.token)
        if (hwnd === 0) {
          /*
           * 窗口始终没出现 —— 这次投屏失败。先把自己显示出来再上报：
           * onEmbedFailed 会把窗口关掉，不先显示的话用户连一眼都看不到。
           */
          revealOnce()
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
          revealOnce()
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
          // 同一时机顺带摘掉宿主的置顶（见下方看门狗的说明）
          clearHostTopmost(hostHwnd)
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
          /*
           * 每一项都只在「真的需要」时才动手，所以正常情况下这个定时器完全无感：
           *   - 子窗口被压到下面 → 提回顶层；
           *   - 宿主被置顶       → 摘掉置顶。
           *
           * 第二条是用户在实机上提的：投屏窗口一旦置顶，切到浏览器/聊天工具时它照样
           * 盖在最上面，看起来像「投屏把别的应用挡住了」。置顶位不是我们设的
           * （整个工程里没有 alwaysOnTop；实测宿主会在投屏后十几秒自己变成 0x200108，
           * 而且是粘住的 —— 不改就一直在），所以只能运行期反复核对并清掉。
           */
          if (needsRaise(visibleChildHandles(hostHwnd), childHwnd)) {
            raiseEmbedded(hostHwnd, childHwnd)
          }
          clearHostTopmost(hostHwnd)
        }, ZORDER_WATCHDOG_MS)
        // 不让这个定时器拖住应用退出（与 devices/apps 的轮询同一手法）
        watchdog.unref?.()
        entry.cleanup.push(() => { clearInterval(watchdog) })
        // 补一次：嵌入发生在 setContentSize 之后，上一轮 resize 可能已经把子窗口压下去了
        if (!isEmbeddedOnTop(hostHwnd, childHwnd)) raiseEmbedded(hostHwnd, childHwnd)
        // 建窗口/显示可能把宿主弄成置顶 —— 嵌入完成的这一刻先摘一次
        clearHostTopmost(hostHwnd)

        /*
         * 记下「投屏成功这一刻」的内容区尺寸 —— 这是「重置窗口大小」要恢复的值。
         *
         * 必须记在这里，不能记得更早：:262 那次 setContentSize 用的是
         * measureStableVideoRect 量到的**实测**视频尺寸，早于它记到的是
         * 建窗时的推算值（竖屏 MI 6：推算 523×900 vs 实测 539×900）。
         * 记早一步，重置就会把窗口缩窄 16px，那 16px 被 fitRect 摊成上下各 17px
         * 黑边 —— 正是用户报的缺陷。
         */
        const [defaultWidth, defaultHeight] = win.getContentSize()
        entry.defaultSize = { width: defaultWidth, height: defaultHeight }

        /*
         * 到这一步画面已经在窗口里、位置和尺寸都已定型 —— 第一次显示就是最终样子。
         * 顺序不能颠倒：先 show 再嵌的话，用户会先看到一个没有画面的空窗口。
         */
        revealOnce()
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
       * 恢复的是「投屏成功那一刻」记下的内容区尺寸，不再拿 session.screen 重算。
       *
       * ===== 为什么不再重算（用户报的缺陷：点重置后画面上下各多一条黑边）=====
       * 旧实现用 videoSizeFor(entry.session.screen, DEFAULT_MAX_SIZE) → windowFitSize
       * 重算，看着与 open() 是同一套算式，其实不是：
       *   - open() 的最终尺寸来自 measureStableVideoRect 量到的**实测**视频尺寸；
       *   - 重算用的是会话探测到的屏幕尺寸按 --max-size 折算的**推算**值。
       * 竖屏 MI 6 上两者差 16px（实测 539×900 vs 推算 523×900），
       * 而 fitRect 会把这 16px 的缺口摊成上下各 17px 的黑带 —— 正是用户截图里的样子。
       * 记住实测值，重置就不会再和真实窗口对不上。
       *
       * 已知取舍（写在明处）：设备中途转屏后，重置回到的是「打开时的形状」。
       * 旧实现其实也没做成转屏适配 —— session.screen 在会话期内不会更新，
       * 重算用的永远是启动那一刻探测到的那一份。
       */
      const fallbackSize = (): void => {
        const video = videoSizeFor(entry.session.screen, DEFAULT_MAX_SIZE)
        const size = windowFitSize(
          video.width,
          video.height,
          screen.getDisplayMatching(entry.win.getBounds()).scaleFactor,
        )
        entry.win.setContentSize(size.width, size.height)
      }

      /*
       * 最大化 / 全屏状态下 setContentSize 是空操作。
       * 不先还原，用户点了重置会觉得「完全没反应」—— 窗口还是铺满屏幕那个样子。
       */
      if (entry.win.isFullScreen()) entry.win.setFullScreen(false)
      if (entry.win.isMaximized()) entry.win.unmaximize()

      // defaultSize 为 null 只出现在「嵌入还没走完就点了重置」，此时退回旧算式
      if (entry.defaultSize === null) fallbackSize()
      else entry.win.setContentSize(entry.defaultSize.width, entry.defaultSize.height)

      /*
       * 嵌入的子窗口不会跟着窗口自己变 —— 必须显式 MoveWindow。
       *
       * 顺序：先设窗口尺寸，再摆子窗口。反过来的话 fitRect 用的是**旧的**
       * 客户区大小，画面会按旧尺寸居中，看起来像"重置没生效"。
       *
       * 画面宽高比取**子窗口的实测尺寸**：设备转屏后 scrcpy 会自己改子窗口大小，
       * 这时若还按 session.screen 推算，转屏后的画面会被拉扁。量不到再回退会话值。
       */
      if (entry.embedded !== null) {
        const childRect = windowRectOf(entry.embedded.childHwnd)
        const measuredWidth = childRect === null ? 0 : childRect.right - childRect.left
        const measuredHeight = childRect === null ? 0 : childRect.bottom - childRect.top
        const video =
          measuredWidth > 0 && measuredHeight > 0
            ? { width: measuredWidth, height: measuredHeight }
            : videoSizeFor(entry.session.screen, DEFAULT_MAX_SIZE)
        resizeEmbedded(
          entry.embedded.childHwnd,
          fitRect(hostArea(entry.win), video.width, video.height),
        )
      }
    },
  }
}

/**
 * z 序/置顶看门狗的轮询周期（毫秒）。
 *
 * 两个恢复延迟都由它决定：子窗口被压住后多久能再点、宿主被置顶后多久让位。
 * 500ms 对人眼来说察觉不到，而再小没有收益（人手一次点击的间隔远大于它），
 * 只会多读几次窗口样式。
 */
const ZORDER_WATCHDOG_MS = 500

/**
 * 「点了投屏但窗口迟迟不出现」的兜底上限（毫秒）。
 *
 * findWindowByTitle 自己最多等 10 秒（scrcpy 冷启动实测 6–8 秒），这里留 2 秒余量。
 * 兜底一提早，就会在 scrcpy 只是慢的机器上抢先把「等待中」的空窗口推出来 ——
 * 那正是我们要消除的东西。
 */
const REVEAL_TIMEOUT_MS = 12_000

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
