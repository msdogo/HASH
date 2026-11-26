import { useState } from 'react'
import { DOT_CLASS, DOT_LABEL_KEY, deviceLabel, hasUnauthorized, serialTail, statusDot, summarize } from '@shared/device-view'
import { deviceMenuItemsFor, type DeviceMenuAction } from '@shared/device-menu'
import { errorText, t, tf } from '@shared/i18n'
import type { AdbState, DeviceSession } from '@shared/types'
import { useDeviceStore } from '@/store/deviceStore'
import { useMirrorStore } from '@/store/mirrorStore'

/**
 * 左侧设备栏（规格 9.2）。
 *
 * 组件只负责渲染 —— 状态点映射、型号回退、排序、统计全部来自 @shared/device-view 的纯函数，
 * 那些函数有单测；这里没有一行需要测试的判断逻辑（裁决 8）。
 *
 * 文案一律走 i18n：设备栏要显示「无法使用 adb」时走 errorText(adb.code)，
 * 不得在组件里硬编码中文（tests/ui-contract.test.ts 静态断言守着）。
 */
export interface DeviceRailProps {
  /**
   * 点某台设备之后的通知（R3-1）。
   *
   * 组件只负责「把点了哪台报上去」，去哪一页由父级决定（App 用
   * @shared/nav 的 pageAfterSelectDevice 判：永远是文件页，目录与滚动位置
   * 由 fileStore 的 serial 分片恢复）。
   *
   * **可选**，且调用点在 setActive 之后：生产不传时行为与改前逐字相同
   * （只切 activeSerial、不动页面）。pickRailData 那套注入逻辑完全不经过它。
   */
  onSelectDevice?: (serial: string) => void
  /**
   * 渲染期注入（与 OverviewPage 的 initial 同一手法，终审 I-4）。
   *
   * 为什么需要：zustand 的 useSyncExternalStore 在 SSR 下取 getServerSnapshot
   * （初始快照），renderToStaticMarkup 里 setState 反映不到渲染结果。于是
   * 「未授权设备要不要显示「请在手机上允许 USB 调试」」这一条只能靠读源码文本断言
   * —— 而注释也是源码文本。允许注入后就能真渲染两种设备表，比较输出。
   *
   * 生产不传 → 与改前逐字相同（读 store）。
   */
  initial?: Partial<{ devices: DeviceSession[]; adb: AdbState | null; activeSerial: string | null; loaded: boolean }>
}

/** 渲染所需的数据切片（来自 store 或注入）。 */
interface RailData {
  devices: DeviceSession[]
  adb: AdbState | null
  activeSerial: string | null
  loaded: boolean
}

/**
 * 决定「这一屏渲染什么数据」：注入优先，缺哪个字段就用 store 的对应字段。
 *
 * 【合并前复审 I / 生产路径门禁】为什么单列成纯函数：
 * 复审实测两个变异都 **1203 全绿** ——
 *   - `props.initial?.devices ?? store.devices` → `?? []`（生产上设备栏永远空）
 *   - `props.initial !== undefined ? … : store…` 整个方向写反
 * 即「注入点写错时没有一条用例会红」。抽成纯函数后
 * tests/component-wiring.test.tsx 直接喂两种入参，断言
 * 「initial 为 undefined 时必须原样拿 store 的四个字段」（包括 devices 引用相等），
 * 上述两种变异都会红。
 *
 * 注意：这里仍用逐字段 `??`（而不是「initial 有值就整份替换」）——
 * 与改前逐字等价，注入只给部分字段时其余字段继续读 store。
 */
export function pickRailData(
  initial: DeviceRailProps['initial'],
  store: RailData,
): RailData {
  return {
    devices: initial?.devices ?? store.devices,
    adb: initial?.adb ?? store.adb,
    activeSerial: initial?.activeSerial ?? store.activeSerial,
    loaded: initial?.loaded ?? store.loaded,
  }
}

export function DeviceRail(props: DeviceRailProps) {
  const store = useDeviceStore()
  const { devices, adb, activeSerial, loaded } = pickRailData(props.initial, {
    devices: store.devices,
    adb: store.adb,
    activeSerial: store.activeSerial,
    loaded: store.loaded,
  })
  const setActive = store.setActive
  /*
   * 投屏会话镜像（只读）：右键菜单据此在「投屏」与「关闭投屏」之间切换。
   *
   * 订阅是全局的（src/main.tsx 的 subscribeMirrorChanges），这里只读快照 ——
   * 组件自己 invoke 一次 list 会拿到与其它组件不同时刻的状态。
   */
  const mirroring = useMirrorStore((state) => state.sessions)

  /**
   * 右键菜单的状态（哪台设备、在屏幕哪个点）。
   *
   * 放组件 state 而不是 store：它是一次瞬时的界面动作，
   * 没有任何其它模块需要读「菜单现在开着吗」。
   */
  const [menu, setMenu] = useState<{ serial: string; x: number; y: number } | null>(null)

  /**
   * 执行右键菜单动作。
   *
   * 失败只打到 console：设备栏没有提示区（提示统一在传输底栏），
   * 而把「投屏失败」的文案塞进别处会出现「提示位置随功能而异」的混乱。
   * 主进程同时会推 failed 事件，投屏窗口那边有更完整的说明。
   */
  const runMenuAction = (serial: string, action: DeviceMenuAction): void => {
    setMenu(null)
    if (action === 'mirrorStop') {
      void window.api.mirror.stop({ serial })
      return
    }
    void window.api.mirror.start({ serial }).then((result) => {
      /*
       * 失败时只把错误码打到 console（设备栏没有提示区，见上），
       * 用户可见的说明由投屏窗口与工具条负责。
       * 这里刻意不写中文文案：本组件受 ui-contract 的「文案全部走 i18n」静态断言约束。
       */
      if (!result.ok) console.warn('[mirror] start failed: ' + result.error)
    })
  }

  // 空状态与 adb 故障是两种不同的事，提示必须分开给
  const adbBroken = adb !== null && adb.state === 'error'
  const adbChecking = adb === null || adb.state === 'checking'

  const summary = summarize(devices)
  // 判断走 shared 的纯函数（I6）：不在组件里内联 any()/some() 判断，避免与 summarize 的二套逻辑漂移
  const showUnauthorizedHint = hasUnauthorized(devices)
  // 错误码翻译统一走 i18n 的集中表（裁决 3），组件里不出现硬编码文案
  const adbCode = adb !== null && adb.state === 'error' ? adb.code : ''

  return (
    <aside className="flex w-[200px] shrink-0 flex-col border-r border-neutral-300 bg-[#F0F2F5]">
      <div className="flex items-baseline justify-between px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-600">{t('devices.title')}</h2>
        <span className="text-[11px] text-neutral-400">{summary.total}</span>
      </div>

      {adbBroken && (
        <div className="mx-2 mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-700">
          <div className="font-medium">{t('devices.adbUnusable')}</div>
          <div className="mt-0.5 text-amber-600/80">{errorText(adbCode)}</div>
        </div>
      )}

      <nav className="flex-1 overflow-y-auto">
        {devices.map((device) => {
          const dot = statusDot({ status: device.status, transport: device.transport })
          const active = device.serial === activeSerial
          return (
            <button
              key={device.serial}
              type="button"
              onClick={() => {
                setActive(device.serial)
                // R3-1：可选回调。不传时行为与改前逐字相同（只切 activeSerial）
                props.onSelectDevice?.(device.serial)
              }}
              title={device.serial + ' · ' + t(DOT_LABEL_KEY[dot])}
              /*
               * 右键：弹「投屏 / 关闭投屏」。
               *
               * 与左键的分工：左键 = 切到这台设备（改 activeSerial + 回文件页），
               * 右键 = 对这台设备做动作，不改变当前选中。
               * 这正是资源管理器的惯例 —— 用户不需要学。
               */
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({ serial: device.serial, x: event.clientX, y: event.clientY })
              }}
              className={
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ' +
                (active
                  ? 'bg-neutral-200 text-neutral-900'
                  : 'text-neutral-600 hover:bg-neutral-200/70')
              }
            >
              <span className={'h-2 w-2 shrink-0 rounded-full ' + DOT_CLASS[dot]} />
              {/* 裁决 9：有型号显示型号，没有回退 serial 后 4 位 */}
              <span className="truncate">{deviceLabel(device)}</span>
              <span className="ml-auto shrink-0 text-[11px] tabular-nums text-neutral-400">
                {serialTail(device.serial)}
              </span>
            </button>
          )
        })}

        {loaded && devices.length === 0 && !adbBroken && (
          <p className="px-3 py-4 text-xs leading-relaxed text-neutral-500">{t('devices.empty')}</p>
        )}
        {adbChecking && (
          <p className="px-3 py-4 text-xs text-neutral-500">{t('devices.adbChecking')}</p>
        )}
        {showUnauthorizedHint && (
          <p className="px-3 py-2 text-[11px] leading-snug text-amber-600/80">
            {t('devices.unauthorizedHint')}
          </p>
        )}
      </nav>

      {/*
        * 这里原本有一个「全部设备」按钮（规格 §9.2 的入口）。
        * 删掉的原因：顶栏已经有同名页签，同一个入口画两遍会让左下角看起来像
        * 「还有一个没打开的页面」，而它其实只是另一个按钮。
        * 底部保留的那行是**统计**（共 N 台 · M 台在线），不是入口，所以留着。
        */}
      {/*
        右键菜单。
        不做成通用 ContextMenu 组件（那个是文件列表专用的：菜单项、图标、动作 id
        都与文件强绑定），设备栏只有一项动作，画一个小浮层更直接、也不会
        为了复用而把两边的语义硬凑在一起。
      */}
      {menu !== null && (() => {
        const target = devices.find((device) => device.serial === menu.serial)
        const items = deviceMenuItemsFor(
          target !== undefined && target.status === 'device',
          mirroring[menu.serial] !== undefined,
        )
        if (items.length === 0) return null
        return (
          <div
            role="menu"
            className="fixed z-50 min-w-[120px] rounded border border-neutral-300 bg-white py-0.5 shadow-lg"
            style={{ left: String(menu.x) + 'px', top: String(menu.y) + 'px' }}
            onMouseLeave={() => { setMenu(null) }}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                onClick={() => { runMenuAction(menu.serial, item.id) }}
                className="flex w-full items-center px-3 py-1 text-left text-xs text-neutral-700 hover:bg-neutral-100"
              >
                {t(item.labelKey)}
              </button>
            ))}
          </div>
        )
      })()}
      <div className="border-t border-neutral-300 px-3 py-2 text-[11px] leading-relaxed text-neutral-500">
        {tf('devices.summary', { total: summary.total, online: summary.online })}
      </div>
    </aside>
  )
}