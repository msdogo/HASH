import { useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Folder, FileText, Link2, ArrowUp, ArrowDown } from 'lucide-react'
import type { FileEntry } from '@shared/types'
import { ROW_HEIGHT, formatMtime, formatSize, isMetaKnown, isOpenKey, selectModeOf, type EmptyReason, type SelectMode, type SortDir, type SortKey } from '@shared/file-view'
import { rowClassName } from '@shared/file-row'
import { isPrimaryPointerButton } from '@shared/context-menu'
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
  /**
   * 列表为空时的原因（R6 把「被搜索词筛掉」也收了进来）。
   *
   * 修前这里是一个 hiddenFiltered 布尔量，只能区分「空目录 / 只有隐藏项」。
   * 搜索生效后一个满目录也会变成空列表 —— 那时必须说「没有匹配的文件」，
   * 否则用户会以为文件丢了。四种原因由 @shared/file-view 的 emptyReason 判定（有表驱动用例）。
   */
  emptyReason: EmptyReason
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
  /**
   * 右键一行（R5 事项 2）。
   *
   * **preventDefault 留在这一层（组件）**，理由：
   * 右键在浏览器里的默认行为是「弹系统菜单」，那是 DOM 层的事；如果交给上层，
   * 上层任何一个提前 return（例如没有当前设备）都会让系统菜单冒出来盖住我们的菜单，
   * 而用户看到的将是「右键有时有菜单、有时没有」。放在这里就是无条件的。
   *
   * 选中语义（右键未选中行先设为唯一选中 / 右键已选中行保持多选）**不在组件里判**：
   * 那是用户裁决的落点，在 @shared/context-menu 的 contextSelectionFor（有表驱动用例）。
   */
  onContextMenuRow: (entry: FileEntry, event: React.MouseEvent<HTMLDivElement>) => void
  onRetry: () => void
  /** 当前排序键与方向（点表头切换，裁决 4：排序结果由 useMemo 算好传进来）。 */
  sort: SortKey
  sortDir: SortDir
  onSort: (sort: SortKey) => void
  /** 列表容器的键盘处理（I7：Enter 打开 / Backspace 上级 / F5 刷新）。 */
  onKeyNav: (event: React.KeyboardEvent<HTMLDivElement>) => void
  /**
   * 拖入（简报 C：资源管理器 → 设备）。
   *
   * 组件只把 DOM 事件转成两个回调，**判断全在 @shared/drag**：
   *   - onDragOver 必须 preventDefault（否则 drop 永远不触发）；
   *   - onDrop 交出去的是一整个 DataTransfer（里面是 File 对象，渲染层不能自己转路径）。
   * 为什么不在组件里调 getPathForFile：那需要 window.api，而组件的可测部分
   * 只到「这些回调有没有被接上」；路径解析与入队有专门的行为测试。
   */
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void
  /**
   * 拖出（简报 C：设备 → 资源管理器）。
   *
   * 行上 draggable + onDragStart 交给这个回调。**回调必须自己 preventDefault**
   * —— Electron 的 startDrag 只能由主进程发起，走 IPC 之后浏览器的默认拖拽
   * （它会尝试拖动一个 HTML 元素，最后什么也拖不出去）必须被取消。
   */
  onDragStartRow: (entry: FileEntry, event: React.DragEvent<HTMLDivElement>) => void
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
      <div className="flex items-center gap-3 border-b border-neutral-300 px-3 py-1.5 text-[11px] text-neutral-500">
        <SortHeader label={t('files.column.name')} sortKey="name" current={props.sort} dir={props.sortDir} onSort={props.onSort} className="flex-1 text-left" />
        <SortHeader label={t('files.column.size')} sortKey="size" current={props.sort} dir={props.sortDir} onSort={props.onSort} className="w-24 shrink-0 justify-end" />
        <SortHeader label={t('files.column.mtime')} sortKey="time" current={props.sort} dir={props.sortDir} onSort={props.onSort} className="w-36 shrink-0 justify-end" />
        <span className="w-28 shrink-0 text-right">{t('files.column.mode')}</span>
      </div>

      <div
        ref={parentRef}
        onScroll={(event) => { handleScroll(event.currentTarget.scrollTop) }}
        /* 拖入：整个列表区域都是投放目标（与资源管理器一致，不必精确对准某一行） */
        onDragOver={props.onDragOver}
        onDrop={props.onDrop}
        className="min-h-0 flex-1 overflow-auto"
        data-testid="file-table-scroll"
      >
        {
          props.entries.length === 0
            ? <EmptyState reason={props.emptyReason} error={props.error} onRetry={props.onRetry} />
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
                      /* 拖出：每一行都可以被拖走（目录行也一样 —— adb pull -r 语义由队列决定） */
                      draggable
                      onDragStart={(event) => { props.onDragStartRow(entry, event) }}
                      /*
                       * 只有主键（左键）改变选中项：右键也会先发 mousedown，
                       * 若这里不拦，右键一个多选里的行会先把选择塌缩成 1 项，
                       * 「右键已选中的行保持多选」就永远走不到（判定在 isPrimaryPointerButton）。
                       */
                      onMouseDown={(event) => {
                        if (!isPrimaryPointerButton(event.button)) return
                        props.onSelect(entry, selectModeOf(event))
                      }}
                      /*
                       * 右键：preventDefault 在这里无条件执行（见 props 上的说明），
                       * 然后把「哪一行 + 鼠标位置」整份交给上层 —— 弹不弹菜单是上层的决定。
                       */
                      onContextMenu={(event) => {
                        event.preventDefault()
                        props.onContextMenuRow(entry, event)
                      }}
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
                      /*
                       * 【R4 事项 3】行是 tabIndex={0} 的 div，浏览器会给它画默认焦点环 ——
                       * 用户鼠标点一下（多选时连点几次）就是一屏黄色描边。
                       * 拼装逻辑搬进 @shared/file-row 的 rowClassName（有真单测）：
                       * outline-none 让鼠标点击不再显示环，focus-visible 的细蓝内描边
                       * 保证 Tab 聚焦仍然看得见（键盘可达性不能跟着一起去掉）。
                       */
                      className={rowClassName(active)}
                    >
                      {entry.isDir
                        ? <Folder className="h-4 w-4 shrink-0 text-sky-600" aria-hidden="true" />
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
                      <span className="w-28 shrink-0 truncate text-right text-[11px] text-neutral-400">
                        {!isMetaKnown(entry) || entry.mode === '' ? t('files.unknownMeta') : entry.mode}
                      </span>
                      {entry.isDir && (
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); props.onOpen(entry) }}
                          onMouseDown={(event) => { event.stopPropagation() }}
                          title={t('files.open')}
                          className="ml-1 shrink-0 rounded p-0.5 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900"
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

/** 空列表时的解释：加载中 / 空目录 / 只有隐藏项 / 被搜索筛掉 / 整页错误（裁决 3 + R6）。 */
function EmptyState(props: {
  reason: EmptyReason
  error: string | null
  onRetry: () => void
}) {
  if (props.reason === 'error') {
    return (
      <div className="flex flex-col items-start gap-3 p-6 text-sm">
        <p className="text-red-600">{props.error === null ? '' : errorText(props.error)}</p>
        <button
          type="button"
          onClick={props.onRetry}
          className="rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-200"
        >
          {t('files.retry')}
        </button>
      </div>
    )
  }
  if (props.reason === 'loading') {
    return <p className="p-6 text-sm text-neutral-500">{t('files.loading')}</p>
  }
  /*
   * R6：被搜索词筛掉时明确说「没有匹配」。
   * 这一条不能省 —— 否则用户搜一个不存在的名字，看到的是「这个目录是空的」，
   * 而「空」是事实判断，会直接把他往「文件丢了」的方向带。
   */
  if (props.reason === 'query') {
    return <p className="p-6 text-sm text-neutral-500">{t('files.emptyQuery')}</p>
  }
  return (
    <p className="p-6 text-sm text-neutral-500">
      {props.reason === 'hidden' ? t('files.emptyHidden') : t('files.empty')}
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
      className={'flex items-center gap-0.5 hover:text-neutral-900 ' + props.className + (active ? ' text-neutral-700' : '')}
    >
      <span>{props.label}</span>
      {active && (props.dir === 'asc'
        ? <ArrowUp className="h-2.5 w-2.5" aria-hidden="true" />
        : <ArrowDown className="h-2.5 w-2.5" aria-hidden="true" />)}
    </button>
  )
}
