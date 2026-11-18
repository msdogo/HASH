import type {
  AdbState,
  DeviceSession,
  DevicesChangedBatch,
  FileEntry,
  IpcResult,
} from './types'

/**
 * window.api 的完整类型声明（裁决 2）。
 *
 * 红线：preload 暴露的每个方法都必须在这里有声明，渲染层不得用宽类型绕过 ——
 * 任务 1 审查点名过这个风险：一旦有人用宽类型/绕过声明的方式糊过去，
 * 后面所有 IPC 的类型安全就一次性拆掉了。
 */

/** devices:list 的返回。 */
export interface DevicesListPayload {
  devices: DeviceSession[]
  adb: AdbState
}

/** fs:list 的返回（字段与 shared/types 的 FsListData 对齐）。 */
export interface FsListPayload {
  serial: string
  dir: string
  entries: FileEntry[]
  degraded: boolean
  unparsed: number
  usedFallback: boolean
  exitCode: number | null
  tzOffsetMinutes: number
}

export type Unsubscribe = () => void

export interface DshApi {
  app: {
    ping(): string
  }
  devices: {
    list(): Promise<IpcResult<DevicesListPayload>>
    onChanged(callback: (batch: DevicesChangedBatch) => void): Unsubscribe
  }
  fs: {
    list(payload: { serial: string; dir: string }): Promise<IpcResult<FsListPayload>>
  }
}

declare global {
  interface Window {
    api: DshApi
  }
}

export {}