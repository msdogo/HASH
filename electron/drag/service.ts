import path from 'node:path'
import { mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { E_INVALID_PATH, E_NOT_A_DIRECTORY, E_SYNC_FAILED, toErrorCode } from '../../src/shared/errors'
import { isInsideRoot, isProtectedTransferPath, normalizeLocalPath } from '../../src/shared/path-guard'
import type { DragOutFailure, DragOutProgress, DragOutRequest } from '../../src/shared/drag'
import { E_PROTECTED_PATH } from '../../src/shared/errors'
import { assertSafeRemotePath } from '../../src/shared/path-guard'
import { DRAG_ICON_DATA_URL } from './icon'
import type { EnqueueIntent } from '../transfer/service'
import type { TransferTask } from '../../src/shared/transfer'
import { isTerminal } from '../../src/shared/transfer'

/**
 * 拖出（设备 → Windows 资源管理器）的主进程编排。
 *
 * ===== 唯一的物理约束（不是设计选择）=====
 * webContents.startDrag 要的是**本地磁盘上已存在的文件路径** ——
 * 资源管理器在拖放那一刻复制真实文件（OS 行为，Electron 只是转交）。
 * 所以「设备上的文件」必须先落到本地，才谈得上拖。
 *
 * ===== 用户确认的行为（写进代码而不是只写在文档里）=====
 * **不设文件大小门槛**：500 MB 也走同一条路 —— 先下载到临时目录，
 * 下载完成后才开始拖。因此拖大文件会有可感知的延迟，这是既定取舍，不是缺陷；
 * 界面上必须有「正在准备拖拽（N/M）」的提示（进度由本类推送），不能让用户以为卡死。
 *
 * ===== 为什么落点是临时目录而不是用户本地目录 =====
 * 拖拽的落点由用户松手的位置决定，但那要等 startDrag 之后才知道 ——
 * 我们只能先准备一份「待拖走」的文件。放进用户目录等于每次拖拽都在他的文件夹里
 * 留一份副本，而用户并不知道；临时目录是这条路径唯一诚实的落点。
 * 代价是必须保证它不越积越多：见 cleanup() 的两处调用点（下次拖拽前 + 进程退出）。
 */

/** 临时目录名（app.getPath('temp') 之下）。 */
export const DRAG_TEMP_DIR_NAME = 'adbfm-drag'

/** 拖拽服务依赖。 */
export interface DragOutDeps {
  /** 临时根目录（生产是 app.getPath('temp')）。getter：测试可换到 mkdtemp 目录。 */
  tempRoot: () => string
  /**
   * 当前的本地根目录 getter（与 TransferService 注入的**同一个**）。
   *
   * 拖拽的落点必须落在它之内 —— 不是因为「临时文件也该受管」，
   * 而是因为入队复用了既有传输服务，而 pull 的本地目标要过 checkLocalAccess。
   * 默认根是用户主目录，而 app.getPath('temp') 在 Windows 上就在主目录下，
   * 两者天然相容；但用户可以改根（改成 D:\Downloads 很常见），那之后
   * 系统临时目录就落在根外，pull 会被 E_OUTSIDE_ROOT 直接拒。
   * 所以这里要显式判断并给出确定的落点，而不是让功能在改了根之后莫名失效。
   */
  localRoot: () => string
  /** 入队（复用既有传输服务，不自己 spawn adb）。 */
  enqueue: (input: EnqueueIntent) => Promise<TransferTask>
  /** 取任务（轮询终态用）。 */
  getTask: (id: string) => TransferTask | undefined
  /** 等一个事件循环片（测试注入，避免真计时）。 */
  tick?: (ms: number) => Promise<void>
  /** 轮询间隔（毫秒）。 */
  pollMs?: number
  /** 进度事件出口（main.ts 转成 webContents.send）。 */
  emitProgress: (payload: DragOutProgress) => void
  /** 失败事件出口。 */
  emitFailed: (payload: DragOutFailure) => void
  /**
   * 真正发起 OS 拖拽（生产是 webContents.startDrag）。
   *
   * 注入而不是直接 import electron：本文件要能在纯 node 下被测
   * （tests/drag-out.test.ts 断言 startDrag 收到什么、被调用几次、失败时零调用）。
   */
  startDrag: (item: { file: string; files: string[]; icon: string }) => void
}

/** 拖拽服务对 IPC 层暴露的最小面。 */
export interface DragController {
  /** 拖出：下载到临时目录 → 全部成功后 startDrag。 */
  dragOut: (request: DragOutRequest) => Promise<{ ok: true } | { ok: false; code: string }>
  /** 清理临时目录（下次拖拽前 & 进程退出）。返回删掉的条目数。 */
  cleanup: () => number
}

/**
 * 规范化一个本地目录路径。
 *
 * 用 realpathSync.native（系统 API）而不是 node 的 JS 实现：
 * 只有它会把 Windows 的 8.3 短名展开成长名（见 tempDir 的注释 1）。
 * 路径还不存在时退回原值 —— 调用方（tempDir）随后会 mkdir，
 * 那之后再算一次就是规范路径了；这个函数绝不因为「路径暂不存在」而抛错。
 */
function canonicalize(target: string): string {
  try {
    return realpathSync.native(target)
  } catch {
    return target
  }
}

/** 默认 tick（生产环境真的要等一会儿）。 */
function defaultTick(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

export class DragOutService implements DragController {
  readonly controller: DragController = {
    dragOut: (request) => this.dragOut(request),
    cleanup: () => this.cleanup(),
  }

  constructor(private readonly deps: DragOutDeps) {}

  /**
   * 临时目录的绝对路径（每次现算：两个 getter 都可能变）。
   *
   * 两条规则，理由都是真机/真实路径踩出来的：
   *
   * 1. **先做 realpathSync.native 规范化**。
   *    Windows 的 TEMP 常常是 8.3 短名（C:\Users\ADMINI~1\AppData\Local\Temp），
   *    而 node 的 realpath（JS 实现）**不会**把它展开成长名 ——
   *    于是「短名的临时目录」和「长名的主目录」在词法比较里互不相认，
   *    本地根判定会把一个完全合法的落点判成 E_OUTSIDE_ROOT。
   *    只用 realpathSync.native：它走系统 API，8.3 短名会被展开成规范长名。
   *
   * 2. **必须落在当前本地根之内**。系统临时目录在根外时（用户把根改成别的盘），
   *    退回到 <根>/adbfm-drag —— 换的是位置，不是行为：它同样由 cleanup()
   *    在下次拖拽前与进程退出时删掉，用户不会因此多出一堆副本。
   *    反过来「硬用系统临时目录、让 pull 报 E_OUTSIDE_ROOT」才是真正的坏结果：
   *    用户只看到拖不动，且提示会引导他去改目录（而问题不在他选的目录上）。
   */
  tempDir(): string {
    /*
     * 落点一律取**规范形式**（realpathSync.native）。
     *
     * 为什么必须规范化：Windows 的 TEMP 常常是 8.3 短名
     * （C:\Users\ADMINI~1\AppData\Local\Temp），而本地根目录是长名
     * （C:\Users\Administrator）。两者作为字符串互不相认，于是
     *   - 词法包含判定会认为拖拽目录在根外；
     *   - 更实质的是 pull 入队时的 checkLocalAccess 也会这样判 ——
     *     结果是**每一次拖出都 E_OUTSIDE_ROOT**（真机用例第一次跑就是这么红的）。
     * node 的 realpath 是 JS 实现，**不会**展开 8.3 短名；只有
     * realpathSync.native 走系统 API 才会。所以这里用它，而不是随手 path.resolve。
     */
    const tempRoot = canonicalize(this.deps.tempRoot())
    const candidate = path.join(tempRoot, DRAG_TEMP_DIR_NAME)
    if (isInsideRoot(canonicalize(this.deps.localRoot()), candidate)) return candidate

    /*
     * 系统临时目录不在当前本地根之内（用户把根改到了别的盘，很常见）：
     * 退回到 <本地根>/adbfm-drag。
     *
     * 为什么不能硬用系统临时目录再让 pull 报 E_OUTSIDE_ROOT：
     * 用户看到的是「拖不动」，而提示会引导他去改目录 —— 但问题不在他选的目录上。
     * 换位置不换行为：这个目录同样由 cleanup() 在下次拖拽前与进程退出时删掉，
     * 用户不会因此多出一堆看不见的副本。
     *
     * 同样用规范形式：入队时的词法判定用的是 path.resolve 之后的路径，
     * 两边形态不一致就会绕回上面那个短名/长名的坑。
     */
    return path.join(canonicalize(this.deps.localRoot()), DRAG_TEMP_DIR_NAME)
  }

  /**
   * 清空临时目录。
   *
   * 两处调用（都是必须的）：
   *   1. **下一次拖拽之前**：上一次残留的文件用户已经拖走了（或者他放弃了），
   *      留着只会越积越多 —— 500 MB 一个文件的时代，一次残留就是一块盘；
   *   2. **进程退出时**（main.ts 的 before-quit）：兜住「拖完就退出」这条路径。
   *
   * 用 rmSync(recursive) 而不是逐个 unlink：目录里可能还有 .adbfm-part 残留
   * （下载失败时 runner 会清，但进程被杀时清不掉）。
   * 失败一律吞掉：清理是尽力而为的事，绝不能让它把拖拽本身弄失败。
   */
  cleanup(): number {
    const dir = this.tempDir()
    let removed = 0
    try {
      removed = readdirSync(dir).length
    } catch {
      return 0
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 文件被资源管理器占用（用户正在拖）时删不掉：下次再清，不影响本次
      return 0
    }
    return removed
  }

  /**
   * 拖出主流程。
   *
   * 步骤（顺序不能换）：
   *   1. 校验设备侧路径走统一远程闸门（与 pull 的入参同一条规则，绝不放松）；
   *   2. **清理上一次的临时目录**（在写新文件之前，否则会把自己刚下载的删掉）；
   *   3. 逐条入队 pull（dstDir = 临时目录）—— 复用既有传输队列：
   *      进度、取消、重试、掉线暂停全是它已经解决的问题；
   *   4. 等**所有**任务进终态（含排队中的，因为它们还没开始）；
   *   5. 全部成功才 startDrag；任一失败 push 事件并不拖。
   *
   * 第 4 步刻意用轮询而不是订阅事件：传输事件是广播（main.ts 的 emit），
   * 订阅它需要改动既有的 emit 契约；而任务的终态本来就在 manager 里可查，
   * 轮询 50ms 的成本与一次拖拽（至少几百毫秒）相比可以忽略。
   */
  async dragOut(request: DragOutRequest): Promise<{ ok: true } | { ok: false; code: string }> {
    const paths = request.paths
    if (paths.length === 0) return { ok: false, code: E_INVALID_PATH }

    // 1) 设备侧路径校验：与 pull 的入参同一条闸门（受保护路径不放行）
    const sources: string[] = []
    for (const raw of paths) {
      let safe: string
      try {
        safe = assertSafeRemotePath(raw)
      } catch (err) {
        return this.fail(paths.length, 0, toErrorCode(err))
      }
      if (isProtectedTransferPath(safe)) return this.fail(paths.length, 0, E_PROTECTED_PATH)
      sources.push(safe)
    }

    // 2) 清理上一次拖拽的残留（必须在入队之前）
    this.cleanup()

    const dir = this.tempDir()
    try {
      mkdirSync(dir, { recursive: true })
    } catch (err) {
      return this.fail(paths.length, 0, toErrorCode(err))
    }

    // 3) 入队（复用既有传输服务：跨端传输必须有进度与取消能力）
    const ids: string[] = []
    for (const src of sources) {
      try {
        const task = await this.deps.enqueue({
          serial: request.serial,
          direction: 'pull',
          src,
          dstDir: dir,
        })
        ids.push(task.id)
      } catch (err) {
        return this.fail(paths.length, ids.length, toErrorCode(err))
      }
    }

    // 4) 等所有任务进终态（慢任务在这里被测到：只测快路径等于没测时序）
    const settled = await this.waitAll(ids, dir, paths.length)
    if (settled.error !== undefined) return this.fail(paths.length, settled.done, settled.error)

    /*
     * 5) 全部成功 → 发起 OS 拖拽。
     *
     * 目标文件名必须与设备上的名字一致：用户在资源管理器里看到的就是这个名字。
     * 用任务里的 dst（服务解析过的绝对路径），不再自己拼一遍 ——
     * 拼错时 startDrag 只会静默不拖（OS 找不到文件），没有错误码可看。
     */
    const local: string[] = []
    for (const id of ids) {
      const task = this.deps.getTask(id)
      if (task === undefined || task.status !== 'done') {
        return this.fail(paths.length, settled.done, E_SYNC_FAILED)
      }
      local.push(task.dst)
    }
    const [first, ...rest] = local
    if (first === undefined) return this.fail(paths.length, settled.done, E_SYNC_FAILED)
    this.deps.startDrag({ file: first, files: local, icon: DRAG_ICON_DATA_URL })
    void rest
    this.deps.emitProgress({ total: paths.length, done: paths.length })
    return { ok: true }
  }

  /**
   * 等一批任务全部进终态。
   *
   * 每轮都推一次「正在准备拖拽（N/M）」：用户确认过不设大小门槛，
   * 500 MB 的下载可以跑几十秒，界面必须持续给数字，否则看起来就是卡死。
   */
  private async waitAll(
    ids: readonly string[],
    dir: string,
    total: number,
  ): Promise<{ done: number; error?: string }> {
    const tick = this.deps.tick ?? defaultTick
    const pollMs = this.deps.pollMs ?? 50
    let done = 0
    for (;;) {
      let allTerminal = true
      let failedCode: string | undefined
      done = 0
      for (const id of ids) {
        const task = this.deps.getTask(id)
        if (task === undefined) {
          // 任务被清掉（clearFinished）：当成失败，绝不拖一个可能不存在的文件
          return { done, error: E_SYNC_FAILED }
        }
        if (!isTerminal(task.status)) { allTerminal = false; continue }
        done += 1
        if (task.status !== 'done' && failedCode === undefined) {
          failedCode = task.error ?? E_SYNC_FAILED
        }
      }
      this.deps.emitProgress({ total, done })
      if (allTerminal) {
        if (failedCode !== undefined) return { done, error: failedCode }
        // 再确认落点文件真的在（资源管理器拖的那一刻才复制，但 startDrag 自己会检查）
        return { done, error: this.verifyLocal(ids, dir) }
      }
      await tick(pollMs)
    }
  }

  /**
   * 检查每个任务的落点都在临时目录里（防御：不受理挂到别处的路径）。
   *
   * 比较走 shared/path-guard 的 isInsideRoot，而不是 path.sep 拼前缀：
   * 归一化后的本地路径统一用正斜杠，而 Windows 的 path.sep 是反斜杠 ——
   * 混用会让合法路径被判成越界（第一版就是这么错的，被本文件的行为测试抓到）。
   * isInsideRoot 还顺带处理了「Windows 大小写不敏感」与「/home/me2 不是 /home/me 的子目录」。
   */
  private verifyLocal(ids: readonly string[], dir: string): string | undefined {
    const root = normalizeLocalPath(dir)
    for (const id of ids) {
      const task = this.deps.getTask(id)
      if (task === undefined) return E_SYNC_FAILED
      if (!isInsideRoot(root, task.dst)) return E_INVALID_PATH
      try {
        if (!statSync(task.dst).isFile()) return E_NOT_A_DIRECTORY
      } catch {
        return E_SYNC_FAILED
      }
    }
    return undefined
  }

  /** 统一失败出口：先推事件（渲染层立刻看到原因），再返回码。 */
  private fail(total: number, done: number, code: string): { ok: false; code: string } {
    this.deps.emitFailed({ total, done, error: code })
    return { ok: false, code }
  }
}
