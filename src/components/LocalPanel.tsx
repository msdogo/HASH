import { useEffect, useState } from 'react'
import { ArrowUp, Folder, FileText, Link2, RefreshCw, FolderOpen } from 'lucide-react'
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
}

export function LocalPanel(props: LocalPanelProps) {
  const data = useLocalStore((state) => state.data)
  const loading = useLocalStore((state) => state.loading)
  const error = useLocalStore((state) => state.error)
  const selected = useLocalStore((state) => state.selected)
  const load = useLocalStore((state) => state.load)
  const pickRoot = useLocalStore((state) => state.pickRoot)
  const select = useLocalStore((state) => state.select)
  const [width, setWidth] = useState(300)
  const [notice, setNotice] = useState<string | null>(null)

  // 首次挂载加载起始浏览目录（缺省 = 主进程给的用户主目录）
  useEffect(() => { void load() }, [load])

  if (props.collapsed) {
    return (
      <div className="flex w-9 shrink-0 flex-col items-center border-l border-neutral-800 py-2">
        <button
          type="button"
          onClick={props.onToggleCollapsed}
          title={t('local.title')}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
        >
          <FolderOpen className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    )
  }

  const path = selectedLocalPath(data, selected)

  return (
    <aside
      className="flex shrink-0 flex-col border-l border-neutral-800"
      style={{ width }}
      data-testid="local-panel"
    >
      <div className="flex items-center gap-1 border-b border-neutral-800 px-2 py-1.5">
        <span className="shrink-0 text-[11px] font-medium text-neutral-400">{t('local.title')}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-600" title={data?.cwd ?? ''}>
          {data?.cwd ?? ''}
        </span>
        <button
          type="button"
          disabled={data?.parent === null || data === null}
          onClick={() => { if (data !== null && data.parent !== null) void load(data.parent) }}
          title={t('local.up')}
          className="shrink-0 rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-30"
        >
          <ArrowUp className="h-3 w-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => { void load(data?.cwd) }}
          title={t('local.refresh')}
          className="shrink-0 rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100"
        >
          <RefreshCw className={'h-3 w-3 ' + (loading ? 'animate-spin' : '')} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => { void pickRoot() }}
          title={t('local.pickRoot')}
          className="shrink-0 rounded px-1 text-[11px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100"
        >
          {t('local.pickRoot')}
        </button>
        <button
          type="button"
          onClick={props.onToggleCollapsed}
          title={t('local.title')}
          className="shrink-0 rounded px-1 text-[11px] text-neutral-600 hover:bg-neutral-800 hover:text-neutral-300"
        >
          ›
        </button>
      </div>

      {/* 起始浏览目录：让用户知道本地栏当前打开的是哪里（R2-1 之后它不再是「范围」） */}
      <div className="truncate border-b border-neutral-800/60 px-2 py-1 text-[10px] text-neutral-600" title={data?.startDir ?? ''}>
        {data === null ? '' : tf('local.startDir', { dir: data.startDir })}
      </div>

      {error !== null && (
        <div className="border-b border-red-900/50 bg-red-950/30 px-2 py-1 text-[11px] leading-snug text-red-300">
          {errorText(error)}
        </div>
      )}

      {notice !== null && (
        <div className="border-b border-amber-900/50 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-300">
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
                (active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-300 hover:bg-neutral-800/50')
              }
              title={item.full}
            >
              {item.isDir
                ? <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
                : item.isLink
                  ? <Link2 className="h-3.5 w-3.5 shrink-0 text-neutral-500" aria-hidden="true" />
                  : <FileText className="h-3.5 w-3.5 shrink-0 text-neutral-500" aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-2 border-t border-neutral-800 px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[10px] text-neutral-600">
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
          className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
        >
          ↑ {t('transfer.upload')}
        </button>
      </div>
    </aside>
  )
}
