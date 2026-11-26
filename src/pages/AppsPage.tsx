import { useCallback, useEffect, useState } from 'react'
import { Download, PackageOpen, Play, RefreshCw, Square, Trash2, X } from 'lucide-react'
import type { AppAction, AppDetail, AppEntry, InstallProgress } from '@shared/apps'
import { formatBytes } from '@shared/transfer'
import {
  logApkInstalled,
  logApkPulled,
  logAppAction,
  logAppFailed,
} from '@/store/logStore'
import { versionLabel } from '@shared/apps'
import { errorText, t, tf } from '@shared/i18n'
import { useDeviceStore } from '@/store/deviceStore'

/**
 * 应用管理页（P1 第二批）。
 *
 * 只做三件事：把事件转成 window.api 调用、把结果转成 DOM、把危险动作先问一遍。
 * 所有判断（版本怎么显示、哪个动作要确认、失败码怎么翻）都在 @shared/apps 的
 * 纯函数里，那些有单测；这里不写任何业务判断。
 *
 * ===== 为什么列表不显示应用名 =====
 * 真机实测 dumpsys 里没有 labelRes / nonLocalizedLabel，拿不到中文应用名
 * （要拿得去解析 APK 的 resources.arsc，那是另一个量级的工程）。
 * 界面因此显示包名，并在页面里说明一句 —— 编一个假名字比显示包名更糟。
 */
export interface AppsPageProps {
  /**
   * 渲染期注入（与 DeviceRail / OverviewPage 的 initial 同一手法）。
   *
   * 本工程没有 jsdom，SSR 只跑一次 render、拿不到事件，而 store 在 SSR 下取的是
   * 初始快照。允许注入之后，「有应用 / 无应用 / 有错误」这些形态才能在渲染结果里被断言。
   * 生产不传 → 读 store，行为与改前逐字相同。
   */
  initial?: Partial<{
    serial: string | null
    apps: AppEntry[]
    detail: AppDetail | null
    notice: string | null
    error: string | null
    /** 安装进度（SSR 下无法触发真实推送，只能注入来断言进度条形态）。 */
    installing: InstallProgress | null
    loading: boolean
  }>
}

export function AppsPage(props: AppsPageProps = {}) {
  const activeSerial = useDeviceStore((state) => state.activeSerial)
  const serial = props.initial !== undefined && 'serial' in props.initial
    ? (props.initial.serial ?? null)
    : activeSerial

  const [apps, setApps] = useState<AppEntry[]>(props.initial?.apps ?? [])
  const [detail, setDetail] = useState<AppDetail | null>(props.initial?.detail ?? null)
  const [loading, setLoading] = useState(props.initial?.loading ?? false)
  const [notice, setNotice] = useState<string | null>(props.initial?.notice ?? null)
  const [error, setError] = useState<string | null>(props.initial?.error ?? null)
  /** 待确认的危险动作（清数据 / 卸载）。 */
  const [pending, setPending] = useState<{ action: AppAction; packageName: string } | null>(null)
  /**
   * 安装进度。
   *
   * null = 当前没有在装（按钮常态）；有值 = 正在装，按钮变成进度条。
   * 进度来自主进程推送（push 阶段是真实字节数，pm install 阶段是不确定态）。
   */
  const [installing, setInstalling] = useState<InstallProgress | null>(props.initial?.installing ?? null)

  const load = useCallback(async () => {
    if (serial === null) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.apps.list({ serial })
      if (!result.ok) { setError(errorText(result.error)); return }
      setApps(result.data)
    } finally {
      setLoading(false)
    }
  }, [serial])

  useEffect(() => { void load() }, [load])

  /*
   * 订阅安装进度。
   *
   * 为什么在页面级订阅而不是只包在按钮里：装包期间用户可能切页，
   * 切回来时进度必须还在（订阅随页面卸载断开，但 install 的 Promise 仍由主进程推进，
   * 下次进页面会拿到 null —— 这是可接受的：装完了列表会刷新，装失败了有错误提示）。
   */
  useEffect(() => {
    return window.api.apps.onInstallProgress((payload) => {
      setInstalling(payload.phase === 'done' ? null : payload)
    })
  }, [])

  /** 展开一个包的详情（逐包 dumpsys，只在用户点开时才查）。 */
  const openDetail = useCallback(async (packageName: string) => {
    if (serial === null) return
    if (detail !== null && detail.packageName === packageName) { setDetail(null); return }
    const result = await window.api.apps.detail({ serial, packageName })
    if (!result.ok) { setError(errorText(result.error)); logAppFailed(serial, result.error); return }
    setDetail(result.data)
  }, [serial, detail])

  /** 非危险动作：直接执行。 */
  const run = useCallback(async (action: AppAction, packageName: string) => {
    if (serial === null) return
    setError(null)
    // 每个动作的结果都同时进日志：顶部的 notice 是单槽的，会被下一条顶掉
    /*
     * 每个动作都要留两处痕迹：
     *   - 顶部 notice / error：告诉用户「刚刚这一下成了没有」（单槽，会被顶掉）；
     *   - 日志栏：带设备与包名，可回看 —— 连着操作好几个包时只有它能对上账。
     */
    if (action === 'pullApk') {
      const result = await window.api.apps.pullApk({ serial, packageName, dstDir: '' })
      if (!result.ok) { setError(errorText(result.error)); logAppFailed(serial, result.error); return }
      setNotice(tf('apps.pulled', { count: String(result.data.files.length) }))
      logApkPulled(serial, packageName, result.data.files.length)
      return
    }
    if (action === 'launch') {
      const result = await window.api.apps.launch({ serial, packageName })
      if (!result.ok) { setError(errorText(result.error)); logAppFailed(serial, result.error); return }
      setNotice(t('apps.launched'))
      logAppAction('launched', serial, packageName)
      return
    }
    if (action === 'forceStop') {
      const result = await window.api.apps.forceStop({ serial, packageName })
      if (!result.ok) { setError(errorText(result.error)); logAppFailed(serial, result.error); return }
      setNotice(t('apps.forceStopped'))
      logAppAction('forceStopped', serial, packageName)
    }
  }, [serial])

  /**
   * 安装本地 APK（P1 第二批的规格验收点：从手机拉 APK 再装回手机）。
   *
   * 入口放在页面顶部而不是每行：装 APK 与「哪一行」无关 —— 用户手上是一个
   * 刚拉下来的文件，不是某个已安装的包。选完文件立刻安装，中间不给第二个确认框：
   * 安装本身可逆（再卸载即可），而多一步只会让这条最常走的路径变慢。
   */
  const installApk = useCallback(async () => {
    if (serial === null) return
    setError(null)
    const picked = await window.api.apps.pickApk()
    if (!picked.ok) { setError(errorText(picked.error)); logAppFailed(serial, picked.error); return }
    // 取消选择返回空串（不是错误）：什么都不做，也不提示
    if (picked.data === '') return
    setInstalling({ serial, phase: 'preparing', apkName: '', doneBytes: 0, totalBytes: 0, percent: 0 })
    try {
      const result = await window.api.apps.install({ serial, apkPath: picked.data })
      if (!result.ok) {
        setError(errorText(result.error))
        // 失败必须同时进日志：顶部的错误条会被下一条提示顶掉，日志不会
        logAppFailed(serial, result.error)
        return
      }
      setNotice(t('apps.installed'))
      logApkInstalled(serial, picked.data)
      // 装完重新拉列表：新包（或升级后的版本号）应立刻可见
      await load()
    } finally {
      setInstalling(null)
    }
  }, [serial, load])

  /** 危险动作：确认后才执行。 */
  const confirm = useCallback(async () => {
    if (pending === null || serial === null) return
    const { action, packageName } = pending
    setPending(null)
    const result = action === 'clearData'
      ? await window.api.apps.clearData({ serial, packageName })
      : await window.api.apps.uninstall({ serial, packageName })
    if (!result.ok) { setError(errorText(result.error)); logAppFailed(serial, result.error); return }
    const text = action === 'clearData' ? t('apps.cleared') : t('apps.uninstalled')
    setNotice(text)
    // AppAction 是 'clearData' / 'uninstall'，日志 key 是过去式（'cleared' / 'uninstalled'）
    logAppAction(action === 'clearData' ? 'cleared' : 'uninstalled', serial, packageName)
    // 卸载成功后重新拉列表：那个包已经不在设备上了
    if (action === 'uninstall') await load()
  }, [pending, serial, load])

  if (serial === null) {
    return <p className="p-8 text-sm text-neutral-500">{t('apps.noDevice')}</p>
  }
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-neutral-300 px-3 py-1.5">
        <PackageOpen className="h-3.5 w-3.5 text-neutral-500" aria-hidden="true" />
        <h2 className="text-xs font-medium text-neutral-700">{t('apps.title')}</h2>
        <span className="text-[11px] text-neutral-400">{apps.length}</span>
        {/*
          安装 APK：规格验收点「从手机拉 APK 再装回手机」的落地入口。
          进度与阶段不在这里显示 —— 底部的日志栏横跨整宽、切页也不会丢，
          装包期间用户切到别的页面照样看得见进度（这里只留入口按钮）。
        */}
        <button
          type="button"
          onClick={() => { void installApk() }}
          disabled={installing !== null}
          title={t('apps.action.installApk')}
          className="ml-auto flex items-center gap-1 rounded border border-neutral-300 px-1.5 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-100 disabled:opacity-40"
        >
          <PackageOpen className="h-3 w-3" aria-hidden="true" />
          {t('apps.action.installApk')}
        </button>
        <button
          type="button"
          onClick={() => { void load() }}
          title={t('apps.reload')}
          aria-label={t('apps.reload')}
          className="rounded p-1 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </header>

      {notice !== null && (
        <div className="flex items-start gap-1 border-b border-neutral-200 bg-neutral-50 px-3 py-1 text-[11px] text-neutral-600">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => { setNotice(null) }} title={t('batch.result.dismiss')}>
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      )}

      {error !== null && (
        <div className="flex items-start gap-1 border-b border-red-200 bg-red-50 px-3 py-1 text-[11px] text-red-600">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => { setError(null) }} title={t('batch.result.dismiss')}>
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && apps.length === 0 && (
          <p className="p-6 text-xs text-neutral-500">{t('apps.loading')}</p>
        )}
        {!loading && apps.length === 0 && (
          <p className="p-6 text-xs text-neutral-500">{t('apps.empty')}</p>
        )}
        {apps.length > 0 && (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-neutral-50 text-neutral-500">
              <tr>
                <th className="px-3 py-1 text-left font-medium">{t('apps.column.package')}</th>
                <th className="px-3 py-1 text-left font-medium">{t('apps.column.version')}</th>
                <th className="px-3 py-1 text-right font-medium">{t('apps.column.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => {
                const expanded = detail !== null && detail.packageName === app.packageName
                return (
                  <tr key={app.packageName} className="border-t border-neutral-200 hover:bg-neutral-50">
                    <td className="px-3 py-1">
                      <button
                        type="button"
                        onClick={() => { void openDetail(app.packageName) }}
                        title={app.packageName}
                        className="text-left text-neutral-900 hover:underline"
                      >
                        {app.packageName}
                      </button>
                      {expanded && (
                        <div className="mt-0.5 text-[10px] text-neutral-500">
                          {t('apps.column.version')}: {versionLabel(detail ?? undefined)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1 text-neutral-600">
                      {expanded ? versionLabel(detail ?? undefined) : String(app.versionCode)}
                    </td>
                    <td className="px-3 py-1">
                      <div className="flex items-center justify-end gap-0.5">
                        <ActionButton
                          icon={<Download className="h-3 w-3" />}
                          label={t('apps.action.pullApk')}
                          onClick={() => { void run('pullApk', app.packageName) }}
                        />
                        <ActionButton
                          icon={<Play className="h-3 w-3" />}
                          label={t('apps.action.launch')}
                          onClick={() => { void run('launch', app.packageName) }}
                        />
                        <ActionButton
                          icon={<Square className="h-3 w-3" />}
                          label={t('apps.action.forceStop')}
                          onClick={() => { void run('forceStop', app.packageName) }}
                        />
                        <ActionButton
                          icon={<RefreshCw className="h-3 w-3" />}
                          label={t('apps.action.clearData')}
                          danger
                          onClick={() => { setPending({ action: 'clearData', packageName: app.packageName }) }}
                        />
                        <ActionButton
                          icon={<Trash2 className="h-3 w-3" />}
                          label={t('apps.action.uninstall')}
                          danger
                          onClick={() => { setPending({ action: 'uninstall', packageName: app.packageName }) }}
                        />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 危险动作的二次确认（清数据 / 卸载不可撤销） */}
      {pending !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-96 rounded border border-neutral-300 bg-white p-4 shadow-lg">
            <h3 className="text-sm font-medium text-neutral-900">
              {pending.action === 'clearData' ? t('apps.confirm.clearData.title') : t('apps.confirm.uninstall.title')}
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-neutral-600">
              {tf(
                pending.action === 'clearData' ? 'apps.confirm.clearData.body' : 'apps.confirm.uninstall.body',
                { packageName: pending.packageName },
              )}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setPending(null) }}
                className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100"
              >
                {t('apps.confirm.cancel')}
              </button>
              <button
                type="button"
                onClick={() => { void confirm() }}
                className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700"
              >
                {t('apps.confirm.ok')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

/** 一个图标按钮（纯展示：不读 store、不做判断）。 */
function ActionButton(props: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.label}
      aria-label={props.label}
      className={
        'rounded p-1 ' +
        (props.danger === true
          ? 'text-red-600 hover:bg-red-50'
          : 'text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900')
      }
    >
      {props.icon}
    </button>
  )
}
