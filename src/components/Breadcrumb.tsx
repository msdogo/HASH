import { useEffect, useRef, useState } from 'react'
import { ChevronRight as ChevronRight, ArrowUp as ArrowUp } from 'lucide-react'
import { parentOf, parseTypedPath, segmentsOf, type PathSegment } from '@shared/file-view'
import { E_INVALID_PATH } from '@shared/errors'
import { errorText, t } from '@shared/i18n'

/**
 * 面包屑 + 地址栏（裁决 6）。
 *
 * - 任意一段都能点回该层（不只是上一级）；
 * - 地址栏可手输路径回车跳转，非法输入只做**行内报错**，绝不整页替换成错误页；
 * - 跳到符号链接目录或不存在目录由 fs:list 的结果决定，错误码以行内提示呈现。
 *
 * 组件里不做路径判断：切段、归一化、合法性全在 @shared/file-view（有单测）。
 */

export interface BreadcrumbProps {
  path: string
  /** 跳到某层（面包屑点击 / 地址栏回车 / 上一级）。 */
  onJump: (path: string) => void
  /** 地址栏行内错误码（非法输入）；null 表示没有。 */
  addressError: string | null
  /** 通知父级清掉行内错误（开始编辑时）。 */
  onAddressError: (code: string) => void
  /** 是否有上一层（根目录时禁用「上一级」）。 */
  disabled?: boolean
}

export function Breadcrumb(props: BreadcrumbProps) {
  const segments: PathSegment[] = segmentsOf(props.path)
  const parent = parentOf(props.path)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(props.path)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // 非编辑态时 draft 跟随当前目录（从别处跳转后打开编辑框要拿到最新路径）
  useEffect(() => {
    if (!editing) setDraft(props.path)
  }, [props.path, editing])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const submit = (): void => {
    const parsed = parseTypedPath(draft)
    if (!parsed.ok) {
      props.onAddressError(parsed.code)
      return
    }
    setEditing(false)
    props.onJump(parsed.path)
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          disabled={parent === null}
          onClick={() => { if (parent !== null) props.onJump(parent) }}
          title={t('files.up')}
          className="mr-1 shrink-0 rounded p-1 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
        </button>

        {editing
          ? (
            <input
              ref={inputRef}
              value={draft}
              spellCheck={false}
              aria-label={t('files.addressEdit')}
              onChange={(event) => { setDraft(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
                if (event.key === 'Escape') { setEditing(false); setDraft(props.path) }
              }}
              onBlur={() => { if (draft === props.path) setEditing(false) }}
              placeholder={t('files.addressPlaceholder')}
              className={
                'min-w-0 flex-1 rounded border bg-neutral-100 px-2 py-1 font-mono text-xs ' +
                (props.addressError === null
                  ? 'border-neutral-300 text-neutral-900'
                  : 'border-red-700 text-red-700')
              }
            />
          )
          : (
            <div
              role="button"
              tabIndex={0}
              onClick={() => { setEditing(true) }}
              onKeyDown={(event) => { if (event.key === 'Enter') setEditing(true) }}
              title={t('files.addressEdit')}
              className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 rounded px-1 py-0.5 hover:bg-neutral-200/70"
            >
              {segments.map((segment, index) => (
                <span key={segment.path} className="flex items-center gap-0.5">
                  {index > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-neutral-400" aria-hidden="true" />}
                  <button
                    type="button"
                    onClick={(event) => { event.stopPropagation(); props.onJump(segment.path) }}
                    className={
                      'max-w-[220px] truncate rounded px-1 text-xs ' +
                      (index === segments.length - 1
                        ? 'font-medium text-neutral-900'
                        : 'text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900')
                    }
                  >
                    {segment.name}
                  </button>
                </span>
              ))}
            </div>
          )}
      </div>

      {/*
        行内报错（裁决 6）：只在这一行提示，绝不把整页替换成错误。
        语法错误（E_INVALID_PATH，地址栏自己的输入问题）用地址栏专属文案；
        其余错误码（例如真跳过去才发现不存在）走统一的错误码翻译。
      */}
      {props.addressError !== null && (
        <p className="px-3 pb-1 text-[11px] text-red-600">
          {props.addressError === E_INVALID_PATH ? t('files.addressInvalid') : errorText(props.addressError)}
        </p>
      )}
    </div>
  )
}
