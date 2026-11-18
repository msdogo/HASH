import { useEffect } from 'react'
import { DOT_CLASS, DOT_LABEL_KEY, deviceLabel, serialTail, statusDot, summarize } from '@shared/device-view'
import { errorText, t, tf } from '@shared/i18n'
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
export function DeviceRail() {
  const { devices, adb, activeSerial, loaded, setActive } = useDeviceStore()

  // 空状态与 adb 故障是两种不同的事，提示必须分开给
  const adbBroken = adb !== null && adb.state === 'error'
  const adbChecking = adb === null || adb.state === 'checking'

  const summary = summarize(devices)
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
              onClick={() => { setActive(device.serial) }}
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
        {devices.some((d) => d.status === 'unauthorized') && (
          <p className="px-3 py-2 text-[11px] leading-snug text-amber-400/80">
            {t('devices.unauthorizedHint')}
          </p>
        )}
      </nav>

      <div className="border-t border-neutral-800 px-3 py-2 text-[11px] leading-relaxed text-neutral-500">
        {tf('devices.summary', { total: summary.total, online: summary.online })}
      </div>
    </aside>
  )
}