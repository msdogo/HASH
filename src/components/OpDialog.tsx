import { useEffect, useState } from 'react'
import { AlertTriangle as Warn, X } from 'lucide-react'
import { errorText, t, tf } from '@shared/i18n'
import { canConfirm, isDestructive, type OpDialog } from '@shared/op-view'
import type { OpSummary } from '@shared/fs-ops'
import { useOpStore } from '@/store/opStore'

/**
 * 文件操作对话框（新建 / 重命名 / 复制 / 移动 / 删除）。
 *
 * ===== 裁决 1：删除的确认框必须说清三件事 =====
 * 1.「将删除 N 项」—— 数字来自主进程的实际检查（fs:remove-facts），不是界面自己数；
 * 2. 前 3 个名字（规格 §9.6），多出的标「另有 N 项未列出」；
 * 3. **其中有非空文件夹** —— 递归删除会连带里面的文件，这句话是用户唯一的警报。
 *
 * 另外还要显示「N 项被安全策略拒绝」：那些项根本没有尝试删除，
 * 用户看到「3 项将删除 + 1 项被拒」才知道为什么总数对不上。
 *
 * 组件里不做判断：能否确认、是否破坏性操作全部来自 @shared/op-view（有单测）。
 */

export interface OpDialogProps {
  serial: string
  cwd: string
  onRefresh: () => void
  /**
   * 渲染期注入（终审 I-5，与 OverviewPage 的 initial 同一手法）。
   *
   * 为什么需要：确认框里「数量 / 前 3 个名字 / 是否非空」这块事实以前只有
   * 「源码里有 tf('op.delete.count'」这类文本断言守着 —— 而把调用点整块换成 null
   * 之后全量 1164 仍全绿（终审实测）。zustand 的 useSyncExternalStore 在 SSR 下取
   * 初始快照，renderToStaticMarkup 里 setState 反映不到渲染结果，所以必须允许注入。
   *
   * 生产不传 → 与改前逐字相同（读 store）。
   */
  initial?: Partial<{ dialog: OpDialog | null; lastSummary: OpSummary | null }>
}

/**
 * 决定「这一屏渲染哪个对话框 / 哪份结果」：没传 initial 时**必须**读 store。
 *
 * 【合并前复审 J / 生产路径门禁】为什么单列成纯函数：
 * 复审实测变异 `props.initial === undefined ? storeDialog : …` → `? null : …`
 * （生产上确认框永远不弹）后 **1203 全绿、tsc 0** —— 注入点写错时没有任何用例会红。
 * 抽成纯函数后 tests/component-wiring.test.tsx 直接断言
 * 「initial 为 undefined → 原样返回 store 的两份引用」与「initial 给了就以它为准」，
 * 方向写反或退化成 null 都会红。
 *
 * 语义保留改前的 `=== undefined`（不是 `??`）：传 `initial={{}}` 时应得到 null
 * 而不是偷读 store —— 否则测试里「显式要求空对话框」根本表达不出来。
 */
export function pickDialogState(
  initial: OpDialogProps['initial'],
  store: { dialog: OpDialog | null; lastSummary: OpSummary | null },
): { dialog: OpDialog | null; lastSummary: OpSummary | null } {
  if (initial === undefined) return store
  return { dialog: initial.dialog ?? null, lastSummary: initial.lastSummary ?? null }
}

export function OpDialogHost(props: OpDialogProps) {
  const storeDialog = useOpStore((state) => state.dialog)
  const storeLastSummary = useOpStore((state) => state.lastSummary)
  const dismissSummary = useOpStore((state) => state.dismissSummary)
  const { dialog, lastSummary } = pickDialogState(props.initial, {
    dialog: storeDialog,
    lastSummary: storeLastSummary,
  })

  if (dialog === null) {
    return lastSummary === null ? null : <OpResultNotice summary={lastSummary} onDismiss={dismissSummary} />
  }
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/30">
      <OpDialogCard key={dialog.kind + ':' + dialog.targets.join('|')} dialog={dialog} serial={props.serial} cwd={props.cwd} onRefresh={props.onRefresh} />
    </div>
  )
}

function titleKey(dialog: OpDialog): string {
  switch (dialog.kind) {
    case 'delete': return 'op.delete.title'
    case 'newFolder': return 'op.newFolder.title'
    case 'rename': return 'op.rename.title'
    case 'copy': return 'op.copy.title'
    case 'move': return 'op.move.title'
    default: return 'op.delete.title'
  }
}

function OpDialogCard(props: { dialog: OpDialog; serial: string; cwd: string; onRefresh: () => void }) {
  const dialog = props.dialog
  const close = useOpStore((state) => state.close)
  const remove = useOpStore((state) => state.remove)
  const mkdir = useOpStore((state) => state.mkdir)
  const rename = useOpStore((state) => state.rename)
  const copy = useOpStore((state) => state.copy)
  const move = useOpStore((state) => state.move)
  // busy 从 store 现取（用局部 state 订阅，避免整个对话框重渲染两次）
  const [busy, setBusy] = useState(() => useOpStore.getState().busy)
  useEffect(() => useOpStore.subscribe((next) => { setBusy(next.busy) }), [])

  const [name, setName] = useState('')
  const [dstDir, setDstDir] = useState(props.cwd)
  useEffect(() => { setDstDir(props.cwd) }, [props.cwd])

  const needsName = dialog.kind === 'newFolder' || dialog.kind === 'rename'
  const needsDir = dialog.kind === 'copy' || dialog.kind === 'move'
  const canGo = canConfirm({ dialog, busy, lastSummary: null }) && (!needsName || name.trim() !== '') && (!needsDir || dstDir.trim() !== '')

  const confirm = async (): Promise<void> => {
    if (!canGo) return
    if (dialog.kind === 'delete') {
      await remove(props.serial, dialog.targets)
    } else if (dialog.kind === 'newFolder') {
      await mkdir(props.serial, props.cwd, name)
    } else if (dialog.kind === 'rename') {
      const from = dialog.targets[0]
      if (from !== undefined) await rename(props.serial, from, name)
    } else if (dialog.kind === 'copy') {
      await copy(props.serial, dialog.targets, dstDir)
    } else if (dialog.kind === 'move') {
      await move(props.serial, dialog.targets, dstDir)
    }
    props.onRefresh()
  }

  return (
    <div className="w-[440px] max-w-[92vw] rounded-lg border border-neutral-300 bg-neutral-100 p-4 shadow-xl">
      <div className="flex items-center gap-2">
        <h2 className={'text-sm font-medium ' + (isDestructive(dialog) ? 'text-red-600' : 'text-neutral-900')}>
          {t(titleKey(dialog))}
        </h2>
        <button
          type="button"
          onClick={close}
          disabled={busy}
          title={t('op.cancel')}
          className="ml-auto rounded p-0.5 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900 disabled:opacity-40"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {dialog.kind === 'delete' ? <DeleteFacts facts={dialog.facts} /> : (
        <div className="mt-3 space-y-2 text-xs text-neutral-700">
          {needsName && (
            <label className="block">
              <span className="text-neutral-600">{t('op.field.name')}</span>
              <input
                autoFocus
                value={name}
                spellCheck={false}
                aria-label={t('op.field.name')}
                onChange={(event) => { setName(event.target.value) }}
                onKeyDown={(event) => { if (event.key === 'Enter') void confirm() }}
                placeholder={dialog.kind === 'newFolder' ? t('op.field.folderPlaceholder') : t('op.field.namePlaceholder')}
                className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-neutral-900"
              />
            </label>
          )}
          {needsDir && (
            <label className="block">
              <span className="text-neutral-600">{t('op.field.dstPlaceholder')}</span>
              <input
                autoFocus
                value={dstDir}
                spellCheck={false}
                aria-label={t('op.field.dstPlaceholder')}
                onChange={(event) => { setDstDir(event.target.value) }}
                onKeyDown={(event) => { if (event.key === 'Enter') void confirm() }}
                className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-neutral-900"
              />
            </label>
          )}
          <p className="text-[11px] text-neutral-500">{tf('files.selected', { count: dialog.targets.length })}</p>
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={close}
          disabled={busy}
          title={t('op.cancel')}
          className="rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-200 disabled:opacity-40"
        >
          {t('op.cancel')}
        </button>
        <button
          type="button"
          disabled={!canGo}
          title={t('op.confirm')}
          onClick={() => { void confirm() }}
          className={
            'rounded px-3 py-1 text-xs font-medium text-white disabled:opacity-40 ' +
            (isDestructive(dialog) ? 'bg-red-600 hover:bg-red-500' : 'bg-sky-600 hover:bg-sky-500')
          }
        >
          {busy ? t('op.busy') : t('op.confirm')}
        </button>
      </div>
    </div>
  )
}

function DeleteFacts(props: { facts: OpDialog['facts'] }) {
  const facts = props.facts
  if (facts === undefined) return <p className="mt-3 text-xs text-red-600">{t('op.busy')}</p>
  return (
    <div className="mt-3 space-y-2 text-xs text-neutral-700">
      <p className="font-medium text-neutral-900">{tf('op.delete.count', { count: facts.count })}</p>
      <ul className="max-h-40 space-y-0.5 overflow-auto rounded bg-neutral-50 p-2 font-mono text-[11px]">
        {facts.names.map((item) => <li key={item} className="truncate">{item}</li>)}
        {facts.truncated && (
          <li className="text-neutral-500">{tf('op.delete.more', { rest: facts.count - facts.names.length })}</li>
        )}
      </ul>
      {facts.hasNonEmptyDir && (
        <p className="flex items-start gap-1 rounded bg-amber-50 px-2 py-1 text-amber-700">
          <Warn className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{t('op.delete.nonEmpty')}</span>
        </p>
      )}
      {facts.blocked.length > 0 && (
        <div className="rounded bg-neutral-50 px-2 py-1 text-[11px] text-neutral-600">
          <p>{tf('op.delete.blocked', { count: facts.blocked.length })}</p>
          <ul className="mt-0.5 space-y-0.5">
            {facts.blocked.map((item) => (
              <li key={item.name} className="truncate" title={errorText(item.code ?? 'E_UNKNOWN')}>
                {item.name} · {errorText(item.code ?? 'E_UNKNOWN')}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-red-700">{t('op.delete.irreversible')}</p>
    </div>
  )
}

function OpResultNotice(props: { summary: OpSummary; onDismiss: () => void }) {
  const { summary, onDismiss } = props
  const allOk = summary.failed === 0
  return (
    <div
      className={
        'absolute bottom-3 left-1/2 z-20 w-[460px] max-w-[92vw] -translate-x-1/2 rounded-lg border px-3 py-2 text-xs shadow-lg ' +
        (allOk ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')
      }
      data-testid="op-result"
    >
      <div className="flex items-start gap-2">
        <span className="flex-1 font-medium">
          {allOk ? tf('op.result.allOk', { ok: summary.ok }) : tf('op.result.title', { ok: summary.ok, failed: summary.failed })}
        </span>
        <button type="button" onClick={onDismiss} title={t('op.result.dismiss')} className="shrink-0">
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
      {!allOk && (
        <ul className="mt-1 max-h-28 space-y-0.5 overflow-auto text-[11px]">
          {summary.failures.map((item, index) => (
            <li key={item.name + '-' + index} className="truncate" title={errorText(item.code ?? 'E_UNKNOWN')}>
              {item.name === '' ? errorText(item.code ?? 'E_UNKNOWN') : item.name + ' · ' + errorText(item.code ?? 'E_UNKNOWN')}
              {/*
                【审查 I5】部分完成时把「已删 N / 剩余 M」显示出来。
                只说「操作只完成了一部分」等于没说 —— 用户既不知道现场长什么样，
                也不知道重试会撞上什么。这两个数字是唯一能让他做决定的依据。
              */}
              {item.removed !== undefined && item.remaining !== undefined && (
                <span className="ml-1 text-amber-700">
                  （{tf('op.result.partial', { removed: item.removed, remaining: item.remaining })}）
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
