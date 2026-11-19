import { useState } from 'react'
import { FolderPlus, Pencil, Trash2, Copy, MoveRight, ArrowDownToLine } from 'lucide-react'
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
  /** 下载提示（没有本地目标目录时的说明）。 */
  downloadHint: string | null
}

export function FileToolbar(props: FileToolbarProps) {
  const none = props.selectedCount === 0
  const disabled = !props.ready
  return (
    <div className="flex items-center gap-0.5 border-b border-neutral-800 px-2 py-1">
      <ToolButton icon={<FolderPlus className="h-3.5 w-3.5" />} label={t('op.toolbar.newFolder')} onClick={props.onCreateFolder} disabled={disabled} />
      <ToolButton icon={<Pencil className="h-3.5 w-3.5" />} label={t('op.toolbar.rename')} onClick={props.onRename} disabled={disabled || none || props.selectedCount > 1} />
      <ToolButton icon={<Copy className="h-3.5 w-3.5" />} label={t('op.toolbar.copyTo')} onClick={props.onCopyTo} disabled={disabled || none} />
      <ToolButton icon={<MoveRight className="h-3.5 w-3.5" />} label={t('op.toolbar.moveTo')} onClick={props.onMoveTo} disabled={disabled || none} />
      {/* 下载入口：任务 8 有队列能力但没界面入口（I4），这里补上 */}
      <ToolButton icon={<ArrowDownToLine className="h-3.5 w-3.5" />} label={t('op.toolbar.download')} onClick={props.onDownload} disabled={disabled || none} />
      <span className="mx-1 h-3 w-px bg-neutral-800" />
      <ToolButton
        icon={<Trash2 className="h-3.5 w-3.5" />}
        label={t('op.toolbar.delete')}
        onClick={props.onDelete}
        disabled={disabled || none}
        danger
      />
      {props.downloadHint !== null && (
        <span className="ml-2 min-w-0 truncate text-[10px] text-amber-400">{props.downloadHint}</span>
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
          ? 'text-red-400 hover:bg-red-950/50'
          : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100') +
        (pressed ? ' bg-neutral-800' : '')
      }
    >
      {props.icon}
      <span className="hidden xl:inline">{props.label}</span>
    </button>
  )
}
