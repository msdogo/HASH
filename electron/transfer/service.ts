import path from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import type { AdbClient } from '../adb/client'
import type { TransferTask } from '../../src/shared/transfer'
import {
  E_CROSS_DEVICE,
  E_DEVICE_OFFLINE,
  E_INVALID_PATH,
  E_NOT_A_DIRECTORY,
} from '../../src/shared/errors'
import { assertSafeRemotePath, isProtectedTransferPath, remoteJoin } from '../../src/shared/path-guard'
import { checkLocalAccess } from '../fs/local'
import { TransferManager, type TransferEvent } from './manager'
import { TransferRunner, type RunContext, type TransferRun } from './runner'

/**
 * 生产装配层：把「渲染层的意图」翻译成「完整的源/目标路径」，再交给调度器。
 *
 * 为什么要多这一层，而不是让 IPC handler 直接拼路径：
 *   1. 方向不同、路径语义完全相反（push 的 src 在本地、dst 在设备；pull 反过来），
 *      拼错了不会报错，只会往错误的位置传文件；把它收在一个地方才好测。
 *   2. **传输是整个应用里跨端写入口之一**（另一条是 fs:*），
 *      所以它和其他写路径一样必须过统一的路径闸门 ——
 *      复审 C1/C2 正是修前它一条都没过：pull 能写到用户根目录之外、
 *      push 能写进 /data（真机验证过）、pull 能拉走 /data 下任意 shell 可读文件。
 *   3. 总量探测（裁决 5）依赖 runner，而 runner 需要 adb client —— 都在这一层装配。
 */

/** 目录 + 文件名 → 完整路径（本地用 path.join，远程用正斜杠）。 */
export function fileNameOf(targetPath: string): string {
  // 远程路径一律正斜杠；本地路径在 Windows 上可能带反斜杠
  const normalized = targetPath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index < 0 ? normalized : normalized.slice(index + 1)
}

/** 名字是否可以作为「最后一段」（拒绝空、点、点点、含分隔符、首尾空白）。*/
export function assertPlainName(name: string): string {
  if (name === '' || name === '.' || name === '..') throw new Error(E_INVALID_PATH)
  if (name.includes('/') || name.includes('\\')) throw new Error(E_INVALID_PATH)
  if (name.trim() !== name) throw new Error(E_INVALID_PATH)
  return name
}

/**
 * 校验并拼出一个完整目标路径。
 *
 * **改用了 assertSafeRemotePath（严格语义），不再用 normalizeDir（容错归一化）。**
 *
 * 为什么必须换：normalizeDir 的职责是「用户想看某个目录」，所以点点会被折叠后放行；
 * 而这里是「要往设备上写一个文件」，/sdcard/../data/local/tmp 折叠成
 * /data/local/tmp 之后只和名字比，就绕过了受保护名单 —— 真机上确实写进去了。
 * 严格闸门对含点点的输入一律 E_PATH_UNSAFE，不留「归一化后看起来合法」的口子。
 */
export function resolveTargetPath(dir: string, name: string): string {
  assertPlainName(name)
  /*
   * 根目录是特例：assertSafeRemotePath('/') 会把根判成「不是可操作对象」，
   * 但「往根目录下放一个文件」（/a.bin）在语义上是合法的。
   * 所以根单独放行，后面对**拼出来的完整路径**再做严格校验 ——
   * 完整路径一定不是根，仍然会被闸门挡住 '/../x' 这类写法。
   */
  const safeDir = dir === '/' ? '/' : assertSafeRemotePath(dir)
  if (safeDir !== '/' && isProtectedTransferPath(safeDir)) throw new Error('E_PROTECTED_PATH')
  const target = assertSafeRemotePath(remoteJoin(safeDir, name))
  if (isProtectedTransferPath(target)) throw new Error('E_PROTECTED_PATH')
  return target
}

/**
 * 校验一条**设备上的源路径**（pull 的输入，C2）。
 *
 * pull 修前是**零校验**：src 原样塞进 adb pull。于是 /data/local/tmp/x
 * 这类 shell 可读的路径都能被拉走。这里统一过同一个闸门，并拒绝受保护根。
 */
export function assertRemoteSource(src: string): string {
  const safe = assertSafeRemotePath(src)
  if (isProtectedTransferPath(safe)) throw new Error('E_PROTECTED_PATH')
  // 源必须是具体文件：最后一段不能是 . / ..（否则拼出来的本地目标会跑偏）
  assertPlainName(fileNameOf(safe))
  return safe
}

/**
 * 【审查 I4】跨文件系统移动必须显式拒绝。
 *
 * toybox 的 mv 在跨 FS 时会退化成「逐文件复制 + 删除」：真机实测从
 * /data/local/tmp 移到 /sdcard/Download（源含一个不可读子目录）时，
 * mv 返回 1，**源里的 top.txt 已经消失**、目标侧留下半棵树 —— 这是唯一
 * 无法回滚的移动形态。拒绝它，让用户改走「复制到目标 + 确认后删除源」两步，
 * 那是可回滚的（复制失败时源完好；删除是用户显式确认的第二步）。
 *
 * 探测不到设备号时放行：取不到不构成本次操作的新风险，而把「探测失败」
 * 当成拒绝会让正常移动在网络抖动时莫名其妙失败。
 */
export async function assertSameDevice(
  deviceOf: (pathValue: string) => Promise<number | undefined>,
  from: string,
  to: string,
): Promise<void> {
  const [a, b] = await Promise.all([deviceOf(from), deviceOf(to)])
  if (a === undefined || b === undefined) return
  if (a !== b) throw new Error(E_CROSS_DEVICE)
}

/** 传输服务依赖。 */
export interface TransferServiceDeps {
  /** 当前 adb 路径；空串表示还没定位到。 */
  adbPath: () => string
  /** 按 serial 造 AdbClient。 */
  clientFor: (serial: string) => AdbClient
  /**
   * 当前本地根目录 getter（裁决 5 / 审查 C1）。
   *
   * **必须注入**：本地写入限制在用户选定的根目录内，而根目录会被用户在
   * 本地栏里改（不改的话就是家目录）。用 getter 而不是字符串，理由同 adbPath：
   * 构造时可能还没确定，改成常量会把旧值固化。
   */
  localRoot: () => string
  /** 事件出口（main.ts 里转成 webContents.send）。 */
  emit: (event: TransferEvent) => void
  /** 单设备 / 全局并发。 */
  maxPerDevice?: number
  maxGlobal?: number
  /**
   * 仅测试注入。
   *
   * 参数是 **getter** 而不是取好的字符串：这样才能测出「构造时未就绪、
   * 执行时就绪」这条生产路径（C1 的回归用例正是这么造的）。
   */
  runner?: (adbPath: () => string) => TransferRunner
}

/** 渲染层入队的意图（与 TransferController.enqueue 的入参同构）。 */
export interface EnqueueIntent {
  serial: string
  direction: 'push' | 'pull'
  src: string
  dstDir: string
}

export class TransferService {
  readonly manager: TransferManager
  private readonly runner: TransferRunner
  /**
   * 给 IPC 层用的控制器形状（enqueue 直接吃渲染层意图）。
   *
   * 与 manager 分开：manager.enqueue 吃的是「已解析好的完整 src/dst」，
   * 而渲染层只知道「用户选了哪个本地文件、当前在哪个目录」。
   * 让它俩用同一个签名，必然有一方要假装自己知道对方的事。
   *
   * enqueue 现在是 **async**：本地根目录判定要 realpath（拦符号链接逃逸），
   * 那是 IO，同步签名做不到。IPC handler 本来就是 async，代价为零。
   */
  readonly controller: {
    enqueue: (input: EnqueueIntent) => Promise<TransferTask>
    cancel: (id: string) => boolean
    retry: (id: string) => boolean
    get: (id: string) => TransferTask | undefined
    snapshot: () => ReturnType<TransferManager['snapshot']>
    clearFinished: () => number
  }

  constructor(private readonly deps: TransferServiceDeps) {
    /*
     * 【审查 C1】这里**不能**调 deps.adbPath() 把值取出来固化。
     *
     * 生产里 TransferService 是在 main.ts 模块顶层构造的，此刻 adb 自检还在
     * checking、getter 返回 ''。修前正是把 '' 存进了 runner，导致真实应用里
     * 每一次传输都 spawn('') 失败（E_SYNC_FAILED），而所有单测都注入了 runner
     * 或直连 createTransferRunner，恰好把这条路径全绕开了。
     *
     * 现在原样传 getter，由 runner 在每次执行时现取。
     */
    this.runner = deps.runner !== undefined
      ? deps.runner(deps.adbPath)
      : new TransferRunner({
          adbPath: deps.adbPath,
          clientFor: deps.clientFor,
        })

    this.manager = new TransferManager({
      maxPerDevice: deps.maxPerDevice,
      maxGlobal: deps.maxGlobal,
      emit: deps.emit,
      execute: (task, ctx) => this.execute(task, ctx),
      resolveTotalBytes: async (task) => {
        return this.runner.resolveTotalBytes(task.direction, task.src, task.serial)
      },
    })

    this.controller = {
      enqueue: (input) => this.enqueue(input),
      cancel: (id) => this.manager.cancel(id),
      retry: (id) => this.manager.retry(id),
      get: (id) => this.manager.get(id),
      snapshot: () => this.manager.snapshot(),
      clearFinished: () => this.manager.clearFinished(),
    }
  }

  /** 执行一个任务（调度器回调）。 */
  private async execute(
    task: TransferRun,
    ctx: RunContext,
  ): Promise<{ ok: true; bytes?: number; overwrote?: boolean } | { ok: false; code: string }> {
    return this.runner.run(task, ctx)
  }

  /**
   * 渲染层入队。
   *
   * push: src 是本地文件（必须存在、是普通文件、**在本地根目录内**），dstDir 是设备上的目录。
   * pull: src 是设备上的文件（**过统一远程闸门**），dstDir 是本地目录（**在根目录内**）。
   *
   * 四道闸门（修前一道都没有，除了「文件存不存在」）：
   *   1. push 的本地 src → checkLocalAccess（C1：读也限制在根内）；
   *   2. push 的远程 dst → assertSafeRemotePath + 受保护判定（C2）；
   *   3. pull 的远程 src → 同上（C2：修前零校验）；
   *   4. pull 的本地 dst → checkLocalAccess（C1：写必须留在根内）。
   *
   * 目标名一律过 assertPlainName：名字是点或点点时 path.join 会直接上跳一级，
   * 复审实测 pull 的 src 以点点结尾时目标真的跳到了 dstDir 的父目录。
   */
  async enqueue(input: EnqueueIntent): Promise<TransferTask> {
    const name = assertPlainName(fileNameOf(input.src))
    const root = this.deps.localRoot()

    if (input.direction === 'push') {
      // 1) 本地源：必须在根内（读权限同样受限，否则能把任意本地文件推到设备上）
      const localAccess = await checkLocalAccess(root, input.src)
      if (!localAccess.ok) throw new Error(localAccess.code)
      let info
      try {
        info = statSync(localAccess.path)
      } catch {
        throw new Error(E_INVALID_PATH)
      }
      if (!info.isFile()) throw new Error(E_NOT_A_DIRECTORY)
      // 2) 远程目标：严格闸门 + 受保护名单
      const dst = resolveTargetPath(input.dstDir, name)
      return this.manager.enqueue({
        serial: input.serial,
        direction: 'push',
        // 用 realpath 之后的路径：判定与执行必须是同一个路径，否则链接能在两步之间换目标
        src: localAccess.path,
        dst,
        // push 的总量用本地 stat（裁决 5：push 用本地）
        totalBytes: info.size,
      })
    }

    // 3) 远程源：严格闸门（修前原样塞给 adb pull）
    const remoteSrc = assertRemoteSource(input.src)

    // 4) 本地目标目录：必须在根内（C1 的核心 —— 写不能出根）
    const localAccess = await checkLocalAccess(root, input.dstDir)
    if (!localAccess.ok) throw new Error(localAccess.code)
    /*
     * 目标目录必须**已经存在**且是目录。
     *
     * 复审建议「根内中间目录不存在时仍放行」，这里**刻意不放行**并说明理由：
     * pull 的落盘要写到 <dir>/<name>.adbfm-part，父目录不存在时 adb pull 会失败，
     * 而失败发生在执行阶段、错误码是笼统的 E_SYNC_FAILED —— 用户看到的是
     * 「传输没有完成」而不是「这个目录不存在」。入队时就拒能让错误落在正确的位置。
     * 需要新建目录的场景由用户在本地栏先建目录（这是显式操作，不是隐藏副作用）。
     * 越界判定与这条正交：checkLocalAccess 已经把「根外 / .. 逃逸 / 链接逃逸」拦掉了。
     */
    let dirInfo
    try {
      dirInfo = statSync(localAccess.path)
    } catch {
      throw new Error(E_INVALID_PATH)
    }
    if (!dirInfo.isDirectory()) throw new Error(E_NOT_A_DIRECTORY)

    /*
     * 目标路径用 path.resolve 而不是裸 path.join。
     *
     * path.join(dir, name) 在 name 是点点时会静默上跳一级（复审实测的漏洞形态）；
     * 这里名字已经过 assertPlainName，但**多一道 resolve + 再判包含**的成本近乎为零，
     * 而它保证「最终落盘位置」本身也在根内 —— 判定用的路径与执行用的必须是同一个。
     */
    const dst = path.resolve(localAccess.path, name)
    if (dst === localAccess.path) throw new Error(E_INVALID_PATH)
    const dstAccess = await checkLocalAccess(root, dst)
    if (!dstAccess.ok) throw new Error(dstAccess.code)

    // pull 的总量由远程 stat 异步补（resolveTotalBytes 的 resolveTotal 钩子）
    return this.manager.enqueue({
      serial: input.serial,
      direction: 'pull',
      src: remoteSrc,
      dst: dstAccess.path,
      totalBytes: null,
    })
  }

  /**
   * 设备上下线（由 main.ts 的 tracker 推送调用，见 electron/app/transfer-wiring.ts）。
   *
   * 【审查 I1】这个方法在首版里没有任何生产调用方，导致「掉线暂停」只在测试里成立。
   * 现在 main.ts 的 onDevicesChanged 会做快照差分并调到这里。
   */
  setDeviceOnline(serial: string, online: boolean): void {
    this.manager.setDeviceOnline(serial, online)
  }

  /** 退出时收尾。 */
  dispose(): void {
    this.manager.dispose()
  }
}

/**
 * 本地目录里可以选来上传的文件（渲染层只给「用户选了哪些」，校验在这里做）。
 * 单独导出便于测试；空目录/不存在目录返回空数组而不是抛错 ——
 * 「没有可选文件」是正常的空状态，不是异常。
 */
export function listLocalFiles(dir: string): Array<{ name: string; path: string; size: number }> {
  try {
    const names = readdirSync(dir, { withFileTypes: true })
    const out: Array<{ name: string; path: string; size: number }> = []
    for (const entry of names) {
      if (!entry.isFile()) continue
      const full = path.join(dir, entry.name)
      try {
        out.push({ name: entry.name, path: full, size: statSync(full).size })
      } catch {
        // 单个文件 stat 失败不影响整批（权限/竞态）
      }
    }
    return out
  } catch {
    return []
  }
}

/** 供 main.ts 用的错误码小工具：把异常翻成已知错误码。 */
export function isOfflineCode(code: string): boolean {
  return code === E_DEVICE_OFFLINE
}
