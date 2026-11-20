import { useState } from 'react'
import { DeviceRail } from './components/DeviceRail'
import { TransferDock } from './components/TransferDock'
import { FilesPage } from '@/pages/FilesPage'
import { OverviewPage } from '@/pages/OverviewPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { Settings } from 'lucide-react'
import { useDeviceStore } from '@/store/deviceStore'
import { deviceLabel } from '@shared/device-view'
import { t } from '@shared/i18n'

/**
 * 页面路由（任务 10；R2-2 加设置页）。
 *
 * 三页：「当前设备」（文件页）、「全部设备」（总览页）与「设置」（默认下载路径 + adb 状态）。
 *
 * 为什么用一个 useState 而不是引入 react-router：
 * 应用只有两个互斥视图、没有 URL 语义、也不需要前进后退 ——
 * 引入路由库会给 Electron 的 file/app 协议再加一层「路径从哪来」的问题。
 *
 * 状态放在 App 而不是 store：它是**纯视图选择**，没有任何业务方需要读它；
 * 放 store 会让「当前在哪一页」变成一个可以被任意模块写入的全局变量。
 * DeviceRail 的「全部设备」入口通过 onShowOverview 回传（父级持有状态）。
 */
type Page = 'files' | 'overview' | 'settings'

export function App() {
  const activeSerial = useDeviceStore((state) => state.activeSerial)
  const devices = useDeviceStore((state) => state.devices)
  const active = devices.find((device) => device.serial === activeSerial)
  const [page, setPage] = useState<Page>('files')

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2">
        <h1 className="text-sm font-semibold text-neutral-200">{t('app.name')}</h1>
        {/* 顶栏页签：当前设备 / 全部设备 */}
        <nav className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => { setPage('files') }}
            className={
              'rounded px-2 py-0.5 text-xs ' +
              (page === 'files' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:bg-neutral-800/60')
            }
          >
            {t('nav.files')}
          </button>
          <button
            type="button"
            onClick={() => { setPage('overview') }}
            className={
              'rounded px-2 py-0.5 text-xs ' +
              (page === 'overview' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:bg-neutral-800/60')
            }
          >
            {t('nav.overview')}
          </button>
        </nav>
        {page === 'files' && active !== undefined && (
          <span className="text-xs text-neutral-500">
            {deviceLabel(active)}
            {active.android !== undefined && ' · Android ' + active.android}
          </span>
        )}
        {/*
          * 设置入口（R2-2）。
          *
          * 规格 §9.1 的顶栏线框图里 ⚙设置 在右侧，所以用 ml-auto 推到右端，
          * 与左侧的页签分开 —— 它不是「第三个同级的列表页」，而是一个独立的功能页。
          */}
        <button
          type="button"
          onClick={() => { setPage('settings') }}
          title={t('nav.settings')}
          aria-label={t('nav.settings')}
          className={
            'ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-xs ' +
            (page === 'settings' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:bg-neutral-800/60')
          }
        >
          <Settings className="h-3.5 w-3.5" aria-hidden="true" />
          {t('nav.settings')}
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <DeviceRail onShowOverview={() => { setPage('overview') }} />
        {/* 文件页自己管理滚动（虚拟列表需要真正的滚动容器），所以这里不加 padding / overflow */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/*
           * 两页互斥渲染：切走时另一页**会被卸载**。
           *
           * 修前这里的注释写着「不是卸载」，与代码相反（复审 Minor 2）。
           * 实际行为是卸载 —— 也就是切到总览页再切回来，文件页会重新挂载。
           * 这不影响正确性（滚动位置与选中项存在 fileStore 里，不在组件 state），
           * 但注释必须说实话。
           */}
          {page === 'files'
            ? <FilesPage />
            : page === 'overview'
              ? <OverviewPage />
              : <SettingsPage />}
        </main>
      </div>
      {/* 传输底栏横跨整宽：任何页面都能看到进度，不必切页（规格：底栏展示） */}
      <TransferDock />
    </div>
  )
}

export default App