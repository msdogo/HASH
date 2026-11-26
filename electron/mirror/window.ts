import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import type { MirrorSession } from '../../src/shared/mirror'
import { embedWindow, findWindowByTitle, resizeEmbedded, type EmbeddedWindow } from './embed'
import { SCRCPY_WINDOW_PREFIX } from '../../src/shared/mirror'

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

/** 侧边栏宽度（与 MirrorWindow.tsx 的 w-14 = 56px 必须一致）。 */
export const SIDEBAR_WIDTH = 56

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
        const result = embedWindow(hostHwnd, hwnd, contentRect(win))
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
          resizeEmbedded(result.window!.childHwnd, contentRect(win))
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

/**
 * 子窗口该占的矩形（设备像素）。
 *
 * Electron 给的 bounds 是 DIP（逻辑像素），而 MoveWindow 要的是物理像素 ——
 * 在 125%/150% 缩放的屏幕上直接用 DIP 会让画面比窗口小一圈（右下留白）。
 * 所以乘上该窗口所在显示器的 scaleFactor。
 */
function contentRect(win: BrowserWindow): { x: number; y: number; width: number; height: number } {
  const bounds = win.getContentBounds()
  const scale = screen.getDisplayMatching(bounds).scaleFactor
  const sidebar = Math.round(SIDEBAR_WIDTH * scale)
  return {
    x: sidebar,
    y: 0,
    width: Math.max(0, Math.round(bounds.width * scale) - sidebar),
    height: Math.round(bounds.height * scale),
  }
}
