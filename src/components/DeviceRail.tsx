import { useEffect } from 'react'
import { DOT_CLASS, DOT_LABEL_KEY, deviceLabel, hasUnauthorized, serialTail, statusDot, summarize } from '@shared/device-view'
import { errorText, t, tf } from '@shared/i18n'
import type { AdbState, DeviceSession } from '@shared/types'
import { useDeviceStore } from '@/store/deviceStore'

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
  onShowOverview?: () => void
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

  // 空状态与 adb 故障是两种不同的事，提示必须分开给
  const adbBroken = adb !== null && adb.state === 'error'
  const adbChecking = adb === null || adb.state === 'checking'

  const summary = summarize(devices)
  // 判断走 shared 的纯函数（I6）：不在组件里内联 any()/some() 判断，避免与 summarize 的二套逻辑漂移
  const showUnauthorizedHint = hasUnauthorized(devices)
  // 错误码翻译统一走 i18n 的集中表（裁决 3），组件里不出现硬编码文案
  const adbCode = adb !== null && adb.state === 'error' ? adb.code : ''

  return (
    <aside className="flex w-[200px] shrink-0 flex-col border-r border-neutral-800 bg-[#1B1E27]">
      <div className="flex items-baseline justify-between px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-400">{t('devices.title')}</h2>
        <span className="text-[11px] text-neutral-600">{summary.total}</span>
      </div>

      {adbBroken && (
        <div className="mx-2 mb-2 rounded border border-amber-800/60 bg-amber-950/40 px-2 py-1.5 text-[11px] leading-snug text-amber-300">
          <div className="font-medium">{t('devices.adbUnusable')}</div>
          <div className="mt-0.5 text-amber-400/80">{errorText(adbCode)}</div>
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
              className={
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ' +
                (active
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-800/60')
              }
            >
              <span className={'h-2 w-2 shrink-0 rounded-full ' + DOT_CLASS[dot]} />
              {/* 裁决 9：有型号显示型号，没有回退 serial 后 4 位 */}
              <span className="truncate">{deviceLabel(device)}</span>
              <span className="ml-auto shrink-0 text-[11px] tabular-nums text-neutral-600">
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
          <p className="px-3 py-2 text-[11px] leading-snug text-amber-400/80">
            {t('devices.unauthorizedHint')}
          </p>
        )}
      </nav>

      {/* 规格 §9.2：底部固定「全部设备」入口（任务 10 的总览页从这里进） */}
      <button
        type="button"
        onClick={props.onShowOverview}
        className="border-t border-neutral-800 px-3 py-2 text-left text-xs text-neutral-400 hover:bg-neutral-800/60"
      >
        {t('devices.all')}
      </button>

      <div className="border-t border-neutral-800 px-3 py-2 text-[11px] leading-relaxed text-neutral-500">
        {tf('devices.summary', { total: summary.total, online: summary.online })}
      </div>
    </aside>
  )
}