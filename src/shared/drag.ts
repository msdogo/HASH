import { errorText, tf } from './i18n'
import { toErrorCode } from './errors'
import { joinEntryPath } from './file-view'
import type { FileEntry, IpcResult } from './types'
import type { TransferTask } from './transfer'

/**
 * 拖拽的【纯逻辑】（简报 C：设备 ↔ Windows 资源管理器）。
 *
 * 业务抽象就是用户的原话：**记录原始文件路径和目标路径，然后直接调用下载功能**。
 * 拖拽本身不做任何传输 —— 它只做两件事：
 *   1. 拖入：从 DataTransfer 的 File 拿到本地绝对路径，交给既有的 push 队列；
 *   2. 拖出：把设备上的路径交给既有的 pull 队列，落点由主进程定的临时目录。
 * 因此本文件里没有任何 adb / 文件系统访问：那些都在既有的传输层。
 *
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块。
 *
 * 为什么这些逻辑要放在 shared 而不是组件里：
 * 工程没有 jsdom（DOM 事件观测不到），组件里的判断一条都测不了。
 * 把「拿哪些路径 / 怎么入队 / 失败怎么算」收成纯函数，才能用行为断言压住
 * （tests/drag.test.ts / tests/drag-flow.test.ts）；组件只剩转发。
 */

/* ============ 拖出（设备 → 资源管理器）的 IPC 形状 ============ */

/**
 * 拖出请求。
 *
 * 只带 serial + 远程路径：**本地目标目录不来自渲染层** ——
 * 落点必须是主进程自己决定的临时目录（app.getPath('temp')/adbfm-drag），
 * 否则渲染层就能指定任意本地写入位置，绕开本地根目录闸门。
 */
export interface DragOutRequest {
  serial: string
  /** 设备上的源文件路径（1~100 条，上限见 api-contract 的 DRAG_OUT_INPUT）。 */
  paths: string[]
}

/**
 * 「正在准备拖拽（N/M）」的进度。
 *
 * 用户确认过：**不设文件大小门槛**，500 MB 也走同一条路 —— 先下载到临时目录，
 * 下载完成后才开始拖。所以拖大文件会有可感知的延迟，这是既定取舍而不是缺陷；
 * 界面上必须有这条明确的进度，不能让用户以为卡死。
 */
export interface DragOutProgress {
  /** 本次拖拽涉及的路径条数。 */
  total: number
  /** 已经进入终态（下载成功或失败）的条数。 */
  done: number
}

/** 拖出失败（任一文件失败就整体不拖，把原因推给渲染层）。 */
export interface DragOutFailure extends DragOutProgress {
  /** 错误码，渲染层用 errorText 翻成中文。 */
  error: string
}

/* ============ 拖入（资源管理器 → 设备） ============ */

/** 一次 drop 扫描出来的结果。 */
export interface DroppedScan {
  /** 可以在磁盘上找到的绝对路径（已去重，保持 drop 顺序）。 */
  paths: string[]
  /** getPathForFile 返回空串的个数：不是磁盘上的真实文件（例如网页里拖来的图片）。 */
  skipped: number
  /** 同一批里重复出现的路径个数（不重复入队，否则第二条会撞「目标已存在」）。 */
  duplicates: number
}

/**
 * 把 drop 进来的 File 列表转成磁盘路径。
 *
 * getPath 由调用方注入（生产是 preload 暴露的 webUtils.getPathForFile）：
 * 它是 Electron 唯一能拿到 File 真实路径的入口，而渲染层没有 node 能力。
 * **空串表示「这个 File 不是磁盘文件」** —— 必须跳过并计数，
 * 绝不能拿空串去入队（那会变成一条 src 为空的 push，用户看到「上传中」然后失败）。
 */
export function collectDroppedPaths(
  files: readonly unknown[],
  getPath: (file: unknown) => string,
): DroppedScan {
  const paths: string[] = []
  const seen = new Set<string>()
  let skipped = 0
  let duplicates = 0
  for (const file of files) {
    const path = getPath(file)
    if (path === '') {
      skipped += 1
      continue
    }
    if (seen.has(path)) {
      duplicates += 1
      continue
    }
    seen.add(path)
    paths.push(path)
  }
  return { paths, skipped, duplicates }
}

/** 拖入时交给传输队列的入参（与 TransferEnqueueInput 结构一致，direction 收窄成 push）。 */
export interface DropInEnqueueInput {
  serial: string
  direction: 'push'
  src: string
  dstDir: string
}

/** 拖入所需依赖（全部注入：组件只负责把 window.api 接进来）。 */
export interface DropInDeps {
  getPath: (file: unknown) => string
  enqueue: (input: DropInEnqueueInput) => Promise<IpcResult<TransferTask>>
}

/** 拖入的结果（界面据此给一句话，见 dropNotice）。 */
export interface DropInResult {
  queued: number
  skipped: number
  duplicates: number
  firstError: string | null
}

/**
 * 把一个 drop 里的文件逐项加入上传队列。
 *
 * 三条行为约束与既有的 runDownload 一致（同一类事故换来的）：
 * 1. **逐项收集，第一项失败不中断**：前面几项确实已经入队，
 *    直接 return 会让界面看起来像整批都没传；
 * 2. **空路径（不是磁盘文件）不入队**，只计数；
 * 3. **同一批去重**：同一个文件拖进来两次只入队一条。
 */
export async function enqueueDroppedFiles(
  deps: DropInDeps,
  serial: string,
  files: readonly unknown[],
  dstDir: string,
): Promise<DropInResult> {
  const scan = collectDroppedPaths(files, deps.getPath)
  let queued = 0
  let firstError: string | null = null
  for (const src of scan.paths) {
    let result: IpcResult<TransferTask>
    try {
      result = await deps.enqueue({ serial, direction: 'push', src, dstDir })
    } catch (err) {
      // 入队本身抛异常（极少见）：记成错误码，继续处理其余文件
      firstError ??= toErrorCode(err)
      continue
    }
    if (result.ok) queued += 1
    else firstError ??= result.error
  }
  return { queued, skipped: scan.skipped, duplicates: scan.duplicates, firstError }
}

/**
 * 拖入结果 → 一句用户能看懂的话（null 表示不需要提示）。
 *
 * 放在这里而不是组件里：组件的文案必须走 i18n（ui-contract 有静态断言），
 * 而「哪种组合该说什么」是可测的判断，属于纯逻辑。
 */
export function dropNotice(result: DropInResult): string | null {
  if (result.firstError !== null) return errorText(result.firstError)
  if (result.queued > 0 && result.skipped > 0) {
    return tf('files.dragQueuedSkipped', { queued: result.queued, skipped: result.skipped })
  }
  if (result.queued > 0) return tf('files.dragQueued', { count: result.queued })
  if (result.skipped > 0) return tf('files.dragSkipped', { count: result.skipped })
  return null
}

/* ============ 拖出时该拖哪些路径 ============ */

/** 一行上的拖拽该带走什么。 */
export interface DragOutTargets {
  /** 该行当时**没有**被选中：先把它选中（与资源管理器一致），再拖它自己。 */
  selectFirst: boolean
  /** 要拖出的设备路径（绝对路径）。 */
  paths: string[]
}

/**
 * 决定一次行拖拽的路径集合。
 *
 * 与资源管理器一致的两条规则（用户确认的行为）：
 * - 拖的是一行但它在选中集里 → 拖**整个选中集**（用户已经多选了）；
 * - 拖的行不在选中集里 → 先 replace 选中这一行，然后只拖它。
 * 反例（不选中就拖）会让用户以为拖走了 5 个文件，实际只拖走 1 个。
 */
export function dragOutTargets(
  entry: FileEntry,
  selected: readonly string[],
  cwd: string,
): DragOutTargets {
  if (selected.includes(entry.name)) {
    return { selectFirst: false, paths: selected.map((name) => joinEntryPath(cwd, name)) }
  }
  return { selectFirst: true, paths: [joinEntryPath(cwd, entry.name)] }
}

/* ============ DOM 事件 → 纯判断（组件只剩转发） ============ */

/** drop / dragover 事件里本模块用到的最小形状（便于在 node 里构造假事件）。 */
export interface DragEventLike {
  preventDefault: () => void
  dataTransfer: { files: ArrayLike<unknown> | null; dropEffect?: string } | null
}

/**
 * 拖入时 dragover 必须做的两件事。
 *
 * 为什么必须有 preventDefault：HTML5 拖放的默认行为是**拒绝** drop ——
 * 不 preventDefault 就永远收不到 drop 事件（这是最常见的「拖不进去」的原因）。
 * 另加 dropEffect='copy'：光标显示「复制」而不是「禁止」，否则用户会以为不能拖。
 *
 * 抽成纯函数是因为工程没有 jsdom，组件里的事件回调一行都测不了；
 * 至少让「这两件事做了没有」有行为断言（tests/drag.test.ts）。
 */
export function prepareDropTarget(event: DragEventLike): void {
  event.preventDefault()
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
}

/**
 * 从 drop 事件里取出 File 列表。
 *
 * 返回空数组而不是抛错：拖的不是文件（选中的文本、网页链接）时
 * 正确的反应是什么都不做，而不是给用户一个错误框。
 */
export function readDroppedFiles(event: DragEventLike): unknown[] {
  const files = event.dataTransfer?.files
  if (files === null || files === undefined) return []
  return Array.from(files)
}
