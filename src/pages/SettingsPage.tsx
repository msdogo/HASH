import { useEffect, useState } from 'react'
import { Download, FolderOpen, Info, MonitorSmartphone, RotateCcw } from 'lucide-react'
import type { AdbSource } from '@shared/types'
import { errorText, t, tf } from '@shared/i18n'
import { useSettingsStore } from '@/store/settingsStore'
import { SCRCPY_RESERVED_DISPLAY } from '@shared/mirror'

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
  const setScrcpyArgs = useSettingsStore((state) => state.setScrcpyArgs)

  const data = props.initial?.data === undefined ? storeData : props.initial.data
  const loading = props.initial?.loading === undefined ? storeLoading : props.initial.loading
  const error = props.initial?.error === undefined ? storeError : props.initial.error

  // 进入设置页时读一次（幂等：store 内部已在加载中时不会重复发请求）
  useEffect(() => { void load() }, [load])

  /*
   * 投屏参数的保存态：只影响按钮文案，不影响数据来源。
   *
   * 本页的数据仍然只有 store 一份（保存成功后 store 用主进程回的快照覆盖），
   * 这里的 saving 纯粹是「这一下点过了」的即时反馈，
   * 所以不需要在失败时回滚 —— 失败会走 error 横幅，值本来就没变。
   */
  const [saving, setSaving] = useState(false)
  const saveScrcpyArgs = async (raw: string): Promise<boolean> => {
    setSaving(true)
    try {
      return await setScrcpyArgs(raw)
    } finally {
      setSaving(false)
    }
  }

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

      {/* ---- 自定义投屏参数（可写，全局一套） ---- */}
      <ScrcpyArgsCard disabled={loading} value={data?.scrcpyArgs ?? ''} saving={saving} onSave={saveScrcpyArgs} />

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

/**
 * 自定义投屏参数卡片（全局一套，一个输入框）。
 *
 * ===== 为什么输入框是受控的、且初值来自 data 而不是自己记 =====
 * 用户在别处（另一个设置窗口）改了参数后回到这里，必须看到**当前生效值**，
 * 而不是他上次敲了一半没保存的草稿。所以 value 由 props 给，
 * 只有「用户正在输入」这一种情况才会用本地 draft 覆盖它。
 *
 * ===== 为什么「恢复默认」就是保存空串 =====
 * 空串在这个字段里是合法语义（= 只用内置参数），与 downloadDir 那边
 * 「空串不是用默认」正好相反。单独造一个 reset 通道只会多一条没有新语义的路。
 */
function ScrcpyArgsCard(props: {
  disabled: boolean
  value: string
  saving: boolean
  /**
   * 保存；返回是否成功。
   *
   * 返回值不是装饰：失败时必须**保留草稿**，否则用户敲的一行参数被清掉，
   * 而错误横幅只说「保存失败」—— 他得重新敲一遍。
   */
  onSave: (raw: string) => Promise<boolean>
}) {
  // null = 没有草稿，显示 props.value（用户没在编辑）
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? props.value
  const dirty = draft !== null && draft !== props.value

  return (
    <div className="mb-4 rounded border border-neutral-300" data-testid="settings-scrcpy-args">
      <div className="flex items-center gap-2 border-b border-neutral-300 px-3 py-2">
        <MonitorSmartphone className="h-3.5 w-3.5 shrink-0 text-neutral-600" aria-hidden="true" />
        <span className="text-xs font-medium text-neutral-900">{t('settings.scrcpyArgs.title')}</span>
        <span className="ml-auto text-[10px] text-neutral-400">
          {props.value === '' ? t('settings.scrcpyArgs.empty') : ''}
        </span>
      </div>
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <p className="text-[11px] leading-snug text-neutral-500">{t('settings.scrcpyArgs.desc')}</p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={shown}
            disabled={props.disabled}
            placeholder={t('settings.scrcpyArgs.placeholder')}
            onChange={(event) => { setDraft(event.target.value) }}
            className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 font-mono text-[11px] text-neutral-800 placeholder:text-neutral-400 disabled:opacity-40"
            data-testid="settings-scrcpy-args-input"
          />
          <button
            type="button"
            disabled={props.disabled || props.saving || !dirty}
            onClick={() => {
              void props.onSave(shown).then((ok) => { if (ok) setDraft(null) })
            }}
            className="shrink-0 rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-200 disabled:opacity-40"
          >
            {t('settings.scrcpyArgs.save')}
          </button>
          <button
            type="button"
            disabled={props.disabled || props.saving || props.value === ''}
            onClick={() => { void props.onSave('').then((ok) => { if (ok) setDraft(null) }) }}
            className="shrink-0 rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-200 disabled:opacity-40"
          >
            {t('settings.scrcpyArgs.reset')}
          </button>
        </div>
        {/*
          * 被忽略的参数清单：写死在这里而不是从主进程取。
          * 它是「产品规则」（嵌入前提），不是运行时事实；
          * 真正的判定在 src/shared/mirror.ts 的 parseScrcpyExtraArgs，
          * 两边共用一个来源 SOURCE 会更好，但那是 shared 常量，这里直接渲染即可。
          */}
        <p className="text-[10px] leading-snug text-neutral-400">
          {t('settings.scrcpyArgs.reserved')}
          {SCRCPY_RESERVED_DISPLAY.join('、')}
        </p>
      </div>
    </div>
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
