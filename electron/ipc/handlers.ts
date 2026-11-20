import {
  BATCH_INSTALL_INPUT,
  BATCH_PUSH_INPUT,
  BATCH_SCREENSHOT_INPUT,
  BATCH_SHELL_INPUT,
  DRAG_OUT_INPUT,
  FS_BATCH_INPUT,
  FS_LIST_INPUT,
  FS_MKDIR_INPUT,
  FS_REMOVE_FACTS_INPUT,
  FS_RENAME_INPUT,
  LOCAL_LIST_INPUT,
  LOCAL_PICK_ROOT_INPUT,
  TRANSFER_CLEAR_INPUT,
  TRANSFER_ENQUEUE_INPUT,
  TRANSFER_ID_INPUT,
} from '../../src/shared/api-contract'
import type { BatchRunData } from '../../src/shared/batch'
import type { FsOpData, FsRemoveFactsData, LocalListData } from '../../src/shared/file-ops'
import type { DeviceManager } from '../devices/manager'
import type { ShellRunner } from '../fs/remote'
import { normalizeDir } from '../fs/remote'
import { E_BAD_ARGS, E_NO_SERIAL, E_ADB_NOT_FOUND, E_NOT_FOUND, toErrorCode } from '../../src/shared/errors'
import type { TransferSnapshot, TransferTask } from '../../src/shared/transfer'
import type {
  AdbState,
  DeviceSnapshot,
  FsListData,
  IpcResult,
} from '../../src/shared/types'
import { CH, INVOKE_CHANNELS } from './channels'

/**
 * IPC 通道注册（裁决 2）。
 *
 * 三条硬约束：
 * 1. 每个入参都过 zod；校验失败返回 { ok:false, error:'E_BAD_ARGS' }，绝不抛异常
 *    —— 异常穿过 ipcMain.handle 会被 Electron 包成 "Error invoking remote method"，
 *    渲染层拿不到结构化错误码，只能解析字符串，等于把错误处理外包给了错误消息格式。
 * 2. 主进程只信任自己掌握的会话表：fs:list 的 serial 必须是已连上的设备，
 *    绝不凭渲染层传什么就发命令。
 * 3. 业务错误同样收敛成 { ok:false, error:<code> }，渲染层永远只需处理一种形状。
 */

/** ipcMain 的最小契约（测试注入假实现，不必起 Electron）。 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void
}

export interface HandlerDeps {
  devices: DeviceManager
  /** 已解析出的 adb 绝对路径；空串表示还没定位到（或定位失败）。 */
  adbPath: () => string
  /** adb 自检状态（设备栏显示「无法使用 adb」）。 */
  adbState: () => AdbState
  /** 按 serial 造 client。 */
  clientFactory: (serial: string) => ShellRunner
  /**
   * 传输调度器。
   *
   * 只依赖【接口】而不是具体类：测试可以塞一个假调度器验证 IPC 层的
   * 校验 / 会话检查 / 错误码收敛，不必起真 adb。
   */
  transfer: TransferController
  /**
   * 打开系统文件选择框。
   *
   * 注入而不是在 handler 里直接 import electron 的 dialog：
   * tests/ipc-handlers.test.ts 在纯 node 下跑，import electron 会直接炸；
   * 而且「取消选择」与「选中若干文件」这两条路径都能被测到。
   */
  pickFiles: () => Promise<string[]>
  /** 文件操作服务（新建/重命名/删除/复制/移动）。 */
  ops: FileOpsController
  /** 本地目录访问（限制在用户选定的根目录内）。 */
  local: LocalController
  /** 让用户挑选本地根目录（系统目录选择框）；取消返回空串。 */
  pickRoot: () => Promise<string>
  /**
   * 批量动作服务（任务 10）。
   *
   * 与 ops / local 一样只依赖接口：IPC 层负责「校验 + 会话检查 + 错误码收敛」，
   * 四个动作各自的编排（离线跳过、参数预检、截图走队列）由 service 负责并有专门测试。
   */
  batch: BatchController
  /**
   * 拖拽（简报 C）。
   *
   * 只依赖接口：IPC 层负责「校验 + 会话检查 + 错误码收敛」，
   * 「下载到临时目录 → 等终态 → startDrag」的编排在 electron/drag/service.ts
   * 并有专门的行为测试。这样 IPC 测试不需要 Electron、也不需要真 adb。
   */
  drag: DragController
  /** 目录列举实现（默认 listDirDetailed；测试可注入）。 */
  fs: {
    list: (client: ShellRunner, adbPath: string, dir: string) => Promise<{
      entries: FsListData['entries']
      degraded: boolean
      unparsed: number
      usedFallback: boolean
      exitCode: number | null
      tzOffsetMinutes: number
    }>
  }
}

/**
 * 传输调度器对 IPC 层暴露的最小面（electron/transfer/manager 的 TransferManager 满足它）。
 *
 * enqueue 的路径参数是「渲染层给的原始意图」：
 *   push: src = 本地文件绝对路径，dstDir = 设备上的目标目录
 *   pull: src = 设备上的源文件路径，destDir = 本地目标目录
 * 由调度器负责拼出完整目标路径与取 totalBytes（裁决 5）。
 */
export interface TransferController {
  /**
   * 入队。**返回 Promise** —— 因为入队前要校验本地根目录（realpath 是 IO）。
   *
   * 复审 C1 之前这里是同步的，而「同步」正是当时没法做根目录判定的直接原因
   * （符号链接逃逸只有 realpath 能看出来）。IPC handler 本来就是 async，代价为零。
   */
  enqueue(input: {
    serial: string
    direction: 'push' | 'pull'
    src: string
    dstDir: string
  }): Promise<TransferTask>
  cancel(id: string): boolean
  retry(id: string): boolean
  get(id: string): TransferTask | undefined
  snapshot(): TransferSnapshot
  clearFinished(): number
}

/**
 * 文件操作对 IPC 层暴露的最小面（electron/fs/op-service 的 FsOpsService 满足它）。
 *
 * 只依赖接口而不是具体类：测试可以塞一个假实现验证
 * 「校验 / 会话检查 / 错误码收敛 / 逐项结果透传」，不必起真 adb。
 */
export interface FileOpsController {
  mkdir(serial: string, dir: string, name: string): Promise<{ ok: true } | { ok: false; code: string }>
  rename(serial: string, from: string, newName: string): Promise<{ ok: true } | { ok: false; code: string }>
  removeFacts(serial: string, targets: readonly string[]): Promise<FsRemoveFactsData>
  remove(serial: string, targets: readonly string[]): Promise<FsOpData>
  copy(serial: string, sources: readonly string[], dstDir: string | undefined): Promise<FsOpData>
  move(serial: string, sources: readonly string[], dstDir: string | undefined): Promise<FsOpData>
}

/** 本地目录访问的最小面（electron/fs/local 的 LocalFs 满足它）。 */
export interface LocalController {
  list(dir?: string): Promise<LocalListData>
}

/**
 * 批量动作对 IPC 层暴露的最小面（electron/batch/service 的 BatchService 满足它）。
 *
 * 六个方法 = 四个动作 + 两个选择框。选择框也在这一层，因为它们的**结果**
 * 只有批量动作会消费（截图目录 / apk 路径），拆成独立服务只是多一层转发。
 */
export interface BatchController {
  screenshot(input: { serials: readonly string[] }, dstDir: string): Promise<BatchRunData>
  install(input: { serials: readonly string[] }, apkPath: string): Promise<BatchRunData>
  push(input: { serials: readonly string[]; files: readonly string[]; dstDir: string }): Promise<BatchRunData>
  shell(input: { serials: readonly string[] }, command: string): Promise<BatchRunData>
  pickScreenshotDir(): Promise<string>
  pickApk(): Promise<string>
}

/**
 * 拖拽对 IPC 层暴露的最小面（electron/drag/service 的 DragOutService 满足它）。
 *
 * 与 transfer / ops / batch 同一原则：只依赖接口，测试塞假实现即可验证
 * 「校验/会话检查/错误码收敛」，不必启动 Electron。
 */
export interface DragController {
  dragOut(input: { serial: string; paths: string[] }): Promise<{ ok: true } | { ok: false; code: string }>
}

/** 统一的失败出口。 */
function fail(error: string): IpcResult<never> {
  return { ok: false, error }
}

/**
 * 注册全部 invoke 通道。
 * 重复注册会抛错 —— 两处 registerHandlers 互相覆盖时，后者的 handler 静默生效，
 * 而调用方毫无察觉，这是最难查的一类 IPC 故障。
 */
export function registerHandlers(deps: HandlerDeps, ipc: IpcMainLike): void {
  const registered = new Set<string>()
  const handle = (channel: string, listener: (event: unknown, payload?: unknown) => unknown): void => {
    if (registered.has(channel)) throw new Error('duplicate handler: ' + channel)
    registered.add(channel)
    ipc.handle(channel, listener)
  }

  handle(CH.DEVICES_LIST, (): IpcResult<DeviceSnapshot> => {
    // 设备表只认主进程掌握的会话表；渲染层传来的载荷一律忽略。
    return { ok: true, data: { devices: deps.devices.list(), adb: deps.adbState() } }
  })

  handle(CH.FS_LIST, async (_event, payload): Promise<IpcResult<FsListData>> => {
    // 入参 schema 来自 api-contract（与 preload / api.d.ts 同源，见 I4）
    const parsed = FS_LIST_INPUT.safeParse(payload)
    if (!parsed.success) return fail(E_BAD_ARGS)
    const { serial, dir } = parsed.data

    // serial 必须对应一台已建立的会话：渲染层不能凭字符串命令任意设备
    if (deps.devices.get(serial) === undefined) return fail(E_NO_SERIAL)

    const adbPath = deps.adbPath()
    if (adbPath === '') return fail(E_ADB_NOT_FOUND)

    // 路径先归一化：既拿到返回给渲染层的规范路径，也让非法字符在校验层就被拒，
    // 避免带着坏路径进到 adb 命令构造里再炸。
    let normalized: string
    try {
      normalized = normalizeDir(dir)
    } catch (err) {
      return fail(toErrorCode(err))
    }

    try {
      const result = await deps.fs.list(deps.clientFactory(serial), adbPath, normalized)
      return {
        ok: true,
        data: {
          serial,
          dir: normalized,
          entries: result.entries,
          degraded: result.degraded,
          unparsed: result.unparsed,
          usedFallback: result.usedFallback,
          exitCode: result.exitCode,
          tzOffsetMinutes: result.tzOffsetMinutes,
        },
      }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /* ============ 文件操作（任务 9） ============ */

  /**
   * 所有写操作通道共用的前置检查。
   *
   * 三条判据（与 fs:list 一致，且**必须**一致 —— 不一致就是一条能被绕过的旁路）：
   * 1. serial 必须是主进程掌握的会话，否则渲染层可以命令任意设备；
   * 2. adb 必须已定位，否则下游 spawn('') 会变成一个语焉不详的 E_SYNC_FAILED；
   * 3. 入参必须过 zod。
   *
   * 返回 Ok 时把 deps 里的 serial 收窄成分支，避免每个 handler 再写一遍。
   */
  /*
   * schema 的返回形状写成一个可判别联合（而不是 { success: boolean; data?: T }）：
   * 后者在 success 为真时 data 仍然是 T | undefined，收窄不过去，只能靠 as 硬转。
   * 联合写法与 zod 的 ZodSafeParseResult 同形（成功分支 data 必填），
   * 于是 if (!parsed.success) 之后 data 自然就是 T —— 类型是真收敛的，不是断言出来的。
   */
  type ParseResult<T> =
    | { success: true; data: T; error?: never }
    | { success: false; data?: never; error?: unknown }
  const preflight = <T>(payload: unknown, schema: { safeParse: (value: unknown) => ParseResult<T> }): { ok: true; data: T } | { ok: false; error: string } => {
    const parsed = schema.safeParse(payload)
    /*
     * 【问题 1 修复】这里只认 success，不再要求 data !== undefined。
     *
     * 修前是 !parsed.success || parsed.data === undefined：而 ipcRenderer.invoke(channel)
     * 不带载荷时 payload 就是 undefined，z.unknown().safeParse(undefined) 是 success=true、
     * data=undefined —— 于是「无载荷」这个【合法】形态被判成 E_BAD_ARGS，
     * 「更换目录」按钮稳定报「请求参数不合法」（真机实测复现）。
     *
     * 安全性没有因此降低：真正需要载荷的通道用的是 z.object(...)，缺字段时 success 为 false，
     * 仍然在这里被拒（tests/ipc-handlers.test.ts 有对照组：fs:list 不带载荷仍是 E_BAD_ARGS）。
     */
    if (!parsed.success) return { ok: false, error: E_BAD_ARGS }
    // zod 的成功分支里 data 一定存在（ZodSafeParseSuccess.data 是必填字段，没有 undefined 成员）——
    // 这里的收窄靠的是联合类型判别，不是 as。
    return { ok: true, data: parsed.data }
  }

  handle(CH.FS_MKDIR, async (_event, payload): Promise<IpcResult<FsOpData>> => {
    const parsed = preflight<{ serial: string; dir: string; name: string }>(payload, FS_MKDIR_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    const { serial, dir, name } = parsed.data
    if (deps.devices.get(serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)
    try {
      const result = await deps.ops.mkdir(serial, dir, name)
      // 单项目操作也统一成逐项结果：渲染层只需处理一种形状（裁决 4 的同一条原则）
      return {
        ok: true,
        data: { results: [result.ok ? { name, ok: true } : { name, ok: false, code: result.code }] },
      }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.FS_RENAME, async (_event, payload): Promise<IpcResult<FsOpData>> => {
    const parsed = preflight<{ serial: string; from: string; name: string }>(payload, FS_RENAME_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    const { serial, from, name } = parsed.data
    if (deps.devices.get(serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)
    try {
      const result = await deps.ops.rename(serial, from, name)
      return {
        ok: true,
        data: { results: [result.ok ? { name, ok: true } : { name, ok: false, code: result.code }] },
      }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.FS_REMOVE_FACTS, async (_event, payload): Promise<IpcResult<FsRemoveFactsData>> => {
    const parsed = preflight<{ serial: string; targets: string[] }>(payload, FS_REMOVE_FACTS_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    if (deps.devices.get(parsed.data.serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)
    try {
      return { ok: true, data: await deps.ops.removeFacts(parsed.data.serial, parsed.data.targets) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /**
   * 删除。
   *
   * 这个通道**不做二次确认** —— 确认是渲染层的职责（裁决 1 要求确认框列事实）。
   * 主进程侧的另一半防线是 fs/path-guard 的受保护路径：即使渲染层被绕过，
   * /sdcard、/storage/emulated/0 这类根路径依然删不掉。
   * 两层各自独立，不把安全押在单一层上。
   */
  handle(CH.FS_REMOVE, async (_event, payload): Promise<IpcResult<FsOpData>> => {
    const parsed = preflight<{ serial: string; targets: string[] }>(payload, FS_REMOVE_FACTS_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    if (deps.devices.get(parsed.data.serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)
    try {
      return { ok: true, data: await deps.ops.remove(parsed.data.serial, parsed.data.targets) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.FS_COPY, async (_event, payload): Promise<IpcResult<FsOpData>> => {
    const parsed = preflight<{ serial: string; sources: string[]; dstDir?: string }>(payload, FS_BATCH_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    if (deps.devices.get(parsed.data.serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)
    try {
      return { ok: true, data: await deps.ops.copy(parsed.data.serial, parsed.data.sources, parsed.data.dstDir) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.FS_MOVE, async (_event, payload): Promise<IpcResult<FsOpData>> => {
    const parsed = preflight<{ serial: string; sources: string[]; dstDir?: string }>(payload, FS_BATCH_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    if (deps.devices.get(parsed.data.serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)
    try {
      return { ok: true, data: await deps.ops.move(parsed.data.serial, parsed.data.sources, parsed.data.dstDir) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /* ============ 本地目录（任务 9 本地双栏，裁决 5） ============ */

  handle(CH.LOCAL_LIST, async (_event, payload): Promise<IpcResult<LocalListData>> => {
    const parsed = preflight<{ dir?: string }>(payload, LOCAL_LIST_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return { ok: true, data: await deps.local.list(parsed.data.dir) }
    } catch (err) {
      // 越界（E_OUTSIDE_ROOT）与不存在（E_NOT_FOUND）都必须如实传出去：
      // 前者是安全策略，后者是用户路径写错了，界面要给不同提示。
      return fail(toErrorCode(err))
    }
  })

  handle(CH.LOCAL_PICK_ROOT, async (_event, payload): Promise<IpcResult<string>> => {
    const parsed = preflight<unknown>(payload, LOCAL_PICK_ROOT_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      // 取消选择返回空串（不是错误）：与 transfer:pick-files 的「取消 = 空数组」一致
      return { ok: true, data: await deps.pickRoot() }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /* ============ 传输（任务 8） ============ */

  handle(CH.TRANSFER_ENQUEUE, async (_event, payload): Promise<IpcResult<TransferTask>> => {
    const parsed = TRANSFER_ENQUEUE_INPUT.safeParse(payload)
    if (!parsed.success) return fail(E_BAD_ARGS)
    const { serial, direction, src, dstDir } = parsed.data

    // serial 必须是已建立的会话（与 fs:list 同一条原则：主进程只信自己的会话表）
    if (deps.devices.get(serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)

    /*
     * 【审查 I3】必须包 try/catch。
     *
     * service.enqueue 会为真实场景抛错：本地文件不存在（statSync ENOENT）、
     * 是指向目录（E_NOT_A_DIRECTORY）、路径非法（E_INVALID_PATH）。
     * 修前这里直接 throw，穿过 ipcMain.handle 被 Electron 包成
     * "Error invoking remote method"，渲染层 store 只处理 result.ok === false，
     * 于是 await 直接抛、**界面没有任何提示**，只留下一个未捕获 Promise。
     *
     * 现在与 fs:list 一致：收敛成 { ok:false, error:<码> }。
     */
    try {
      const target = await deps.transfer.enqueue({ serial, direction, src, dstDir })
      return { ok: true, data: target }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.TRANSFER_CANCEL, (_event, payload): IpcResult<TransferTask> => {
    const parsed = TRANSFER_ID_INPUT.safeParse(payload)
    if (!parsed.success) return fail(E_BAD_ARGS)
    try {
      if (!deps.transfer.cancel(parsed.data.id)) return fail(E_NOT_FOUND)
    } catch (err) {
      return fail(toErrorCode(err))
    }
    const task = deps.transfer.get(parsed.data.id)
    if (task === undefined) return fail(E_NOT_FOUND)
    return { ok: true, data: task }
  })

  handle(CH.TRANSFER_RETRY, (_event, payload): IpcResult<TransferTask> => {
    const parsed = TRANSFER_ID_INPUT.safeParse(payload)
    if (!parsed.success) return fail(E_BAD_ARGS)
    if (!deps.transfer.retry(parsed.data.id)) return fail(E_BAD_ARGS)
    const task = deps.transfer.get(parsed.data.id)
    if (task === undefined) return fail(E_NOT_FOUND)
    return { ok: true, data: task }
  })

  handle(CH.TRANSFER_PICK_FILES, async (): Promise<IpcResult<string[]>> => {
    try {
      // 用户取消选择时返回空数组 —— 取消是正常操作，不是错误
      return { ok: true, data: await deps.pickFiles() }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /**
   * 拖出（简报 C）：设备文件 → 资源管理器。
   *
   * 与其它通道同一条前置链：zod → 会话检查 → adb 就绪。
   * 注意这里**没有**任何 dstDir：落点由主进程定在临时目录，
   * 渲染层不能指定本地写入位置（否则就绕开了本地根目录闸门）。
   *
   * 返回 { ok: true } 只在**startDrag 已经发出**之后成立；
   * 下载期间界面靠 transfer:drag-out-progress 显示「正在准备拖拽（N/M）」。
   */
  handle(CH.TRANSFER_BEGIN_DRAG_OUT, async (_event, payload): Promise<IpcResult<void>> => {
    const parsed = DRAG_OUT_INPUT.safeParse(payload)
    if (!parsed.success) return fail(E_BAD_ARGS)
    const { serial, paths } = parsed.data
    if (deps.devices.get(serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)
    try {
      const result = await deps.drag.dragOut({ serial, paths })
      if (!result.ok) return fail(result.code)
      return { ok: true, data: undefined }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.TRANSFER_LIST, (): IpcResult<TransferSnapshot> => {
    return { ok: true, data: deps.transfer.snapshot() }
  })

  handle(CH.TRANSFER_CLEAR, (_event, payload): IpcResult<TransferSnapshot> => {
    // 与其它通道一样「一律 zod 校验」，即使这个通道没有有意义的载荷
    const parsed = TRANSFER_CLEAR_INPUT.safeParse(payload)
    if (!parsed.success) return fail(E_BAD_ARGS)
    deps.transfer.clearFinished()
    return { ok: true, data: deps.transfer.snapshot() }
  })

  /* ============ 批量操作（任务 10） ============ */

  /*
   * 批量通道的公共前置：zod + 会话检查（R6）。
   *
   * 「每个 serial 都必须是主进程已知的会话」这条要在 handler 层判，
   * 而不是让 service 去猜：渲染层从未连接过的 serial 意味着它在问一个不存在的设备，
   * 整批 E_BAD_ARGS 比「N 台里有一台莫名失败」更能表达问题所在。
   *
   * 为什么允许列表中既有在线也有离线设备：离线设备由 service 按 R5 逐台跳过，
   * 那是**用户能看见并理解**的结果（「设备已断开」）；整批拒绝反而让在线的那些白勾了。
   */
  const batchPreflight = <T extends { serials: string[] }>(
    payload: unknown,
    schema: { safeParse: (value: unknown) => ParseResult<T> },
  ): { ok: true; data: T } | { ok: false; error: string } => {
    const parsed = preflight<T>(payload, schema)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    for (const serial of parsed.data.serials) {
      if (deps.devices.get(serial) === undefined) return { ok: false, error: E_BAD_ARGS }
    }
    if (deps.adbPath() === '') return { ok: false, error: E_ADB_NOT_FOUND }
    return { ok: true, data: parsed.data }
  }

  handle(CH.BATCH_SCREENSHOT, async (_event, payload): Promise<IpcResult<BatchRunData>> => {
    const parsed = batchPreflight<{ serials: string[]; dstDir: string }>(payload, BATCH_SCREENSHOT_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return {
        ok: true,
        data: await deps.batch.screenshot({ serials: parsed.data.serials }, parsed.data.dstDir),
      }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.BATCH_INSTALL, async (_event, payload): Promise<IpcResult<BatchRunData>> => {
    const parsed = batchPreflight<{ serials: string[]; apkPath: string }>(payload, BATCH_INSTALL_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return { ok: true, data: await deps.batch.install({ serials: parsed.data.serials }, parsed.data.apkPath) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.BATCH_PUSH, async (_event, payload): Promise<IpcResult<BatchRunData>> => {
    const parsed = batchPreflight<{ serials: string[]; files: string[]; dstDir: string }>(payload, BATCH_PUSH_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return {
        ok: true,
        data: await deps.batch.push({
          serials: parsed.data.serials,
          files: parsed.data.files,
          dstDir: parsed.data.dstDir,
        }),
      }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.BATCH_SHELL, async (_event, payload): Promise<IpcResult<BatchRunData>> => {
    const parsed = batchPreflight<{ serials: string[]; command: string }>(payload, BATCH_SHELL_INPUT)
    if (!parsed.ok) return fail(parsed.error)
    try {
      return { ok: true, data: await deps.batch.shell({ serials: parsed.data.serials }, parsed.data.command) }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  /*
   * 两个选择框。
   *
   * 取消返回**空串**（不是错误）—— 与 transfer:pick-files 的「取消 = 空数组」、
   * local:pick-root 的「取消 = 空串」保持同一约定。把取消当错误会让界面弹一条
   * 「请求参数不合法」，而用户只是按了 Esc。
   *
   * 这里不校验也有 no-device 的前置：选目录与选 apk 与设备无关，
   * 用户可以先选好文件再插设备。
   */
  handle(CH.BATCH_PICK_DIRECTORY, async (): Promise<IpcResult<string>> => {
    try {
      return { ok: true, data: await deps.batch.pickScreenshotDir() }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  handle(CH.BATCH_PICK_APK, async (): Promise<IpcResult<string>> => {
    try {
      return { ok: true, data: await deps.batch.pickApk() }
    } catch (err) {
      return fail(toErrorCode(err))
    }
  })

  // 自检：注册表必须覆盖全部 invoke 通道，漏一个就是渲染层点了没反应
  for (const channel of INVOKE_CHANNELS) {
    if (!registered.has(channel)) throw new Error('missing handler: ' + channel)
  }
}
