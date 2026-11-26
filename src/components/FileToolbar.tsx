import { useEffect, useRef, useState } from 'react'
import { FolderPlus, Pencil, Trash2, Copy, MoveRight, ArrowDownToLine, ListChecks, Search, X, Camera, CircleDot, Square, Smartphone } from 'lucide-react'
import { isSearchClearKey, isSearchFocusKey } from '@shared/file-view'
import { t } from '@shared/i18n'

/**
 * 文件操作工具条（任务 9）。
 *
 * 只做「按钮 → 回调」的转接，所有判断都在 FilesPage 与 @shared/op-view 里。
 * 每个按钮都带 title（中文 tooltip），且在没有选中项时禁用 ——
 * 让用户看到「这个按钮存在但现在用不了」，比让它消失更好：消失了就不知道有这功能。
 */

export interface FileToolbarProps {
  /** 选中的名字（可能为空）。 */
  selectedCount: number
  /** 有可用的当前目录（没有设备时全禁用）。 */
  ready: boolean
  onCreateFolder: () => void
  onRename: () => void
  onDelete: () => void
  onCopyTo: () => void
  onMoveTo: () => void
  /** 裁决 7：下载入口（任务 8 遗留 I4）。 */
  onDownload: () => void
  /**
   * 全选（R2-2：多选功能一直没有可见入口）。
   *
   * 它**不**按 selectedCount 禁用 —— 全选的意义就是「当前没有选中」，
   * 禁用它等于把这条唯一的显式入口在最有用的时刻关掉。
   */
  onSelectAll: () => void
  /* ---- P1：单机截图 / 录屏 ---- */
  /** 截图（截整块屏幕，与选中项无关）。 */
  onScreenshot: () => void
  /** 开始录屏。 */
  onRecordStart: () => void
  /** 停止录屏（按钮文案随之变化）。 */
  onRecordStop: () => void
  /** 当前是否正在录屏（决定按钮显示「录屏」还是「停止录屏」）。 */
  recording: boolean
  /* ---- P1 第三批：scrcpy 投屏 ---- */
  /**
   * 打开投屏窗口。
   *
   * 与截图/录屏同一判据（只受 ready 约束，与选中项无关）：
   * 投的是整台设备的画面，跟选了几个文件没有关系。
   */
  onMirror: () => void
  /*
   * 【R10 删除】这里原本有一个 downloadHint（「没有本地目标目录」等提示）。
   * 提示区现在统一在**底部传输栏**（TransferDock）—— 简报明确要求的位置。
   * 两处都渲染等于同一句话在界面上下各闪一次，用户会以为发生了两件事。
   * 提示的状态也随之搬进 transferStore.notice（TransferDock 与 FilesPage 是兄弟组件，
   * 兄弟之间只能靠共享状态传话）。
   */  /**
   * R6：当前目录文件名过滤词（空串 = 不过滤）。
   *
   * 它放在工具条**右端**（与左侧的文件操作按钮用 ml-auto 隔开）：
   * 左边是「对选中项做操作」，右边是「看哪些行」，两类动作语义不同，不该混排。
   * 搜索框**不新增行高** —— 工具条本来就是一条 24px 左右的横条，右侧一直是空的。
   */
  query: string
  /** R6：改过滤词。空串由工具条的清除按钮 / Esc 发出。 */
  onQueryChange: (value: string) => void
}

export function FileToolbar(props: FileToolbarProps) {
  const none = props.selectedCount === 0
  const disabled = !props.ready
  return (
    <div className="flex items-center gap-0.5 border-b border-neutral-300 px-2 py-1">
      <ToolButton icon={<FolderPlus className="h-3.5 w-3.5" />} label={t('op.toolbar.newFolder')} onClick={props.onCreateFolder} disabled={disabled} />
      <ToolButton icon={<Pencil className="h-3.5 w-3.5" />} label={t('op.toolbar.rename')} onClick={props.onRename} disabled={disabled || none || props.selectedCount > 1} />
      <ToolButton icon={<Copy className="h-3.5 w-3.5" />} label={t('op.toolbar.copyTo')} onClick={props.onCopyTo} disabled={disabled || none} />
      <ToolButton icon={<MoveRight className="h-3.5 w-3.5" />} label={t('op.toolbar.moveTo')} onClick={props.onMoveTo} disabled={disabled || none} />
      {/* 下载入口：任务 8 有队列能力但没界面入口（I4），这里补上 */}
      <ToolButton icon={<ArrowDownToLine className="h-3.5 w-3.5" />} label={t('op.toolbar.download')} onClick={props.onDownload} disabled={disabled || none} />
      {/*
        * P1：截图 / 录屏。
        *
        * 两个按钮**不按选中项禁用**：截的是整块屏幕，与选了哪些文件无关。
        * 只受 `disabled`（没有设备 / 没有可用目录）约束，与「全选」同一判据。
        */}
      <ToolButton
        icon={<Camera className="h-3.5 w-3.5" />}
        label={t('capture.screenshot')}
        onClick={props.onScreenshot}
        disabled={disabled}
      />
      <ToolButton
        icon={props.recording ? <Square className="h-3.5 w-3.5" /> : <CircleDot className="h-3.5 w-3.5" />}
        label={props.recording ? t('capture.record.stop') : t('capture.record.start')}
        onClick={props.recording ? props.onRecordStop : props.onRecordStart}
        disabled={disabled}
        danger={props.recording}
      />
      {/* 投屏：打开一个独立的原生嵌入窗口，不改当前页、不改选中项 */}
      <ToolButton
        icon={<Smartphone className="h-3.5 w-3.5" />}
        label={t('mirror.open')}
        onClick={props.onMirror}
        disabled={disabled}
      />
      {/*
        * 全选（R2-2）。刻意只受 `disabled`（没有可用目录/没有设备）约束，
        * **不**受 `none` 约束：没有任何选中项时正是它最该可点的时刻。
        */}
      <ToolButton icon={<ListChecks className="h-3.5 w-3.5" />} label={t('files.toolbar.selectAll')} onClick={props.onSelectAll} disabled={disabled} />
      <span className="mx-1 h-3 w-px bg-neutral-200" />
      <ToolButton
        icon={<Trash2 className="h-3.5 w-3.5" />}
        label={t('op.toolbar.delete')}
        onClick={props.onDelete}
        disabled={disabled || none}
        danger
      />
      {/* 提示区不在这里：见 R10 的说明（统一在底部传输栏） */}
      <SearchBox query={props.query} onQueryChange={props.onQueryChange} />
    </div>
  )
}

/**
 * 当前目录文件名搜索框（R6）。
 *
 * 纯「输入框 → 回调」的转接：真正的过滤在 @shared/file-view 的 matchesQuery / filterEntries
 * 里（表驱动用例），这里不判断任何匹配逻辑 —— 组件里再写一遍就是两套规则，
 * 用户看到的行与「匹配 N」的计数会分叉。
 *
 * 两个快捷键的**判定**在 shared 的 isSearchFocusKey / isSearchClearKey 里（有单测）；
 * 这里只剩「把 window 上的 keydown 转过去」的接线，它在 SSR 下不执行，属已知无门禁。
 */
function SearchBox(props: { query: string; onQueryChange: (value: string) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isSearchFocusKey(event)) return
      // Ctrl+F 在浏览器/Electron 里是「页面查找」：不拦掉会弹出一个对我们列表无效的查找条
      event.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [])

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
      <Search className="h-3 w-3 shrink-0 text-neutral-400" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        value={props.query}
        spellCheck={false}
        aria-label={t('files.searchPlaceholder')}
        placeholder={t('files.searchPlaceholder')}
        /* 受控输入的 onChange 在无 jsdom 工程里观测不到；过滤行为本身有纯函数用例 */
        onChange={(event) => { props.onQueryChange(event.target.value) }}
        onKeyDown={(event) => {
          if (!isSearchClearKey(event.key)) return
          // Esc：清空并失焦，把焦点还给列表（否则紧接着的 Backspace/Enter 会被输入框吃掉）
          event.stopPropagation()
          props.onQueryChange('')
          event.currentTarget.blur()
        }}
        className="w-40 rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-[11px] text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
      />
      {/*
        * 清除按钮只在有内容时出现：空输入框配一个叉号是没有信息的装饰。
        * 点击态由 onMouseDown 的 preventDefault 保证输入框不会先失焦再回填。
      */}
      {props.query !== '' && (
        <button
          type="button"
          title={t('files.searchClear')}
          aria-label={t('files.searchClear')}
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={() => { props.onQueryChange('') }}
          className="shrink-0 rounded p-0.5 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900"
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

function ToolButton(props: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled: boolean
  danger?: boolean
}) {
  const [pressed, setPressed] = useState(false)
  return (
    <button
      type="button"
      disabled={props.disabled}
      title={props.label}
      aria-label={props.label}
      onMouseDown={() => { setPressed(true) }}
      onMouseUp={() => { setPressed(false) }}
      onMouseLeave={() => { setPressed(false) }}
      onClick={props.onClick}
      className={
        'flex items-center gap-1 rounded px-1.5 py-1 text-[11px] disabled:opacity-30 ' +
        (props.danger
          ? 'text-red-700 hover:bg-red-50'
          : 'text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900') +
        (pressed ? ' bg-neutral-200' : '')
      }
    >
      {props.icon}
      <span className="hidden xl:inline">{props.label}</span>
    </button>
  )
}
