import { SettingsPage } from '@/pages/SettingsPage'
import { WindowControls } from './WindowControls'
import { t } from '@shared/i18n'

/**
 * 设置子窗口的外壳。
 *
 * ===== 为什么要有这一层 =====
 * SettingsPage 是「内容」，不负责窗口边界。独立窗口需要自己的自绘顶栏
 * （标题 + 三个按钮）—— 因为主窗口用的是 frame:false，子窗口同理，
 * 系统标题栏同样不存在。把外壳与内容分开，SettingsPage 才能在测试里被单独渲染。
 *
 * ===== 出口只有一个 =====
 * 右上角 ×。设置页内部**不再有「返回」按钮**：它曾经是页面时代的必需品（R3-1），
 * 现在独立窗口的 × 就是它 —— 同一个动作画两遍只会让人猜两者有什么区别。
 */
export interface SettingsWindowProps {
  /** 渲染期注入（本工程没有 jsdom，SSR 只能靠注入断言形态）。 */
  initial?: { maximized?: boolean }
}

export function SettingsWindow(props: SettingsWindowProps = {}) {
  return (
    <div className="flex h-screen flex-col">
      <header
        className="flex h-10 shrink-0 items-stretch border-b border-neutral-300 pl-4"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="flex items-center text-xs font-medium text-neutral-700">{t('settings.title')}</span>
        <span
          className="ml-auto flex items-center"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/*
            * 设置窗口不给最大化按钮。
            *
            * 理由：它的内容是两块固定高度的信息，最大化只会变成一大片空白；
            * 而「多一个能点但没用的按钮」比「少一个按钮」更让人困惑。
            * 主进程侧也把 maximizable 关掉了，这里连按钮都不画。
            */}
          <WindowControls allowMaximize={false} initial={props.initial} />
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <SettingsPage />
      </div>
    </div>
  )
}