import { DeviceRail } from './components/DeviceRail'
import { TransferDock } from './components/TransferDock'
import { FilesPage } from '@/pages/FilesPage'
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
        {/* 文件页自己管理滚动（虚拟列表需要真正的滚动容器），所以这里不加 padding / overflow */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <FilesPage />
        </main>
      </div>
      {/* 传输底栏横跨整宽：任何页面都能看到进度，不必切页（规格：底栏展示） */}
      <TransferDock />
    </div>
  )
}

export default App