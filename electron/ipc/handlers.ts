import {
  FS_LIST_INPUT,
  TRANSFER_CLEAR_INPUT,
  TRANSFER_ENQUEUE_INPUT,
  TRANSFER_ID_INPUT,
} from '../../src/shared/api-contract'
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
  enqueue(input: {
    serial: string
    direction: 'push' | 'pull'
    src: string
    dstDir: string
  }): TransferTask
  cancel(id: string): boolean
  retry(id: string): boolean
  get(id: string): TransferTask | undefined
  snapshot(): TransferSnapshot
  clearFinished(): number
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

  /* ============ 传输（任务 8） ============ */

  handle(CH.TRANSFER_ENQUEUE, async (_event, payload): Promise<IpcResult<TransferTask>> => {
    const parsed = TRANSFER_ENQUEUE_INPUT.safeParse(payload)
    if (!parsed.success) return fail(E_BAD_ARGS)
    const { serial, direction, src, dstDir } = parsed.data

    // serial 必须是已建立的会话（与 fs:list 同一条原则：主进程只信自己的会话表）
    if (deps.devices.get(serial) === undefined) return fail(E_NO_SERIAL)
    if (deps.adbPath() === '') return fail(E_ADB_NOT_FOUND)

    const target = deps.transfer.enqueue({ serial, direction, src, dstDir })
    return { ok: true, data: target }
  })

  handle(CH.TRANSFER_CANCEL, (_event, payload): IpcResult<TransferTask> => {
    const parsed = TRANSFER_ID_INPUT.safeParse(payload)
    if (!parsed.success) return fail(E_BAD_ARGS)
    if (!deps.transfer.cancel(parsed.data.id)) return fail(E_NOT_FOUND)
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

  // 自检：注册表必须覆盖全部 invoke 通道，漏一个就是渲染层点了没反应
  for (const channel of INVOKE_CHANNELS) {
    if (!registered.has(channel)) throw new Error('missing handler: ' + channel)
  }
}