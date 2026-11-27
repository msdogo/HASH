import { SIDEBAR_KEYS, type DeviceKey } from '@shared/device-key'
import { t } from '@shared/i18n'
import { ArrowLeft, Circle, Home, Layers, Volume1, Volume2 } from 'lucide-react'

/**
 * 投屏窗口左侧的竖排按键栏（六个键）。
 *
 * ===== 为什么这些键不放在主窗口 =====
 * 投屏是一场「对着手机画面」的操作：按返回键时用户的眼睛在画面上，
 * 手却要移到另一个窗口去点 —— 这个来回会让「用投屏调设备」变得比直接拿手机还慢。
 * 按键与画面在同一个窗口里，才是投屏真正省事的地方。
 *
 * ===== 为什么正好六个 =====
 * 用户裁决的是「返回 / 主页 / 后台」这三个必需的导航键，加上音量与电源
 * （调试时经常需要亮屏/熄屏、调音量）。少一个就会有「还是得拿手机」的动作，
 * 多一个（比如菜单键）则几乎没人用，反而稀释了常用键的可点面积。
 */

/** 键 → 图标。顺序无关（顺序由 SIDEBAR_KEYS 决定）。 */
const ICONS: Record<DeviceKey, typeof ArrowLeft> = {
  back: ArrowLeft,
  home: Home,
  recents: Layers,
  volumeDown: Volume1,
  volumeUp: Volume2,
  power: Circle,
}

/**
 * 键 → i18n 文案键。
 *
 * 用表而不是模板字符串拼：拼出来的键名（'mirror.key.' + key）在
 * 新增按键时不会漏登记，而表会在 typescript 层报「少一个键」。
 */
const LABELS: Record<DeviceKey, string> = {
  back: 'mirror.key.back',
  home: 'mirror.key.home',
  recents: 'mirror.key.recents',
  volumeDown: 'mirror.key.volumeDown',
  volumeUp: 'mirror.key.volumeUp',
  power: 'mirror.key.power',
}

export interface MirrorSidebarProps {
  /** 按下某个键（父级负责调 window.api.device.pressKey）。 */
  onPress: (key: DeviceKey) => void
  /** 正在发送中的键（防连点；同一时刻只允许一个在飞）。 */
  busyKey?: DeviceKey | null
  /** 设备是否可用（离线时全部禁用，而不是让用户点了没反应）。 */
  disabled?: boolean
}

export function MirrorSidebar(props: MirrorSidebarProps) {
  return (
    <nav
      aria-label={t('mirror.open')}
      /*
       * 颜色与主应用的设备栏一致（浅底 #F0F2F5 + neutral-300 分隔线）。
       * 边框在**左**侧：这块按键栏在画面右边，分隔线要贴着画面那一侧。
       */
      className="flex w-14 shrink-0 flex-col items-center gap-1 border-l border-neutral-300 bg-[#F0F2F5] py-2"
    >
      {SIDEBAR_KEYS.map((key) => {
        const Icon = ICONS[key]
        const label = t(LABELS[key])
        const busy = props.busyKey === key
        return (
          <button
            key={key}
            type="button"
            title={label}
            aria-label={label}
            disabled={props.disabled === true || (props.busyKey !== undefined && props.busyKey !== null)}
            onClick={() => { props.onPress(key) }}
            className={
              'flex h-10 w-10 items-center justify-center rounded-md transition-colors ' +
              (props.disabled === true
                ? 'cursor-not-allowed text-neutral-400'
                : busy
                  ? 'bg-neutral-300 text-neutral-900'
                  : 'text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900 active:bg-neutral-300')
            }
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </button>
        )
      })}
    </nav>
  )
}
