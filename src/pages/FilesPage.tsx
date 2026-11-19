import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Eye, EyeOff, RefreshCw, X, AlertTriangle as Warn } from 'lucide-react'
import type { FileEntry } from '@shared/types'
import {
  isHiddenName,
  mapListError,
  navKeyCommand,
  openTarget,
  summarizeEntries,
  viewFromPartial,
  visibleEntries,
} from '@shared/file-view'
import { errorText, t, tf } from '@shared/i18n'
import { Breadcrumb } from '@/components/Breadcrumb'
import { FileTable } from '@/components/FileTable'
import { useDeviceStore } from '@/store/deviceStore'
import { useFileStore } from '@/store/fileStore'

/**
 * 文件页（任务 7）。
 *
 * 数据流：deviceStore 给 serial → fileStore 按 serial 取分片 → 主进程 fs:list → 模型落地。
 * 组件只做三件事：把事件转成 action、把状态转成 DOM、把排序/过滤包进 useMemo（裁决 4）。
 *
 * 每台设备的状态（cwd / 条目 / 排序 / 隐藏开关 / 选中 / 滚动位置）都存在各自的 store 分片里，
 * 所以 A 机停在 /sdcard/DCIM、B 机停在 /sdcard/Download，切回来各自恢复（裁决 7）。
 */
export function FilesPage() {
  const serial = useDeviceStore((state) => state.activeSerial)
  const devices = useDeviceStore((state) => state.devices)
  /*
   * 只订阅「影响渲染」的字段，**不订阅 scrollTop / generation**（裁决 4 + 审查轮 1 的收窄要求）。
   *
   * 为什么必须这样：滚动时每帧都会 dispatch 一次 setScrollTop。若直接订阅整个 view 分片，
   * 每帧都会让整个文件页重渲染（万级目录下就是滚动掉帧的主因）。用 useShallow 做浅比较后，
   * scrollTop 变化不会引起重渲染；需要读它时（回填滚动位置）直接 getState() 现取。
   */
  const view = useFileStore(
    useShallow((state) =>
      serial === null
        ? null
        : {
            cwd: state.views[serial]?.cwd,
            sort: state.views[serial]?.sort,
            sortDir: state.views[serial]?.sortDir,
            showHidden: state.views[serial]?.showHidden,
            entries: state.views[serial]?.entries,
            status: state.views[serial]?.status,
            error: state.views[serial]?.error,
            addressError: state.views[serial]?.addressError,
            notice: state.views[serial]?.notice,
            noticeDismissed: state.views[serial]?.noticeDismissed,
            tzOffsetMinutes: state.views[serial]?.tzOffsetMinutes,
            selected: state.views[serial]?.selected,
            loadedOnce: state.views[serial]?.loadedOnce,
          },
    ),
  )
  const ensure = useFileStore((state) => state.ensure)
  const dispatch = useFileStore((state) => state.dispatch)
  const openDir = useFileStore((state) => state.openDir)
  const refresh = useFileStore((state) => state.refresh)
  const load = useFileStore((state) => state.load)
  const syncDevices = useFileStore((state) => state.syncDevices)

  // 【I5/I6】把设备表的变化接到分片生命周期上：
  // 新设备建分片；消失的设备 forget（否则每台设备存一整份 entries，内存单调增长）。
  const deviceSerials = useMemo(() => devices.map((device) => device.serial), [devices])
  useEffect(() => { syncDevices(deviceSerials) }, [deviceSerials, syncDevices])

  // 首次进入（设备切换）时建分片并加载；
  // 同一目录的重复加载由协调器按 serial+dir 去重，StrictMode 双执行也不会发两次 adb 命令
  useEffect(() => {
    if (serial === null) return
    ensure(serial)
    void load(serial)
  }, [serial, ensure, load])

  // 订阅到的是「字段不全」的对象（刻意不订阅 scrollTop），必须补齐。
  // 返回类型是 FileViewSlice：写 current.generation 会直接编译报错（审查轮 1 的提示项）
  const current = viewFromPartial(view ?? undefined)

  // 裁决 4：过滤 + 排序只在这里算一次，且依赖明确。
  // 绝不能放进渲染路径里每次重算 —— 万级条目下滚动会直接掉帧。
  const entries = useMemo(
    () =>
      visibleEntries(current.entries, {
        showHidden: current.showHidden,
        sort: current.sort,
        sortDir: current.sortDir,
      }),
    [current.entries, current.showHidden, current.sort, current.sortDir],
  )

  // 空目录提示要区分「真的空」与「只有隐藏项」（隐藏项默认不显示，裁决 5）
  const hiddenFiltered = useMemo(
    () => !current.showHidden && current.entries.some((entry) => isHiddenName(entry.name)),
    [current.entries, current.showHidden],
  )

  const summary = useMemo(() => summarizeEntries(entries), [entries])

  /*
   * 链接轨迹与跳数（防环，N2）：从 store 现取，不订阅（只在导航时变，不必触发重渲染）。
   *
   * 为什么不放进订阅：它们是导航的中间状态，订阅会让每次跟随链接都多一次整页重渲染；
   * 而点击处理是事件回调，读 store 的最新值即可。
   */
  const linkStateRef = useRef<{ trail: string[]; hops: number }>({ trail: [], hops: 0 })
  useEffect(() => {
    const view = serial === null ? undefined : useFileStore.getState().views[serial]
    linkStateRef.current = { trail: view?.linkTrail ?? [], hops: view?.linkHops ?? 0 }
  }, [serial, current.cwd])

  const reportLinkError = useCallback(
    (code: string) => {
      if (serial === null) return
      // 【I4】链接进不去时给明确提示（走 i18n 错误文案），而不是静默无反应
      dispatch(serial, { type: 'addressError', code })
    },
    [serial, dispatch],
  )

  const handleOpen = useCallback(
    (entry: FileEntry) => {
      if (serial === null) return
      // 【I4】链接目录也要能进：目标解析、无法解析、成环三种情况都在 openTarget 里判（有单测）
      const { trail, hops } = linkStateRef.current
      const target = openTarget(entry, current.cwd, trail, hops)
      if (target.kind === 'enter') {
        // 【N2】跟随链接时把 linkTarget 传下去，reducer 才会真正写轨迹与跳数；
        // 普通目录不传（会重置轨迹），这样防环只在「连续跟随链接」的链上生效。
        //
        // 【N4】跟随链接失败时（目标其实是文件/断链），把 E_NOT_FOUND 升级成
        // E_NOT_A_DIRECTORY，避免「路径不存在」的错误文案 —— 路径是存在的。
        const followed = target.followedLink ? target.path : undefined
        if (followed === undefined) {
          void openDir(serial, target.path)
          return
        }
        void openDir(serial, target.path, followed).then(() => {
          const view = useFileStore.getState().views[serial]
          if (view === undefined || view.addressError === null) return
          const mapped = mapListError(view.addressError, entry.name, followed)
          if (mapped !== view.addressError) {
            dispatch(serial, { type: 'addressError', code: mapped })
          }
        })
        return
      }
      if (target.kind === 'error') {
        reportLinkError(target.code)
        return
      }
      // 普通文件：本任务不做打开（留给任务 9 的下载/预览）
    },
    [serial, openDir, current.cwd, reportLinkError],
  )

  const handleSelect = useCallback(
    (entry: FileEntry, additive: boolean) => {
      if (serial === null) return
      dispatch(serial, { type: 'select', name: entry.name, additive })
    },
    [serial, dispatch],
  )

  const handleJump = useCallback(
    (path: string) => {
      if (serial === null) return
      // 【C1】openDir 只登记目标：失败时当前目录与列表原样保留，错误走行内提示
      void openDir(serial, path)
    },
    [serial, openDir],
  )

  // 回填滚动位置时现取 store 里的值：这个函数用作 getter，不参与渲染依赖（见上方注释）
  const getRestoreScrollTop = useCallback(
    () => (serial === null ? 0 : useFileStore.getState().views[serial]?.scrollTop ?? 0),
    [serial],
  )
  const onScrollTop = useCallback(
    (value: number) => {
      if (serial === null) return
      dispatch(serial, { type: 'setScrollTop', value })
    },
    [serial, dispatch],
  )

  /*
   * 【I7】键盘导航（规格 9.5：Enter 打开 / Backspace 上级 / F5 刷新）。
   *
   * 只在列表容器上监听：输入框（地址栏）里的按键不该被这里吞掉 ——
   * 事件从 input 冒泡上来时会先被 Browser 的默认行为处理，这里再用
   * tagName 判断排除，避免「在地址栏里按 Backspace 结果回上级目录」。
   */
  const onListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if (serial === null) return
      const command = navKeyCommand(event.key, current.cwd)
      if (command.kind === 'up') {
        event.preventDefault()
        handleJump(command.path)
        return
      }
      if (command.kind === 'refresh') {
        event.preventDefault()
        void refresh(serial)
      }
    },
    [serial, current.cwd, handleJump, refresh],
  )

  if (serial === null) {
    return <p className="p-8 text-sm text-neutral-500">{t('devices.selectHint')}</p>
  }

  const notice = current.notice !== null && !current.noticeDismissed ? current.notice : null
  const restoreKey = serial + '\u0001' + current.cwd + '\u0001' + current.status

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-neutral-800 pr-2">
        <div className="min-w-0 flex-1">
          <Breadcrumb
            path={current.cwd}
            onJump={handleJump}
            addressError={current.addressError}
            onAddressError={(code) => { dispatch(serial, { type: 'addressError', code }) }}
          />
        </div>
        <button
          type="button"
          onClick={() => { dispatch(serial, { type: 'setShowHidden', value: !current.showHidden }) }}
          title={current.showHidden ? t('files.hideHidden') : t('files.showHidden')}
          className={
            'shrink-0 rounded p-1.5 ' +
            (current.showHidden
              ? 'bg-neutral-800 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100')
          }
        >
          {current.showHidden
            ? <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            : <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={() => { void refresh(serial) }}
          title={t('files.refresh')}
          className="shrink-0 rounded p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
        >
          <RefreshCw className={'h-3.5 w-3.5 ' + (current.status === 'loading' ? 'animate-spin' : '')} aria-hidden="true" />
        </button>
      </div>

      {notice !== null && (
        <div className="flex items-start gap-2 border-b border-amber-900/50 bg-amber-950/30 px-3 py-1.5 text-[11px] leading-snug text-amber-300">
          <Warn className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="flex-1">
            {notice.degraded
              ? tf('files.notice.degraded', { count: notice.unparsed })
              : t('files.notice.exitCode')}
          </span>
          <button
            type="button"
            onClick={() => { dispatch(serial, { type: 'dismissNotice' }) }}
            title={t('files.notice.dismiss')}
            className="shrink-0 rounded p-0.5 text-amber-400/70 hover:bg-amber-900/40 hover:text-amber-200"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* 刷新失败（不是跳转失败）：保留列表，只在顶部提示（裁决 3 的同一条原则） */}
      {current.error !== null && current.entries.length > 0 && (
        <div className="border-b border-red-900/50 bg-red-950/30 px-3 py-1 text-[11px] text-red-300">
          {errorText(current.error)}
        </div>
      )}

      {/* 键盘处理挂在 FileTable 的根容器上（只挂一处，避免 Backspace 被处理两次） */}
      <div className="flex min-h-0 flex-1 flex-col outline-none">
        <FileTable
          entries={entries}
          selected={current.selected}
          tzOffsetMinutes={current.tzOffsetMinutes}
          status={current.status}
          error={current.error}
          hiddenFiltered={hiddenFiltered}
          restoreKey={restoreKey}
          getRestoreScrollTop={getRestoreScrollTop}
          onScrollTop={onScrollTop}
          onOpen={handleOpen}
          onSelect={handleSelect}
          onRetry={() => { void refresh(serial) }}
          sort={current.sort}
          sortDir={current.sortDir}
          onSort={(sort) => { dispatch(serial, { type: 'setSort', sort }) }}
          onKeyNav={onListKeyDown}
        />
      </div>

      <div className="flex items-center gap-3 border-t border-neutral-800 px-3 py-1 text-[11px] text-neutral-500">
        <span>{tf('files.summary', { dirs: summary.dirs, files: summary.files })}</span>
        {current.selected.length > 0 && (
          <span className="text-neutral-400">{tf('files.selected', { count: current.selected.length })}</span>
        )}
      </div>
    </section>
  )
}
