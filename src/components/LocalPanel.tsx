import { useEffect, useState } from 'react'
import { ArrowUp, Folder, FileText, Link2, RefreshCw, FolderOpen } from 'lucide-react'
import type { LocalListData } from '@shared/file-ops'
import { errorText, t, tf } from '@shared/i18n'
import { selectedLocalPath, useLocalStore } from '@/store/localStore'

/**
 * 本地双栏（任务 9 裁决 5；R2-1 移除本地根沙箱）。
 *
 * 三条硬约束：
 * 1. **所有本地访问都经 window.api.local**：渲染层没有 node 能力，
 *    路径校验（语法 + 真实路径解析）在主进程做，组件不做任何路径拼接或猜测；
 * 2. **显示起始浏览目录**：用户要知道本地栏当前打开的是哪个目录。这不是「范围」——
 *    本地根沙箱已由用户裁决移除，本地栏可以进任何目录；
 * 3. 符号链接按「非目录」显示：点进去会换到链接指向的位置，界面按链接本身显示更诚实。
 *
 * 宽度可折叠可调：本地栏在窄屏上会挤掉文件列表，所以给一个折叠开关。
 */

export interface LocalPanelProps {
  /** 上传：把选中的本地文件送到设备的当前目录。 */
  onUpload: (localPath: string, name: string) => void
  /** 折叠状态放外层（文件页要据此调整布局宽度）。 */
  collapsed: boolean
  onToggleCollapsed: () => void
  /**
   * 渲染期注入（与 DeviceRail 的 initial / SettingsPage 的 initial 同一手法）。
   *
   * 为什么需要（R2 复审 Minor 2 / 第 15 次假护栏的残留）：此前「起始目录真的显示出来了」
   * 只有一条 `expect(read('LocalPanel.tsx')).toContain("tf('local.startDir'")` 的源码文本断言 ——
   * 复审实测把那一行换成 JSX 注释（注释里保留原文）后 ui-contract 仍 44 passed 全绿，
   * 也就是这个显示**完全没有门禁**。允许注入后就能真渲染一次，断言 HTML 里出现那句话。
   *
   * 生产不传 → 与改前逐字相同（读 store）。
   */
  initial?: Partial<LocalView>
}

/** 本地面板渲染所需的一屏状态（来自 store 或注入）。 */
export interface LocalView {
  data: LocalListData | null
  loading: boolean
  error: string | null
  selected: string[]
}

/**
 * 决定「这一屏渲染什么数据」：注入优先，缺哪个字段就用 store 的对应字段。
 *
 * 为什么用逐字段 `=== undefined` 而不是 `??`：这里 `null` 是**有意义的值**
 * （「还没读到本地目录」），`??` 会把注入的 null 当成「没注入」而回落到 store，
 * 于是「空状态」这条分支根本测不出来。DeviceRail 用 ?? 是因为它的 adb 字段
 * 在测试里不需要注入 null；这里需要，所以要显式判 undefined。
 *
 * 抽成纯函数（而不是在组件里内联）的理由与 pickRailData 相同：
 * 组件是否真的调用了它，只能靠渲染用例间接观察（见 tests/local-panel.test.tsx
 * 的「不传 initial → 原样读 store」一组）。
 */
export function pickLocalData(initial: LocalPanelProps['initial'], store: LocalView): LocalView {
  return {
    data: initial?.data === undefined ? store.data : initial.data,
    loading: initial?.loading === undefined ? store.loading : initial.loading,
    error: initial?.error === undefined ? store.error : initial.error,
    selected: initial?.selected === undefined ? store.selected : initial.selected,
  }
}

export function LocalPanel(props: LocalPanelProps) {
  const storeData = useLocalStore((state) => state.data)
  const storeLoading = useLocalStore((state) => state.loading)
  const storeError = useLocalStore((state) => state.error)
  const storeSelected = useLocalStore((state) => state.selected)
  // 注入优先、缺字段回落到 store（生产不传 initial → 与改前逐字相同）
  const { data, loading, error, selected } = pickLocalData(props.initial, {
    data: storeData,
    loading: storeLoading,
    error: storeError,
    selected: storeSelected,
  })
  const load = useLocalStore((state) => state.load)
  const pickRoot = useLocalStore((state) => state.pickRoot)
  const select = useLocalStore((state) => state.select)
  const [width, setWidth] = useState(300)
  const [notice, setNotice] = useState<string | null>(null)

  // 首次挂载加载起始浏览目录（缺省 = 主进程给的用户主目录）
  useEffect(() => { void load() }, [load])

  if (props.collapsed) {
    return (
      <div className="flex w-9 shrink-0 flex-col items-center border-l border-neutral-300 py-2">
        <button
          type="button"
          onClick={props.onToggleCollapsed}
          title={t('local.title')}
          className="rounded p-1 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900"
        >
          <FolderOpen className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    )
  }

  const path = selectedLocalPath(data, selected)

  return (
    <aside
      className="flex shrink-0 flex-col border-l border-neutral-300"
      style={{ width }}
      data-testid="local-panel"
    >
      <div className="flex items-center gap-1 border-b border-neutral-300 px-2 py-1.5">
        <span className="shrink-0 text-[11px] font-medium text-neutral-600">{t('local.title')}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-400" title={data?.cwd ?? ''}>
          {data?.cwd ?? ''}
        </span>
        <button
          type="button"
          disabled={data?.parent === null || data === null}
          onClick={() => { if (data !== null && data.parent !== null) void load(data.parent) }}
          title={t('local.up')}
          className="shrink-0 rounded p-0.5 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900 disabled:opacity-30"
        >
          <ArrowUp className="h-3 w-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => { void load(data?.cwd) }}
          title={t('local.refresh')}
          className="shrink-0 rounded p-0.5 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900"
        >
          <RefreshCw className={'h-3 w-3 ' + (loading ? 'animate-spin' : '')} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => { void pickRoot() }}
          title={t('local.pickRoot')}
          className="shrink-0 rounded px-1 text-[11px] text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900"
        >
          {t('local.pickRoot')}
        </button>
        <button
          type="button"
          onClick={props.onToggleCollapsed}
          title={t('local.title')}
          className="shrink-0 rounded px-1 text-[11px] text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
        >
          ›
        </button>
      </div>

      {/* 起始浏览目录：让用户知道本地栏当前打开的是哪里（R2-1 之后它不再是「范围」） */}
      <div className="truncate border-b border-neutral-300/70 px-2 py-1 text-[10px] text-neutral-400" title={data?.startDir ?? ''}>
        {data === null ? '' : tf('local.startDir', { dir: data.startDir })}
      </div>

      {error !== null && (
        <div className="border-b border-red-200 bg-red-50 px-2 py-1 text-[11px] leading-snug text-red-600">
          {errorText(error)}
        </div>
      )}

      {notice !== null && (
        <div className="border-b border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
          {notice}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto" data-testid="local-list">
        {data === null && loading && <p className="p-3 text-[11px] text-neutral-500">{t('local.loading')}</p>}
        {data !== null && data.items.length === 0 && !loading && (
          <p className="p-3 text-[11px] text-neutral-500">{t('local.empty')}</p>
        )}
        {data?.items.map((item) => {
          const active = selected.includes(item.name)
          const canPick = !item.isDir && !item.isLink
          return (
            <div
              key={item.name}
              role="row"
              aria-selected={active}
              onClick={() => {
                if (item.isDir) { void load(item.full); return }
                if (canPick) select(item.name)
              }}
              onDoubleClick={() => {
                if (!canPick) return
                props.onUpload(item.full, item.name)
              }}
              className={
                'flex items-center gap-1.5 px-2 py-1 text-xs ' +
                (item.isDir || canPick ? 'cursor-default ' : 'opacity-60 ') +
                (active ? 'bg-neutral-200 text-neutral-900' : 'text-neutral-700 hover:bg-neutral-200/50')
              }
              title={item.full}
            >
              {item.isDir
                ? <Folder className="h-3.5 w-3.5 shrink-0 text-sky-600" aria-hidden="true" />
                : item.isLink
                  ? <Link2 className="h-3.5 w-3.5 shrink-0 text-neutral-500" aria-hidden="true" />
                  : <FileText className="h-3.5 w-3.5 shrink-0 text-neutral-500" aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-2 border-t border-neutral-300 px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[10px] text-neutral-400">
          {path === null ? t('local.selectHint') : (path.split(/[\\/]/).pop() ?? '')}
        </span>
        <button
          type="button"
          disabled={path === null}
          onClick={() => {
            if (path === null) { setNotice(t('local.selectHint')); return }
            setNotice(null)
            const name = path.split(/[\\/]/).pop() ?? ''
            props.onUpload(path, name)
          }}
          className="shrink-0 rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] text-neutral-700 hover:bg-neutral-200 disabled:opacity-40"
        >
          ↑ {t('transfer.upload')}
        </button>
      </div>
    </aside>
  )
}
