import { useEffect } from 'react'
import { DeviceRail } from './components/DeviceRail'
import { useDeviceStore } from '@/store/deviceStore'
import { deviceLabel } from '@shared/device-view'
import { t } from '@shared/i18n'

export function App() {
  const activeSerial = useDeviceStore((state) => state.activeSerial)
  const devices = useDeviceStore((state) => state.devices)
  const active = devices.find((device) => device.serial === activeSerial)

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2">
        <h1 className="text-sm font-semibold text-neutral-200">{t('app.name')}</h1>
        {active !== undefined && (
          <span className="text-xs text-neutral-500">
            {deviceLabel(active)}
            {active.android !== undefined && ' · Android ' + active.android}
          </span>
        )}
      </header>
      <div className="flex min-h-0 flex-1">
        <DeviceRail />
        <main className="flex-1 overflow-auto p-6 text-sm text-neutral-400">
          {active === undefined ? t('devices.empty') : active.serial}
        </main>
      </div>
    </div>
  )
}

export default App