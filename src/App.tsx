import { useState } from 'react'
import { DeviceRail } from './components/DeviceRail'
import { TransferDock } from './components/TransferDock'
import { LogBar } from './components/LogBar'
import { WindowControls } from './components/WindowControls'
import { SettingsWindow } from './components/SettingsWindow'
import { MirrorWindow, serialFromHash } from './components/MirrorWindow'
import { FilesPage } from '@/pages/FilesPage'
import { OverviewPage } from '@/pages/OverviewPage'
import { AppsPage } from '@/pages/AppsPage'
import { Settings } from 'lucide-react'
import appIcon from '@/assets/app-icon.png'
import { useDeviceStore } from '@/store/deviceStore'
import { deviceLabel } from '@shared/device-view'
import { t } from '@shared/i18n'
import { pageAfterAppsClick, pageAfterSelectDevice, settingsClickOpensWindow, type Page } from '@shared/nav'

/**
 * 应用入口 —— 同时是**两个窗口**的入口。
 *
 * ===== 为什么靠 hash 分流，而不是打两个 HTML 入口 =====
 * 主窗口与设置子窗口是同一份渲染包。多打一个入口意味着多一套构建产物、
 * 多一份 CSP 配置、多一处「preload 路径对不对」的问题；而两者的差别只有
 * 「渲染哪棵组件树」这一件事。hash 足够表达它，且不需要引入路由库。
 *
 * 主窗口：files / overview / apps 三页互斥（R3-1 起设置不再是一页）。
 * 设置窗口：#/settings → 只渲染 SettingsWindow（自绘顶栏 + 设置内容）。
 *
 * 状态放在 App 而不是 store：它是**纯视图选择**，没有任何业务方需要读它；
 * 放 store 会让「当前在哪一页」变成一个可以被任意模块写入的全局变量。
 */
export interface AppProps {
  /**
   * 渲染期注入（与 DeviceRail / SettingsPage 的 initial 同一手法）。
   *
   * 为什么需要：当前在哪一页是 useState 的内部状态，而本工程没有 jsdom ——
   * SSR 只跑一次 render、拿不到 onClick，也不存在「点一下再断言」。
   * 注入起始页之后，「page → 渲染哪一页」才有了真渲染门禁。
   *
   * 生产不传 → 首屏永远是文件页 / 按 location.hash 分流。
   */
  initial?: { page?: Page; settingsWindow?: boolean; mirrorSerial?: string }
}

/**
 * 当前是否是「投屏窗口」。
 *
 * 三种窗口共用同一份渲染包（主 / 设置 / 投屏），差别只有「渲染哪棵树」。
 * 与 isSettingsWindow 同一手法：生产读 hash，测试用 initial 注入。
 */
function mirrorSerialOf(props: AppProps): string {
  if (props.initial?.mirrorSerial !== undefined) return props.initial.mirrorSerial
  if (props.initial?.settingsWindow === true || props.initial?.page !== undefined) return ''
  if (typeof location === 'undefined') return ''
  return serialFromHash(location.hash)
}

/**
 * 当前是否是「设置窗口」。
 *
 * 生产读 location.hash（主进程用 loadURL('#/settings') 打开的那个窗口）；
 * 测试用 initial.settingsWindow 注入 —— SSR 下 location 不可控。
 */
function isSettingsWindow(props: AppProps): boolean {
  if (props.initial !== undefined && props.initial.settingsWindow !== undefined) {
    return props.initial.settingsWindow
  }
  return typeof location !== 'undefined' && location.hash === '#/settings'
}

export function App(props: AppProps = {}) {
  const activeSerial = useDeviceStore((state) => state.activeSerial)
  const devices = useDeviceStore((state) => state.devices)
  const active = devices.find((device) => device.serial === activeSerial)
  const [page, setPage] = useState<Page>(props.initial?.page ?? 'files')

  /*
   * 设置窗口：只渲染设置页。
   *
   * 关闭按钮 = window.close 命令（关闭即退出这条规则只针对主窗口；
   * 设置窗口关掉之后程序要继续跑，所以它的 close 走同一个 WINDOW_CLOSE ——
   * 主进程按 event.sender 找到是哪个窗口，关的就是它自己。
   */
  if (isSettingsWindow(props)) {
    return <SettingsWindow />
  }

  /*
   * 投屏窗口：只渲染投屏那一棵树。
   *
   * 判断放在设置之后：两者互斥，先判设置是为了让
   * 「initial.settingsWindow === true」这条注入路径不被 mirror 分支抢走。
   */
  const mirrorSerial = mirrorSerialOf(props)
  if (mirrorSerial !== '') {
    return <MirrorWindow initial={{ serial: mirrorSerial }} />
  }

  return (
    <div className="flex h-screen flex-col">
      {/*
        顶栏（自绘）。
        窗口是 frame:false，系统标题栏不存在了 —— 所以这一条同时承担两件事：
          1. 当标题栏用：左段可拖动窗口（app-region: drag），双击最大化由系统接管；
          2. 右侧自己提供最小化 / 最大化 / 关闭（WindowControls）。
        按钮必须显式 app-region: no-drag，否则点击会被拖拽区吞掉。
      */}
      <header
        className="flex h-10 shrink-0 items-stretch gap-3 border-b border-neutral-300 pl-4"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <h1 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-900">
          {/*
            * 应用图标与 exe/任务栏/托盘是**同一份 PNG**（scripts/make-icon.mjs 一并写出），
            * 不另画一套小图 —— 两处各存一份迟早会漂移成「顶栏还是旧兔子」。
            */}
          <img src={appIcon} alt="" aria-hidden="true" className="h-5 w-5 rounded-[5px]" />
          {t('app.name')}
        </h1>
        {/* 顶栏页签。no-drag：按钮必须能点，不能被拖拽区吞掉 */}
        {/*
          * 页签撑满顶栏高度（items-stretch + h-full），与右侧设置按钮同高。
          * 改前是 px-2 py-0.5 的小胶囊：一行字浮在 40px 高的条中间，
          * 与右端的按钮明显不在一条基线上。
          */}
        <nav
          className="flex items-stretch gap-0.5"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            type="button"
            onClick={() => { setPage('files') }}
            className={
              'flex items-center px-3 text-xs ' +
              (page === 'files' ? 'bg-neutral-200 text-neutral-900' : 'text-neutral-500 hover:bg-neutral-200/70')
            }
          >
            {t('nav.files')}
          </button>
          <button
            type="button"
            onClick={() => { setPage('overview') }}
            className={
              'flex items-center px-3 text-xs ' +
              (page === 'overview' ? 'bg-neutral-200 text-neutral-900' : 'text-neutral-500 hover:bg-neutral-200/70')
            }
          >
            {t('nav.overview')}
          </button>
          <button
            type="button"
            onClick={() => { setPage(pageAfterAppsClick(page)) }}
            className={
              'flex items-center px-3 text-xs ' +
              (page === 'apps' ? 'bg-neutral-200 text-neutral-900' : 'text-neutral-500 hover:bg-neutral-200/70')
            }
          >
            {t('nav.apps')}
          </button>
        </nav>
        {page === 'files' && active !== undefined && (
          <span className="flex items-center text-xs text-neutral-500">
            {deviceLabel(active)}
            {active.android !== undefined && ' · Android ' + active.android}
          </span>
        )}
        {/*
          * 设置入口：打开**独立子窗口**，不是切页。
          *
          * 为什么改成窗口：改完下载路径通常想立刻回文件页确认，
          * 而切页会卸载文件页；独立窗口让两件事能同时进行。
          * 所以这个按钮不高亮、也不改变当前页 —— 它是个动作，不是目的地。
          */}
        <span
          className="ml-auto flex items-stretch"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            type="button"
            onClick={() => {
              // 页面不变（settingsClickOpensWindow 保证），只开窗
              setPage(settingsClickOpensWindow(page).page)
              void window.api.window.openSettings()
            }}
            title={t('nav.settings')}
            aria-label={t('nav.settings')}
            className="flex items-center gap-1 px-3 text-xs text-neutral-500 hover:bg-neutral-200/70"
          >
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
            {t('nav.settings')}
          </button>
          <WindowControls />
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        {/* 点设备回文件页（该设备的目录与滚动位置由 fileStore 的 serial 分片恢复） */}
        <DeviceRail
          onSelectDevice={() => { setPage(pageAfterSelectDevice(page)) }}
        />
        {/* 文件页自己管理滚动（虚拟列表需要真正的滚动容器），所以这里不加 padding / overflow */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/*
           * 三页互斥渲染：切走时另外两页**会被卸载**。
           *
           * 这不影响正确性（滚动位置与选中项存在 fileStore 里，不在组件 state），
           * 但注释必须说实话。设置不在此列：它已经是独立窗口。
           */}
          {page === 'files'
            ? <FilesPage />
            : page === 'overview'
              ? <OverviewPage />
              : <AppsPage />}
        </main>
      </div>
      {/*
        日志栏放在传输底栏**上方**：传输行的内容每 300ms 在滚，
        日志是低频、需要回看的文本；混在同一个滚动区里会互相打架。
        两者都横跨整宽 —— 切页不会让它们消失（这正是它们存在的理由）。
      */}
      <LogBar />
      {/* 传输底栏横跨整宽：任何页面都能看到进度，不必切页（规格：底栏展示） */}
      <TransferDock />
    </div>
  )
}

export default App