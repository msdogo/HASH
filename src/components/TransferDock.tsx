import { useMemo, useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, Ban, RefreshCw, Trash2, X, AlertTriangle as Warn } from 'lucide-react'
import { canRetry, type TransferSnapshot, type TransferTask } from '@shared/transfer'
import { dockRows, hasFinishedTransfer } from '@shared/transfer-view'
import { errorText, t, tf } from '@shared/i18n'
import { useDeviceStore } from '@/store/deviceStore'
import { useTransferStore } from '@/store/transferStore'
import { useFileStore } from '@/store/fileStore'

/**
 * 传输底栏（任务 8）。
 *
 * 只做三件事：把状态渲染成行、把按钮点击转成 store 调用、把文案交给 i18n。
 * 所有判断（排序、能不能取消/重试、进度展示态）都在 @shared/transfer-view 与
 * @shared/transfer 的纯函数里，那些有单测；这里不写任何业务判断。
 */
export function TransferDock() {
  const snapshot = useTransferStore((state) => state.snapshot)
  const enqueue = useTransferStore((state) => state.enqueue)
  const cancel = useTransferStore((state) => state.cancel)
  const retry = useTransferStore((state) => state.retry)
  const clearFinished = useTransferStore((state) => state.clearFinished)

  const serial = useDeviceStore((state) => state.activeSerial)
  const devices = useDeviceStore((state) => state.devices)
  const [error, setError] = useState<string | null>(null)

  // 设备离线集合：用于把「排队中但设备已掉线」标出来（裁决 4）
  const offlineSerials = useMemo(
    () => devices.filter((d) => d.status !== 'device').map((d) => d.serial),
    [devices],
  )
  const rows = useMemo(() => dockRows(snapshot, offlineSerials), [snapshot, offlineSerials])

  /** 当前目录（上传目标；下载目标的本地目录由用户在选择框里给）。 */
  const currentDir = useFileStore((state) =>
    serial === null ? undefined : state.views[serial]?.cwd,
  )

  const handleUpload = async (): Promise<void> => {
    if (serial === null || currentDir === undefined) {
      setError(t('transfer.noDevice'))
      return
    }
    const picked = await window.api.transfer.pickFiles()
    if (!picked.ok) {
      setError(errorText(picked.error))
      return
    }
    // 用户取消选择：什么都不做（不是错误）
    if (picked.data.length === 0) return
    setError(null)
    for (const localPath of picked.data) {
      const code = await enqueue({ serial, direction: 'push', src: localPath, dstDir: currentDir })
      if (code !== null) { setError(errorText(code)); return }
    }
  }

  const handleRowAction = async (action: Promise<string | null>): Promise<void> => {
    const code = await action
    setError(code === null ? null : errorText(code))
  }

  return (
    <footer className="border-t border-neutral-300 bg-neutral-50 px-3 py-1.5 text-[11px] text-neutral-600">
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-medium text-neutral-700">{t('transfer.title')}</span>
        <span className="min-w-0 flex-1 truncate">
          {snapshot.running + snapshot.queued === 0
            ? t('transfer.idle')
            : tf('transfer.summary', { running: snapshot.running, queued: snapshot.queued })}
        </span>
        <button
          type="button"
          disabled={serial === null}
          onClick={() => { void handleUpload() }}
          title={t('transfer.upload')}
          className="shrink-0 rounded px-1.5 py-0.5 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900 disabled:opacity-40"
        >
          <ArrowUpFromLine className="h-3 w-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          disabled={!hasFinishedTransfer(snapshot)}
          onClick={() => { void handleRowAction(clearFinished()) }}
          title={t('transfer.clearFinished')}
          className="shrink-0 rounded px-1.5 py-0.5 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900 disabled:opacity-40"
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>

      {error !== null && (
        <div className="mt-1 flex items-start gap-1 text-[11px] text-red-600">
          <Warn className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => { setError(null) }} title={t('files.notice.dismiss')} className="shrink-0">
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      )}

      {rows.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {rows.map((row) => (
            <TransferRow
              key={row.id}
              row={row}
              onCancel={() => { void handleRowAction(cancel(row.id)) }}
              onRetry={() => { void handleRowAction(retry(row.id)) }}
            />
          ))}
        </ul>
      )}
    </footer>
  )
}

/** 底栏的一行。纯展示：不读 store、不做判断。 */
function TransferRow(props: {
  row: ReturnType<typeof dockRows>[number]
  onCancel: () => void
  onRetry: () => void
}) {
  const { row, onCancel, onRetry } = props
  const percent = row.progress.kind === 'determinate' ? row.progress.percent : null
  return (
    <li className="flex items-center gap-2">
      {row.direction === 'push'
        ? <ArrowUpFromLine className="h-3 w-3 shrink-0 text-neutral-500" aria-hidden="true" />
        : <ArrowDownToLine className="h-3 w-3 shrink-0 text-neutral-500" aria-hidden="true" />}
      <span className="shrink-0 text-neutral-500">{row.serialTail}</span>
      <span className="min-w-0 flex-1 truncate" title={row.fileName}>
        {t('transfer.direction.' + row.direction)} {row.fileName}
      </span>
      <span className="shrink-0 tabular-nums text-neutral-500">{row.progressText}</span>
      {percent === null
        ? <span className="shrink-0 text-neutral-500">{t('transfer.unknownTotal')}</span>
        : (
          <span className="flex w-24 shrink-0 items-center gap-1">
            <span className="h-1 flex-1 overflow-hidden rounded bg-neutral-200">
              <span className="block h-full bg-sky-500" style={{ width: percent + '%' }} />
            </span>
            <span className="w-8 shrink-0 text-right tabular-nums">{Math.round(percent)}%</span>
          </span>
        )}
      <span className="shrink-0 text-neutral-500">{t('transfer.status.' + row.status)}</span>
      {row.overwrote && <span className="shrink-0 text-amber-600" title={t('transfer.overwrote')}>{t('transfer.overwrote')}</span>}
      {row.pausedOffline && <span className="shrink-0 text-amber-600">{t('transfer.queuedOnOffline')}</span>}
      {row.error !== undefined && (
        <span className="shrink-0 max-w-40 truncate text-red-600" title={errorText(row.error)}>{errorText(row.error)}</span>
      )}
      {row.canCancel && (
        <button type="button" onClick={onCancel} title={t('transfer.cancel')} className="shrink-0 rounded p-0.5 hover:bg-neutral-200">
          <Ban className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
      {row.canRetry && (
        <button type="button" onClick={onRetry} title={t('transfer.retry')} className="shrink-0 rounded p-0.5 hover:bg-neutral-200">
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </li>
  )
}
