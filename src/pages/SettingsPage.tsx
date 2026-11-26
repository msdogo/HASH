import { useEffect } from 'react'
import { Download, FolderOpen, Info, RotateCcw } from 'lucide-react'
import type { AdbSource } from '@shared/types'
import { errorText, t, tf } from '@shared/i18n'
import { useSettingsStore } from '@/store/settingsStore'

/**
 * 设置页（R2-2）。
 *
 * 规格 §5 的目录结构与 §9.1 的顶栏 ⚙设置 入口从一开始就有，但 11 个任务的实现计划
 * 里从没给它拆任务，所以一直缺着。本轮按用户裁决只做两块，不多加：
 *   1. **默认下载路径**：显示当前值 + 更换 + 恢复默认（可写）；
 *   2. **adb 状态**：来源 / 路径 / 版本（只读，不给改）。
 *
 * 三条约束：
 * - 文案全部走 i18n（组件里禁止硬编码中文，ui-contract 测试守着）；
 * - adb 只读：它是自检出来的，不是配置项 —— 给一个假的可编辑入口只会让用户困惑；
 * - 下载路径的判定与降级全在主进程（electron/settings/store.ts），
 *   本页只负责展示与触发动作，不自己猜「哪个路径可用」。
 */

/** adb 来源 → 一句人话（缺省值用 unknown 兜住，新增来源不会渲染出空字符串）。 */
function sourceLabel(source: AdbSource): string {
  switch (source) {
    case 'custom': return t('settings.adb.source.custom')
    case 'env': return t('settings.adb.source.env')
    case 'bundled': return t('settings.adb.source.bundled')
    case 'path': return t('settings.adb.source.path')
    default: return t('settings.adb.source.unknown')
  }
}

/**
 * 设置页的数据来源。
 *
 * 与 DeviceRail / OpDialogHost 同一手法（tests/component-wiring.test.tsx 已证明可行）：
 * 生产不传 → 读 store；测试传值 → 用 renderToStaticMarkup 渲染真组件断言输出文本。
 * 为什么需要它：zustand v5 的 useSyncExternalStore 在 SSR 下取初始快照并冻结，
 * 「先填 store 再渲染」这条路在 renderToStaticMarkup 里走不通（本工程实测过）。
 */
export interface SettingsPageProps {
  /**
   * 本页**不再有「返回」按钮**。
   *
   * 历史：它曾经是一个可切换的页面，那时必须有出口（R3-1：进得去出不来）。
   * 现在它是独立子窗口，出口就是窗口右上角的 ×；再放一个「返回」等于同一个动作
   * 画两遍，用户还会以为「返回」和「关闭」有区别（用户实测反馈的第一条）。
   *
   * 所以 onBack 整个删掉，而不是留着不用 —— 留一个没接线的必填 prop，
   * 下一个人就会以为它还在起作用。
   */
  initial?: {
    data?: ReturnType<typeof useSettingsStore.getState>['data']
    loading?: boolean
    error?: string | null
  }
}

export function SettingsPage(props: SettingsPageProps) {
  const storeData = useSettingsStore((state) => state.data)
  const storeLoading = useSettingsStore((state) => state.loading)
  const storeError = useSettingsStore((state) => state.error)
  const load = useSettingsStore((state) => state.load)
  const pickDownloadDir = useSettingsStore((state) => state.pickDownloadDir)
  const resetDownloadDir = useSettingsStore((state) => state.resetDownloadDir)

  const data = props.initial?.data === undefined ? storeData : props.initial.data
  const loading = props.initial?.loading === undefined ? storeLoading : props.initial.loading
  const error = props.initial?.error === undefined ? storeError : props.initial.error

  // 进入设置页时读一次（幂等：store 内部已在加载中时不会重复发请求）
  useEffect(() => { void load() }, [load])

  const downloadDir = data?.downloadDir ?? ''
  const isDefault = data !== null && downloadDir === data.defaultDownloadDir
  const adb = data?.adb
  // R7：版本号只来自主进程（app.getVersion()），本页不猜、也不硬编码
  const appVersion = data?.appVersion ?? ''

  return (
    <section className="min-h-0 flex-1 overflow-auto p-4" data-testid="settings-page">
      <h2 className="mb-3 text-sm font-semibold text-neutral-900">{t('settings.title')}</h2>

      {error !== null && (
        <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] text-red-600">
          {errorText(error)}
        </div>
      )}

      {/* ---- 默认下载路径（可写） ---- */}
      <div className="mb-4 rounded border border-neutral-300" data-testid="settings-download-dir">
        <div className="flex items-center gap-2 border-b border-neutral-300 px-3 py-2">
          <Download className="h-3.5 w-3.5 shrink-0 text-neutral-600" aria-hidden="true" />
          <span className="text-xs font-medium text-neutral-900">{t('settings.downloadDir.title')}</span>
        </div>
        <div className="flex flex-col gap-2 px-3 py-2.5">
          <p className="text-[11px] leading-snug text-neutral-500">{t('settings.downloadDir.desc')}</p>
          <div className="flex items-center gap-2">
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-neutral-500" aria-hidden="true" />
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-700"
              title={downloadDir}
            >
              {downloadDir === ''
                ? (loading ? t('settings.downloadDir.loading') : t('settings.downloadDir.empty'))
                : tf('settings.downloadDir.current', { dir: downloadDir })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => { void pickDownloadDir() }}
              className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-200 disabled:opacity-40"
            >
              {t('settings.downloadDir.change')}
            </button>
            <button
              type="button"
              disabled={loading || isDefault}
              onClick={() => { void resetDownloadDir() }}
              title={t('settings.downloadDir.reset')}
              className="flex items-center gap-1 rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-200 disabled:opacity-40"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              {t('settings.downloadDir.reset')}
            </button>
            {/* 当前是不是默认值：用户点「恢复默认」之前应该知道自己已在默认上 */}
            {data !== null && (
              <span className="text-[10px] text-neutral-400">
                {isDefault ? t('settings.downloadDir.defaultHint') : t('settings.downloadDir.customHint')}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ---- adb 状态（只读） ---- */}
      <div className="rounded border border-neutral-300" data-testid="settings-adb">
        <div className="flex items-center gap-2 border-b border-neutral-300 px-3 py-2">
          <Info className="h-3.5 w-3.5 shrink-0 text-neutral-600" aria-hidden="true" />
          <span className="text-xs font-medium text-neutral-900">{t('settings.adb.title')}</span>
          <span className="ml-auto text-[10px] text-neutral-400">{t('settings.adb.readonly')}</span>
        </div>
        <div className="flex flex-col gap-1 px-3 py-2.5">
          {adb === undefined || adb.state === 'checking' ? (
            <span className="text-[11px] text-neutral-500">{t('settings.adb.checking')}</span>
          ) : adb.state === 'error' ? (
            <span className="text-[11px] text-red-600">{tf('settings.adb.error', { text: errorText(adb.code) })}</span>
          ) : (
            <>
              <Row label={t('settings.adb.source')} value={sourceLabel(adb.source)} />
              <Row label={t('settings.adb.path')} value={adb.path} mono />
              <Row label={t('settings.adb.version')} value={adb.version} mono />
            </>
          )}
        </div>
      </div>

      {/*
        * ---- 关于（只读）：应用自己的版本号（R7） ----
        * 样式与上面两块完全一致（同一个 Row 组件 + 同一张边框卡片），不新造一套。
        * 值只来自 SettingsData.appVersion（主进程 app.getVersion()）——
        * 这里既不写死 '0.1.0'，也不 import package.json（那会把版本号在构建期
        * 内联进 bundle，与写常量同样会「发版忘改 → 显示旧版本」）。
        * 空串理论上不会出现；出现了就显示占位符，避免那行看着像坏了。
        */}
      <div className="mt-4 rounded border border-neutral-300" data-testid="settings-about">
        <div className="flex items-center gap-2 border-b border-neutral-300 px-3 py-2">
          <Info className="h-3.5 w-3.5 shrink-0 text-neutral-600" aria-hidden="true" />
          <span className="text-xs font-medium text-neutral-900">{t('settings.about.title')}</span>
        </div>
        <div className="flex flex-col gap-1 px-3 py-2.5">
          <Row
            label={t('settings.about.version')}
            value={appVersion === '' ? t('settings.about.unknown') : appVersion}
            mono
          />
        </div>
      </div>
    </section>
  )
}

/** 一行「标签：值」。 */
function Row(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-12 shrink-0 text-[11px] text-neutral-500">{props.label}</span>
      <span className={'min-w-0 flex-1 truncate text-[11px] text-neutral-700' + (props.mono === true ? ' font-mono' : '')} title={props.value}>
        {props.value}
      </span>
    </div>
  )
}
