import { useEffect, useState } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { t } from '@shared/i18n'

/**
 * 窗口右上角的三个按钮（最小化 / 最大化↔还原 / 关闭）。
 *
 * ===== 为什么必须自己做 ===== 
 * 窗口用 frame:false 创建，系统标题栏整条（含那三个系统按钮）都不存在了。
 * 不自己实现的话，用户只能靠 Alt+F4 关程序 —— 这不是「更简洁」，是残废。
 *
 * ===== 三个行为约定 ===== 
 *   - 关闭 = 退到后台（窗口隐藏、托盘图标常驻），不是退出程序。
 *     真正退出走托盘菜单的「退出」—— 关窗口时设备可能正在传输，
 *     直接杀进程会让传到一半的文件变成残片。
 *   - 最大化与还原是**同一个按钮**，图标跟着真实状态换。
 *   - 状态以主进程为准：双击标题栏、Win+↑ 都能改变它，渲染层不自己记。
 *
 * ===== 尺寸约定 ===== 
 * 三个按钮是 h-full：顶栏多高它们就多高，与 Windows 原生标题栏的观感一致。
 * 早先写死 h-8（32px）而顶栏是 py-2 撑开的 40px，于是按钮上下各留 4px 空隙 ——
 * 右上角那块「悬浮的小方块」就是它（用户实测反馈的第一条）。
 */
export interface WindowControlsProps {
  /** 渲染期注入（本工程没有 jsdom，SSR 只能靠注入断言形态）。 */
  initial?: { maximized?: boolean }
  /**
   * 是否画最大化按钮。
   *
   * 设置窗口传 false：它的内容是两块固定高度的信息，最大化只会变成一片空白，
   * 而「能点但没用的按钮」比「少一个按钮」更让人困惑。主进程侧也把
   * maximizable 关掉了，两处一致。
   */
  allowMaximize?: boolean
}

export function WindowControls(props: WindowControlsProps = {}) {
  const allowMaximize = props.allowMaximize ?? true
  const [maximized, setMaximized] = useState(props.initial?.maximized ?? false)

  useEffect(() => {
    /*
     * 两路来源：首屏问一次主进程，之后靠推送（双击标题栏 / 系统快捷键也会变）。
     * 只问不订阅的话，用户双击最大化之后我们的图标会停在「最大化」上。
     */
    void window.api.window.isMaximized().then((result) => {
      if (result.ok) setMaximized(result.data)
    })
    return window.api.window.onMaximizedChanged((next) => { setMaximized(next) })
  }, [])

  return (
    <div className="flex h-full items-stretch">
      <button
        type="button"
        onClick={() => { void window.api.window.minimize() }}
        title={t('window.minimize')}
        aria-label={t('window.minimize')}
        className="flex w-10 items-center justify-center text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900"
      >
        <Minus className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {allowMaximize && (
      <button
        type="button"
        onClick={() => {
          void window.api.window.toggleMaximize().then((result) => {
            if (result.ok) setMaximized(result.data)
          })
        }}
        title={maximized ? t('window.restore') : t('window.maximize')}
        aria-label={maximized ? t('window.restore') : t('window.maximize')}
        className="flex w-10 items-center justify-center text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900"
      >
        {maximized
          ? <Copy className="h-3 w-3" aria-hidden="true" />
          : <Square className="h-3 w-3" aria-hidden="true" />}
      </button>
      )}
      <button
        type="button"
        onClick={() => { void window.api.window.close() }}
        title={t('window.close')}
        aria-label={t('window.close')}
        className="flex w-10 items-center justify-center text-neutral-600 hover:bg-red-500 hover:text-white"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}