import { useCallback, useEffect, useState } from 'react'
import { MirrorSidebar } from './MirrorSidebar'
import { errorText, t, tf } from '@shared/i18n'
import type { DeviceKey } from '@shared/device-key'
import type { MirrorEvent } from '@shared/mirror'
import { WindowControls } from './WindowControls'
import { useDeviceStore } from '@/store/deviceStore'
import { deviceLabel } from '@shared/device-view'

/**
 * 投屏窗口（每台设备一个）。
 *
 * ===== 布局 =====
 * 顶栏（拖动区 + 关闭按钮）+ 主体：左侧 56px 侧边栏，右侧**故意留空**。
 *
 * 右侧那块空白由主进程用 SetParent 把 scrcpy 的原生窗口嵌进去
 * （见 electron/mirror/window.ts）。所以这里绝不能在那块区域画任何东西 ——
 * 原生子窗口永远画在渲染层之上，画了也看不见，只会让人误以为「那里该有内容」。
 *
 * ===== serial 从哪来 =====
 * 主进程用 loadView(win, '#/mirror/<serial>') 打开，
 * 这里读 location.hash 解析。与设置窗口同一手法（不打第二个 HTML 入口）。
 */
export interface MirrorWindowProps {
  /**
   * 渲染期注入（本工程没有 jsdom，SSR 只跑一次 render）。
   *
   * 生产不传 → 从 location.hash 解析。
   */
  initial?: { serial?: string; model?: string }
}

/** 从 hash 里解析设备序列号；不是投屏窗口时返回空串。 */
export function serialFromHash(hash: string): string {
  const prefix = '#/mirror/'
  if (!hash.startsWith(prefix)) return ''
  try {
    return decodeURIComponent(hash.slice(prefix.length))
  } catch {
    // 非法百分号编码：当成没有 serial（窗口会显示「未指定设备」而不是白屏崩掉）
    return ''
  }
}

export function MirrorWindow(props: MirrorWindowProps = {}) {
  const serial = props.initial?.serial ?? (
    typeof location === 'undefined' ? '' : serialFromHash(location.hash)
  )
  /*
   * 设备型号从设备表里取。
   *
   * 为什么不从主进程的会话里取：会话里也有 title（型号 + 尾号），
   * 但它在 scrcpy 起来之后才通过 started 事件到达 —— 那之前顶栏是空的。
   * 设备表在应用启动时就已经有了，从它取能让顶栏从第一帧就显示名字。
   *
   * initial.model 是**测试注入口**（与 DeviceRail 的 initial 同一手法）：
   * zustand 在 SSR 下用的是 getInitialState（不是 getState），
   * 所以 renderToStaticMarkup 里读不到 setState 之后的设备表 ——
   * 只能靠注入把「有型号」这条路径变成真渲染门禁。生产不传。
   */
  const storeModel = useDeviceStore(
    (state) => state.devices.find((device) => device.serial === serial)?.model,
  )
  const model = props.initial?.model ?? storeModel
  const [busyKey, setBusyKey] = useState<DeviceKey | null>(null)
  const [notice, setNotice] = useState('')
  const [ready, setReady] = useState(false)

  /*
   * 会话状态：主进程推 started/exited/failed。
   *
   * 这里只关心「这台设备的会话是不是还活着」——
   * 会话结束后窗口由主进程关闭，所以正常情况下不会看到 exited；
   * 但失败时要给出一条能看懂的原因，而不是一个静默的黑窗口。
   */
  useEffect(() => {
    if (!window.api?.mirror) return
    const off = window.api.mirror.onChanged((event: MirrorEvent) => {
      if (event.kind === 'failed' && event.serial === serial) {
        setNotice(errorText(event.code))
      }
      // started 事件带的是整个会话（不是单个 serial 字段），判定要读 session.serial
      if (event.kind === 'started' && event.session.serial === serial) {
        setReady(true)
      }
    })
    return off
  }, [serial])

  const press = useCallback(async (key: DeviceKey) => {
    if (serial === '' || busyKey !== null) return
    setBusyKey(key)
    try {
      const result = await window.api.device.pressKey({ serial, key })
      if (!result.ok) setNotice(errorText(result.error))
    } finally {
      setBusyKey(null)
    }
  }, [serial, busyKey])

  return (
    <div className="flex h-screen flex-col bg-[#F7F8FA]">
      {/*
        顶栏：拖动区 + 关闭按钮。
        窗口是 frame:false —— 没有系统标题栏，用户唯一的「拖走/关掉」入口就在这里。
        双击最大化由系统接管（app-region: drag 区域）。
      */}
      <header
        className="flex h-9 shrink-0 items-stretch gap-2 border-b border-neutral-300 bg-[#F7F8FA] pl-3"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {/*
          * items-stretch 而不是 items-center —— 这一条同时解决两件事：
          *
          * ① 右上角三个按钮必须撑满顶栏高度。用 items-center 时，那个
          *    「ml-auto」的容器高度由内容决定，里面的 WindowControls 虽然写了
          *    h-full，100% 也只是撑到内容高度 —— 三个按钮于是变成顶栏中间
          *    一撮悬空的小方块。主应用顶栏用的就是 items-stretch（见 App.tsx），
          *    这里照抄，两处观感才一致。
          * ② 颜色与主应用一致（浅底 + neutral-300 分隔线），不再是深色条。
          *
          * 文字另包一层 items-center：拉伸是给按钮容器的，文字本身仍要垂直居中。
          */}
        <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-xs text-neutral-900">{t('mirror.running')}</span>
        {serial !== '' && (
          /*
           * 显示**设备名**而不是完整序列号。
           *
           * 序列号对用户没有意义（9N9CN2G0012A3P 这种谁也记不住），
           * 而型号（DJI RC PLUS 2）一眼就知道是哪台机器 —— 与设备栏、
           * 日志行用的是同一套 deviceLabel 口径，三处显示的永远是同一个名字。
           *
           * 完整序列号放进 title：需要区分两台同型号设备时，悬停就能看到；
           * 而主界面上不再被一串十六进制噪声占掉。
           */
          <span className="truncate text-[11px] text-neutral-500" title={serial}>
            {deviceLabel({ serial, model })}
          </span>
        )}
        </span>
        <span
          className="ml-auto flex items-stretch"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <WindowControls />
        </span>
      </header>

      {/*
        主体：左画面、右按键。
        顺序必须与 electron/mirror/window.ts 的 contentRect 一致（那边算的是
        「画面矩形 = 整个客户区减去右侧 SIDEBAR_WIDTH」）；两边各写一份却不一致时，
        表现是「画面压住了按键」或「按键与画面之间一条黑缝」，很难一眼看出原因。
      */}
      <div className="flex min-h-0 flex-1">
        {/*
          画面区：**空容器**。
          主进程会把 scrcpy 的原生窗口 SetParent 到这块矩形的上方。
          这里只放「还没就绪」的提示 —— 提示文字在嵌入完成前可见，
          嵌入完成后会被原生窗口完全盖住（所以不需要额外隐藏逻辑）。
        */}
        {/*
          * 画面区保持深色：它是一块**视频画布**，scrcpy 按宽高比居中后
          * 上下/左右会留出真正的留白（letterbox）。浅色留白会让画面像
          * 「贴在一张白纸上」，深色才是视频播放器该有的样子。
          * 顶栏与侧栏跟主应用统一，这一块刻意不跟 —— 理由是用途不同，不是遗漏。
          */}
        <div className="relative min-w-0 flex-1 bg-neutral-900">
          <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center text-xs leading-relaxed text-neutral-500">
            {notice !== '' ? notice : ready ? t('mirror.waiting') : t('mirror.opening')}
          </p>
        </div>
        <MirrorSidebar onPress={(key) => { void press(key) }} busyKey={busyKey} disabled={serial === ''} />
      </div>
      {notice !== '' && (
        <div className="shrink-0 border-t border-amber-700 bg-amber-900/40 px-3 py-1.5 text-[11px] leading-snug text-amber-200">
          {tf('mirror.embedFailed', { reason: notice })}
        </div>
      )}
    </div>
  )
}
