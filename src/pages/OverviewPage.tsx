import { useCallback, useMemo, useState } from 'react'
import { Camera, Download as PushIcon, Terminal, PackageOpen } from 'lucide-react'
import type { DeviceSession } from '@shared/types'
import type { BatchActionKind } from '@shared/batch'
import {
  activeTaskCount,
  batchDetailKey,
  batteryPercent,
  buttonStates,
  storageView,
  summarizeBatch,
} from '@shared/batch'
import { deviceLabel, statusDot, DOT_CLASS, DOT_LABEL_KEY } from '@shared/device-view'
import { errorText, t, tf } from '@shared/i18n'
import { submitShell } from '@shared/batch-shell'
import { useBatchStore, resultRows } from '@/store/batchStore'
import type { BatchResultRow } from '@/store/batchStore'
import { useDeviceStore } from '@/store/deviceStore'
import { useTransferStore } from '@/store/transferStore'

/**
 * 全设备总览页（任务 10 / 规格 §9.3）。
 *
 * 一张设备表（勾选）+ 四个批量动作 + 逐台结果矩阵。
 *
 * ===== 组件只做三件事 =====
 * 1. 把事件转成 store 调用（勾选、点按钮、填输入框）；
 * 2. 把状态转成 DOM（表格、结果矩阵）；
 * 3. 把「是否禁用」「显示什么占位」交给 shared 的纯函数（有单测）。
 *
 * ===== 数据可得性如实处理（简报要求） =====
 * DeviceSession 的 battery / storage 是可选的，而当前唯一数据来源是 adb devices -l，
 * **不含**电量与存储。所以这两列在字段缺失时显示占位符（—），绝不伪造 0% / 100%，
 * 也不在这里逐台去 shell 查（那是 N 次往返，首屏会卡住）。
 * 页面底部有一条说明：电量与存储暂不可用 —— 用户看到「—」时知道这是能力缺失，
 * 而不是设备真的没有电池。
 */
export function OverviewPage() {
  const devices = useDeviceStore((state) => state.devices)
  const tasks = useTransferStore((state) => state.snapshot.tasks)

  const running = useBatchStore((state) => state.running)
  const results = useBatchStore((state) => state.results)
  const action = useBatchStore((state) => state.action)
  const error = useBatchStore((state) => state.error)
  const notice = useBatchStore((state) => state.notice)
  const run = useBatchStore((state) => state.run)
  const dismiss = useBatchStore((state) => state.dismiss)

  /** 勾选的 serial（顺序即用户点击顺序；结果矩阵的顺序由主进程按入参回填）。 */
  const [picked, setPicked] = useState<string[]>([])
  /** 批量推送的目标目录（设备上的绝对路径）。 */
  const [dstDir, setDstDir] = useState('/sdcard/Download')
  /** 批量执行命令的内容。 */
  const [command, setCommand] = useState('')
  /** 批量推送选中的本地文件（走主进程的文件选择框）。 */
  const [files, setFiles] = useState<string[]>([])

  const toggle = useCallback((serial: string) => {
    setPicked((current) =>
      current.includes(serial) ? current.filter((item) => item !== serial) : [...current, serial],
    )
  }, [])

  /*
   * 全选态（复审 Minor 3）。
   *
   * 修前用 picked.length === devices.length 判断，而 picked 里可能残留**已拔掉设备**的
   * serial —— 那时长度相等但勾选内容并不等于当前设备表，全选框显示的状态是错的，
   * 点一下也只会把 visible 的设备再选一遍（用户看到「全选」却点不出全选）。
   * 现在判据是「每台当前设备都在已勾选集合里」，并且只算可见的那些 tick。
   */
  const visibleSerials = devices.filter((device) => device.status === 'device').map((device) => device.serial)
  const allPicked = visibleSerials.length > 0 && visibleSerials.every((serial) => picked.includes(serial))
  const toggleAll = useCallback(() => {
    setPicked((current) => (current.length === visibleSerials.length ? [] : visibleSerials))
  }, [visibleSerials])

  // 已勾选但已消失的设备不该继续参与批量（用户看不到它，结果里却冒出一行）
  const serials = useMemo(() => {
    const alive = new Set(devices.map((device) => device.serial))
    return picked.filter((serial) => alive.has(serial))
  }, [picked, devices])

  /*
   * 四个按钮的 disabled 全部来自 shared 的纯函数（【N1】）。
   *
   * 上一轮这里是一句内联的 `const disabled = running || serials.length === 0`，
   * 而我在 shared 里写的 canSubmit 根本没人调用 —— 于是「删掉按钮的 disabled」
   * 全套 1093 仍全绿：测的函数和跑的函数是两个。
   *
   * 现在组件只取值、不做判断：判据在 buttonStates 里且有单测，
   * 组件里没有第二份实现可以漂移。推送/命令的额外条件（要有文件、要有命令）
   * 也一并收进同一个函数，不再散落在三处 disabled 表达式里。
   */
  const buttons = buttonStates({
    running,
    pickedCount: serials.length,
    fileCount: files.length,
    dstDir,
    command,
  })

  /**
   * 批量截图（复审 I5：batch:pick-directory 在这里有了真实消费者）。
   *
   * 先让用户选目录，再跑。取消（空串）就什么都不做 —— 与「批量安装」的
   * 取消语义一致：用户按 Esc 不是错误，不该弹错误码，也不该清掉上一次的结果。
   */
  const handleScreenshot = useCallback(async () => {
    const picked_ = await window.api.batch.pickDirectory()
    if (!picked_.ok) return
    if (picked_.data === '') return
    void run({ action: 'screenshot', serials, dstDir: picked_.data })
  }, [run, serials])

  const handleInstall = useCallback(async () => {
    const picked_ = await window.api.batch.pickApk()
    if (!picked_.ok) return
    // 取消选择：什么都不做（不是错误），也不清掉上一次的结果
    if (picked_.data === '') return
    void run({ action: 'install', serials, apkPath: picked_.data })
  }, [run, serials])

  const handlePickFiles = useCallback(async () => {
    const picked_ = await window.api.transfer.pickFiles()
    if (!picked_.ok) return
    setFiles(picked_.data)
  }, [])

  const handlePush = useCallback(() => {
    if (files.length === 0 || dstDir.trim() === '') return
    void run({ action: 'push', serials, files, dstDir: dstDir.trim() })
  }, [run, serials, files, dstDir])

  /**
   * 批量执行命令（规格 §9.6：危险命令必须二次确认，并列出影响设备清单）。
   *
   * 哪些算危险由 shared 的 isDangerousCommand 判定（有单测）：kill-server / reboot / root。
   * 确认框里必须能看到「会在哪些设备上执行」—— 用户勾了 5 台却以为只跑 1 台，
   * 一条 reboot 就会同时重启 5 台。
   */
  /*
   * 规格 §9.6：危险命令必须二次确认，并列出影响设备清单。
   *
   * 【本轮】整段决策搬进 shared/batch-shell.ts 的 submitShell（有单测）：
   * 上一轮这段就在本文件里，复审把整个 if 块删掉之后**全套 1093 仍全绿** ——
   * 组件里的回调渲染不出来、也没有纯函数测试能约束「必须弹确认」。
   *
   * 现在组件只做两件事：把「确认框」和「执行」两个副作用注入进去。
   *   - 确认框文案由 planShellSubmit 产出（含 serial 尾号，N7）；
   *   - 「危险命令取消后绝不执行」这条由 tests/batch-shell.test.ts 钉死。
   */
  const handleShell = useCallback(() => {
    const affected = serials
      .map((serial) => devices.find((device) => device.serial === serial))
      .filter((device): device is DeviceSession => device !== undefined)
    submitShell(
      {
        confirm: (plan) =>
          window.confirm(
            tf('batch.confirmDangerousBody', {
              count: plan.count,
              kind: plan.kind,
              command: plan.command,
              devices: plan.devices,
            }),
          ),
        run: (text) => { void run({ action: 'shell', serials, command: text }) },
      },
      command,
      affected,
    )
  }, [run, serials, command, devices])

  const rows = resultRows(results)
  const summary = summarizeBatch(results ?? [])

  return (
    <section className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-4 py-2">
        <h2 className="mr-2 text-sm font-semibold text-neutral-200">{t('batch.title')}</h2>
        <button
          type="button"
          onClick={() => { void handleScreenshot() }}
          disabled={buttons.screenshot}
          className="flex items-center gap-1 rounded bg-sky-600 px-2.5 py-1 text-xs text-white disabled:opacity-40"
        >
          <Camera className="h-3.5 w-3.5" aria-hidden="true" />
          {t('batch.screenshot')}
        </button>
        <button
          type="button"
          onClick={() => { void handleInstall() }}
          disabled={buttons.install}
          className="flex items-center gap-1 rounded bg-sky-600 px-2.5 py-1 text-xs text-white disabled:opacity-40"
        >
          <PackageOpen className="h-3.5 w-3.5" aria-hidden="true" />
          {t('batch.install')}
        </button>
        <button
          type="button"
          onClick={handlePush}
          disabled={buttons.push}
          className="flex items-center gap-1 rounded bg-sky-600 px-2.5 py-1 text-xs text-white disabled:opacity-40"
        >
          <PushIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {t('batch.push')}
        </button>
        <button
          type="button"
          onClick={handleShell}
          disabled={buttons.shell}
          className="flex items-center gap-1 rounded bg-sky-600 px-2.5 py-1 text-xs text-white disabled:opacity-40"
        >
          <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
          {t('batch.shell')}
        </button>
        {running && <span className="text-xs text-amber-400">{t('batch.running')}</span>}
        <span className="ml-auto text-xs text-neutral-500">
          {tf('batch.selected', { count: serials.length })}
        </span>
      </header>

      {/* 四个动作各自的附加输入：只显示与当前动作有关的字段，避免一行塞四个输入框 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-4 py-1.5 text-xs text-neutral-400">
        <button
          type="button"
          onClick={() => { void handlePickFiles() }}
          className="rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800"
        >
          {t('batch.pickFiles')}
        </button>
        <span className="text-neutral-600">{files.length}</span>
        <label className="flex items-center gap-1">
          {t('batch.dstDir')}
          <input
            value={dstDir}
            onChange={(event) => { setDstDir(event.target.value) }}
            placeholder={t('batch.dstDirPlaceholder')}
            className="w-64 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-neutral-200"
          />
        </label>
        <label className="flex items-center gap-1">
          {t('batch.shell')}
          <input
            value={command}
            onChange={(event) => { setCommand(event.target.value) }}
            placeholder={t('batch.shellPlaceholder')}
            className="w-64 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-neutral-200"
          />
        </label>
      </div>

      {/* 设备表：列 = 勾选 / 型号 / 状态 / Android / 电量 / 存储 / 任务 */}
      <div className="min-h-0 flex-1">
        <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-1 text-[11px] uppercase tracking-wide text-neutral-500">
          <input
            type="checkbox"
            checked={allPicked}
            onChange={toggleAll}
            title={t('batch.selectAll')}
            className="h-3 w-3"
          />
          <span className="w-52 shrink-0">{t('batch.column.device')}</span>
          <span className="w-20 shrink-0">{t('batch.column.status')}</span>
          <span className="w-24 shrink-0">{t('batch.column.android')}</span>
          <span className="w-16 shrink-0">{t('batch.column.battery')}</span>
          <span className="w-44 shrink-0">{t('batch.column.storage')}</span>
          <span className="w-20 shrink-0">{t('batch.column.tasks')}</span>
        </div>
        {devices.length === 0 && (
          <p className="px-4 py-6 text-xs text-neutral-500">{t('devices.empty')}</p>
        )}
        {devices.map((device) => (
          <DeviceRow
            key={device.serial}
            device={device}
            checked={serials.includes(device.serial)}
            taskCount={activeTaskCount(tasks, device.serial)}
            onToggle={toggle}
          />
        ))}
      </div>

      {/* 结果矩阵：顺序与入参一致（主进程按下标回填，R4） */}
      {(rows.length > 0 || error !== null || notice !== null) && (
        <div className="border-t border-neutral-800 px-4 py-2">
          <div className="mb-1 flex items-center gap-2 text-xs">
            <span className="font-medium text-neutral-300">
              {error !== null
                ? errorText(error)
                : notice !== null
                  ? t(notice)
                  : tf('batch.result.title', { ok: summary.ok, failed: summary.failed })}
            </span>
            <button
              type="button"
              onClick={dismiss}
              className="ml-auto rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800"
            >
              {t('batch.result.dismiss')}
            </button>
          </div>
          {/* R4 明确允许同一 serial 重复出现 → key 必须带下标，否则 React 会复用错行 */}
          {rows.map((row, index) => (
            <div key={row.serial + '#' + index} className="flex items-center gap-2 py-0.5 text-xs">
              <span className={row.ok ? 'text-emerald-400' : 'text-red-400'}>
                {row.ok ? '✔' : '✖'}
              </span>
              <span className="w-52 shrink-0 truncate text-neutral-300">{row.serial}</span>
              <span className="flex-1 truncate text-neutral-500">
                {row.ok ? detailText(action, row) : errorText(row.code ?? 'E_UNKNOWN')}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 数据可得性如实说明：电量与存储列当前没有数据来源 */}
      <p className="border-t border-neutral-800 px-4 py-1.5 text-[11px] text-neutral-600">
        {t('batch.storageMissing')}
      </p>
    </section>
  )
}

/**
 * 结果行右侧那句话。
 *
 * 文案的拼接规则在 shared 的 batchDetailKey 里（有单测）：
 * 主进程只带「任务 id / 文件数 / stdout 摘要」这类语言中立的数据，
 * 中文在这里按 i18n key 拼出来 —— 否则主进程会散落一堆用户可见的硬编码中文。
 */
function detailText(action: BatchActionKind | null, row: BatchResultRow): string {
  // 截断优先：用户必须知道「这不是全部输出」
  if (row.truncated) return t('batch.result.truncated')
  // 没有动作信息（理论上只在恢复旧状态时发生）：退回占位符，别把内部 id 贴给用户
  if (action === null) return t('batch.idle')
  const mapped = batchDetailKey(action, {
    serial: row.serial,
    ok: row.ok,
    ...(row.code === undefined ? {} : { code: row.code }),
    ...(row.detail === undefined ? {} : { detail: row.detail }),
    ...(row.truncated ? { truncated: true } : {}),
  })
  if (mapped === null) return t('batch.idle')
  return tf(mapped.key, mapped.params)
}

/** 表格的一行（勾选框 + 型号 + 状态 + Android + 电量 + 存储条 + 任务数）。 */
function DeviceRow(props: {
  device: DeviceSession
  checked: boolean
  taskCount: number
  onToggle: (serial: string) => void
}) {
  const { device, checked, taskCount, onToggle } = props
  const dot = statusDot({ status: device.status, transport: device.transport })
  const battery = batteryPercent(device.battery)
  const storage = storageView(device.storage)
  // 只有在线设备能参与批量：未授权/离线的勾选框禁用，避免用户勾了却一台也跑不了
  const selectable = device.status === 'device'

  return (
    <div className="flex items-center gap-2 border-b border-neutral-900 px-4 py-1 text-sm text-neutral-300">
      <input
        type="checkbox"
        checked={checked}
        disabled={!selectable}
        onChange={() => { onToggle(device.serial) }}
        className="h-3 w-3"
      />
      <span className="flex w-52 shrink-0 items-center gap-1.5 truncate">
        <span className={'h-2 w-2 shrink-0 rounded-full ' + DOT_CLASS[dot]} />
        <span className="truncate">{deviceLabel(device)}</span>
      </span>
      <span className="w-20 shrink-0 text-xs text-neutral-400">{t(DOT_LABEL_KEY[dot])}</span>
      <span className="w-24 shrink-0 text-xs text-neutral-400">
        {device.android === undefined ? t('batch.unknown') : 'Android ' + device.android}
      </span>
      {/* 电量：没有数据就显示 —（绝不编造 0%） */}
      <span className="w-16 shrink-0 text-xs text-neutral-400">
        {battery === null ? t('batch.unknown') : battery + '%'}
      </span>
      {/* 存储条：没有数据就只有占位符，不画一条假的 0% 进度条 */}
      <span className="flex w-44 shrink-0 items-center gap-1.5">
        {storage === null ? (
          <span className="text-xs text-neutral-600">{t('batch.unknown')}</span>
        ) : (
          <>
            <span className="h-1.5 w-24 overflow-hidden rounded bg-neutral-800">
              <span
                className="block h-full rounded bg-sky-500"
                style={{ width: storage.percent + '%' }}
              />
            </span>
            <span className="text-[11px] tabular-nums text-neutral-500">{storage.label}</span>
          </>
        )}
      </span>
      <span className="w-20 shrink-0 text-xs text-neutral-400">
        {taskCount === 0 ? t('batch.idle') : tf('batch.tasks', { count: taskCount })}
      </span>
    </div>
  )
}
