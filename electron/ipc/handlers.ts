import { z } from 'zod'
import type { DeviceManager } from '../devices/manager'
import type { ShellRunner } from '../fs/remote'
import { normalizeDir } from '../fs/remote'
import { E_BAD_ARGS, E_NO_SERIAL, E_ADB_NOT_FOUND, toErrorCode } from '../../src/shared/errors'
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

/** fs:list 的入参契约。 */
const fsListSchema = z.object({
  serial: z.string().min(1),
  dir: z.string().min(1),
})

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
    const parsed = fsListSchema.safeParse(payload)
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

  // 自检：注册表必须覆盖全部 invoke 通道，漏一个就是渲染层点了没反应
  for (const channel of INVOKE_CHANNELS) {
    if (!registered.has(channel)) throw new Error('missing handler: ' + channel)
  }
}
