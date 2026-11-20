import { useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Folder, FileText, Link2, ArrowUp, ArrowDown } from 'lucide-react'
import type { FileEntry } from '@shared/types'
import { ROW_HEIGHT, formatMtime, formatSize, isMetaKnown, isOpenKey, selectModeOf, type SelectMode, type SortDir, type SortKey } from '@shared/file-view'
import { errorText, t, tf } from '@shared/i18n'

/**
 * 文件列表（虚拟滚动，裁决 4）。
 *
 * 三条硬约束：
 * 1. **排序与过滤不在这里做**：`entries` 是已经过滤排序好的数组（FilesPage 用 useMemo 算），
 *    本组件只负责把「第 index 行」画出来。万级目录下每次滚动重算排序会直接掉帧。
 * 2. **行高固定**：estimateSize 与 CSS height 共用 ROW_HEIGHT，两处各写一个数字是
 *    「滚动条越滚越抖」的经典成因。
 * 3. **不订阅 scrollTop**：滚动位置通过回调写进 store，但组件用 ref 读取，
 *    这样滚动时只重渲染虚拟列表，不会把整个文件页拖进来重渲染。
 */

export interface FileTableProps {
  /** 已过滤排序好的条目（visibleEntries 的结果）。 */
  entries: FileEntry[]
  /** 选中的名字（store 里按 serial 存）。 */
  selected: readonly string[]
  /** 时区偏移（分钟），用于时间列。 */
  tzOffsetMinutes: number
  /** 当前状态：空闲/加载中/就绪/错误。 */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 整页错误码（零条目 + 失败）。 */
  error: string | null
  /** 是否有隐藏项被过滤掉（用于空目录提示更准确）。 */
  hiddenFiltered: boolean
  /** 恢复滚动位置用的 key（serial + cwd + ready）；变化时才回填一次。 */
  restoreKey: string
  /** 在恢复 key 变化处读取要回填的 scrollTop。 */
  getRestoreScrollTop: () => number
  /** 滚动时上报位置（已按帧节流）。 */
  onScrollTop: (value: number) => void
  onOpen: (entry: FileEntry) => void
  /**
   * 点击一行。mode 由修饰键决定（Shift=区间 / Ctrl=Cmd 切换 / 无=替换），
   * 判定本身在 @shared/file-view 的 selectModeOf 里（可单测），组件只做转发。
   */
  onSelect: (entry: FileEntry, mode: SelectMode) => void
  onRetry: () => void
  /** 当前排序键与方向（点表头切换，裁决 4：排序结果由 useMemo 算好传进来）。 */
  sort: SortKey
  sortDir: SortDir
  onSort: (sort: SortKey) => void
  /** 列表容器的键盘处理（I7：Enter 打开 / Backspace 上级 / F5 刷新）。 */
  onKeyNav: (event: React.KeyboardEvent<HTMLDivElement>) => void
}

export function FileTable(props: FileTableProps) {
  const parentRef = useRef<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    count: props.entries.length,
    getScrollElement: () => parentRef.current,
    // 固定行高：与行内联样式共用同一个常量（裁决 4）
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  // 回填滚动位置（裁决 7：切设备回来要恢复）。
  // 只在 restoreKey 变化时执行；滚动中不依赖 scrollTop，避免「回填 → 上报 → 回填」抖成一团。
  const latestScrollTop = useRef(props.getRestoreScrollTop())
  latestScrollTop.current = props.getRestoreScrollTop()
  useEffect(() => {
    const element = parentRef.current
    if (element === null) return
    element.scrollTop = latestScrollTop.current
  }, [props.restoreKey])

  /*
   * 滚动上报按帧节流：一次滚动会触发几十个 scroll 事件，逐个写 store 等于每帧都全页重渲染。
   *
   * 【审查轮 1 / I3】回调必须从 ref 现取，不能直接闭包捕获 props.onScrollTop：
   * rAF 回调是异步的，若用户在「调度了帧、帧还没跑」的瞬间切了设备，
   * 旧闭包会把 A 的滚动值写进 B（或反之）。用 latestOnScrollTop 持有最新回调，
   * 并在 restoreKey 变化（切设备/换目录）时取消挂起的帧 —— 那一个像素级的中间值本来就不该落地。
   */
  const frameRef = useRef(0)
  const pendingRef = useRef(0)
  const latestOnScrollTop = useRef(props.onScrollTop)
  latestOnScrollTop.current = props.onScrollTop
  const cancelFrame = (): void => {
    if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current)
    frameRef.current = 0
  }
  const handleScroll = (value: number): void => {
    pendingRef.current = value
    if (frameRef.current !== 0) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      latestOnScrollTop.current(pendingRef.current)
    })
  }
  // 切设备/换目录：丢弃挂起的帧，避免把上一台设备的滚动位置写进新设备
  useEffect(() => { cancelFrame() }, [props.restoreKey])
  useEffect(() => cancelFrame, [])

  const items = virtualizer.getVirtualItems()

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={props.onKeyNav}>
      {/*
        列头可点排序：只派发 setSort，真正的排序由 FilesPage 的 useMemo 完成（裁决 4）。
        组件里不持有排序结果，也不在渲染里排序。
      */}
      <div className="flex items-center gap-3 border-b border-neutral-800 px-3 py-1.5 text-[11px] text-neutral-500">
        <SortHeader label={t('files.column.name')} sortKey="name" current={props.sort} dir={props.sortDir} onSort={props.onSort} className="flex-1 text-left" />
        <SortHeader label={t('files.column.size')} sortKey="size" current={props.sort} dir={props.sortDir} onSort={props.onSort} className="w-24 shrink-0 justify-end" />
        <SortHeader label={t('files.column.mtime')} sortKey="time" current={props.sort} dir={props.sortDir} onSort={props.onSort} className="w-36 shrink-0 justify-end" />
        <span className="w-28 shrink-0 text-right">{t('files.column.mode')}</span>
      </div>

      <div
        ref={parentRef}
        onScroll={(event) => { handleScroll(event.currentTarget.scrollTop) }}
        className="min-h-0 flex-1 overflow-auto"
        data-testid="file-table-scroll"
      >
        {
          props.entries.length === 0
            ? <EmptyState status={props.status} error={props.error} hiddenFiltered={props.hiddenFiltered} onRetry={props.onRetry} />
            : (
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {items.map((item) => {
                  const entry = props.entries[item.index]
                  if (entry === undefined) return null
                  const active = props.selected.includes(entry.name)
                  return (
                    <div
                      key={item.key}
                      data-index={item.index}
                      /* 【I7】行可聚焦：Enter 打开（规格 9.5） */
                      tabIndex={0}
                      role="row"
                      aria-selected={active}
                      onMouseDown={(event) => { props.onSelect(entry, selectModeOf(event)) }}
                      onDoubleClick={() => { props.onOpen(entry) }}
                      onKeyDown={(event) => {
                        if (isOpenKey(event.key)) {
                          event.preventDefault()
                          props.onOpen(entry)
                        }
                      }}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        height: ROW_HEIGHT,
                        transform: 'translateY(' + item.start + 'px)',
                      }}
                      className={
                        'flex cursor-default select-none items-center gap-2 px-3 text-sm ' +
                        (active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-300 hover:bg-neutral-800/50')
                      }
                    >
                      {entry.isDir
                        ? <Folder className="h-4 w-4 shrink-0 text-sky-400" aria-hidden="true" />
                        : <FileText className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" />}
                      <span className="min-w-0 flex-1 truncate" title={entry.name}>
                        {entry.name}
                      </span>
                      {entry.isLink && (
                        <span
                          className="flex shrink-0 items-center gap-1 text-[11px] text-neutral-500"
                          title={tf('files.linkTo', { target: entry.linkTarget ?? '' })}
                        >
                          <Link2 className="h-3 w-3" aria-hidden="true" />
                        </span>
                      )}
                      <span className="w-24 shrink-0 text-right text-[11px] tabular-nums text-neutral-500">
                        {entry.isDir ? t('files.dirSize') : formatSize(entry) ?? t('files.unknownMeta')}
                      </span>
                      <span className="w-36 shrink-0 text-right text-[11px] tabular-nums text-neutral-500">
                        {formatMtime(entry, props.tzOffsetMinutes) ?? t('files.unknownMeta')}
                      </span>
                      <span className="w-28 shrink-0 truncate text-right text-[11px] text-neutral-600">
                        {!isMetaKnown(entry) || entry.mode === '' ? t('files.unknownMeta') : entry.mode}
                      </span>
                      {entry.isDir && (
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); props.onOpen(entry) }}
                          onMouseDown={(event) => { event.stopPropagation() }}
                          title={t('files.open')}
                          className="ml-1 shrink-0 rounded p-0.5 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-200"
                        >
                          <ArrowUp className="h-3 w-3 rotate-90" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )
        }
      </div>
    </div>
  )
}

/** 空列表时的三种解释：加载中 / 空目录 / 整页错误（裁决 3）。 */
function EmptyState(props: {
  status: FileTableProps['status']
  error: string | null
  hiddenFiltered: boolean
  onRetry: () => void
}) {
  if (props.status === 'error') {
    return (
      <div className="flex flex-col items-start gap-3 p-6 text-sm">
        <p className="text-red-300">{props.error === null ? '' : errorText(props.error)}</p>
        <button
          type="button"
          onClick={props.onRetry}
          className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          {t('files.retry')}
        </button>
      </div>
    )
  }
  if (props.status === 'loading' || props.status === 'idle') {
    return <p className="p-6 text-sm text-neutral-500">{t('files.loading')}</p>
  }
  return (
    <p className="p-6 text-sm text-neutral-500">
      {props.hiddenFiltered ? t('files.emptyHidden') : t('files.empty')}
    </p>
  )
}

/** 供调试面板引用：固定行高（与纯逻辑共用同一常量，杜绝两处各写一个数字）。 */
export const FILE_ROW_HEIGHT = ROW_HEIGHT
/** 可排序的表头单元格：同一列再点一次切换升降序。 */
function SortHeader(props: {
  label: string
  sortKey: SortKey
  current: SortKey
  dir: SortDir
  onSort: (sort: SortKey) => void
  className: string
}) {
  const active = props.current === props.sortKey
  return (
    <button
      type="button"
      onClick={() => { props.onSort(props.sortKey) }}
      title={t('files.sortHint')}
      className={'flex items-center gap-0.5 hover:text-neutral-200 ' + props.className + (active ? ' text-neutral-300' : '')}
    >
      <span>{props.label}</span>
      {active && (props.dir === 'asc'
        ? <ArrowUp className="h-2.5 w-2.5" aria-hidden="true" />
        : <ArrowDown className="h-2.5 w-2.5" aria-hidden="true" />)}
    </button>
  )
}