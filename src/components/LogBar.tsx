import { useMemo } from 'react'
import { ChevronDown, ChevronRight, ScrollText, Trash2 } from 'lucide-react'
import { formatLogTime } from '@shared/log'
import { installPhaseKey } from '@shared/apps'
import { t } from '@shared/i18n'
import { formatBytes } from '@shared/transfer'
import { useLogStore } from '@/store/logStore'

/**
 * 日志栏（安装进度与结果的留存）。
 *
 * ===== 为什么要有它 =====  
 * 页面顶部的 notice 是**单槽**的：下一条提示会把上一条顶掉，切页也会丢。
 * 而安装一个包是几十秒的连续过程，用户经常切走再切回来 ——
 * 回来时既看不到过程，也拿不到「刚才到底装成了没」。
 * 这条栏只追加、带时间戳、可折叠，专门补这个洞。
 *
 * ===== 为什么进度条在这里，百分比却不在日志里 =====  
 * 底栏显示**当前**安装的实时进度（每 300ms 更新的真字节数），
 * 日志只记阶段变化与结果 —— 两者分工，避免一次安装糊出上百行把重点冲走。
 */
export interface LogBarProps {
  /** 渲染期注入（本工程没有 jsdom，SSR 只能靠注入断言形态）。 */
  initial?: {
    entries?: import('@shared/log').LogEntry[]
    collapsed?: boolean
    installing?: import('@shared/apps').InstallProgress | null
  }
}

export function LogBar(props: LogBarProps = {}) {
  const entriesFromStore = useLogStore((state) => state.entries)
  const collapsedFromStore = useLogStore((state) => state.collapsed)
  const installingFromStore = useLogStore((state) => state.installing)
  const clear = useLogStore((state) => state.clear)
  const setCollapsed = useLogStore((state) => state.setCollapsed)

  const entries = props.initial?.entries ?? entriesFromStore
  const collapsed = props.initial?.collapsed ?? collapsedFromStore
  const installing = 'installing' in (props.initial ?? {})
    ? (props.initial?.installing ?? null)
    : installingFromStore

  // 最新的一条：折叠态下它就是全部可见内容，所以必须是最新的
  const latest = useMemo(() => entries[entries.length - 1], [entries])

  return (
    <section className="border-t border-neutral-300 bg-neutral-50 text-[11px] text-neutral-600">
      <div className="flex items-center gap-2 px-3 py-1">
        <ScrollText className="h-3 w-3 shrink-0 text-neutral-500" aria-hidden="true" />
        <span className="shrink-0 font-medium text-neutral-700">{t('log.title')}</span>
        <span className="shrink-0 text-neutral-400">{entries.length}</span>

        {/* 安装中的实时进度：底栏是唯一「任何页面都看得见」的位置 */}
        {installing !== null && (
          <span className="flex min-w-0 items-center gap-1.5" title={t('apps.installing')}>
            <span className="h-1 w-20 shrink-0 overflow-hidden rounded bg-neutral-200">
              <span
                className="block h-full bg-sky-500 transition-[width] duration-200"
                style={{ width: String(installing.percent) + '%' }}
              />
            </span>
            <span className="shrink-0 tabular-nums text-neutral-500">
              {installing.phase === 'installing'
                ? t('apps.installingPhase')
                : formatBytes(installing.doneBytes) + ' / ' + formatBytes(installing.totalBytes)}
            </span>
            <span className="shrink-0 text-neutral-400">{t(installPhaseKey(installing.phase))}</span>
          </span>
        )}

        <button
          type="button"
          onClick={() => { setCollapsed(!collapsed) }}
          title={collapsed ? t('log.expand') : t('log.collapse')}
          aria-label={collapsed ? t('log.expand') : t('log.collapse')}
          className="ml-auto shrink-0 rounded p-0.5 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900"
        >
          {collapsed
            ? <ChevronRight className="h-3 w-3" aria-hidden="true" />
            : <ChevronDown className="h-3 w-3" aria-hidden="true" />}
        </button>
        <button
          type="button"
          disabled={entries.length === 0}
          onClick={() => { clear() }}
          title={t('log.clear')}
          aria-label={t('log.clear')}
          className="shrink-0 rounded p-0.5 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900 disabled:opacity-40"
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>

      {collapsed
        ? (
          latest !== undefined && (
            <p className="truncate px-3 pb-1 text-neutral-500">
              <span className="tabular-nums">{formatLogTime(latest.at)}</span>
              {' '}
              {latest.text}
            </p>
          )
        )
        : (
          <div className="max-h-32 overflow-auto px-3 pb-1">
            {entries.length === 0
              ? <p className="text-neutral-400">{t('log.empty')}</p>
              : (
                <ul className="space-y-0.5">
                  {entries.map((entry) => (
                    <li
                      key={entry.id}
                      className={'flex gap-2 ' + (entry.level === 'error' ? 'text-red-600' : '')}
                    >
                      <span className="shrink-0 tabular-nums text-neutral-400">{formatLogTime(entry.at)}</span>
                      <span className="min-w-0 flex-1 break-words">{entry.text}</span>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        )}
    </section>
  )
}