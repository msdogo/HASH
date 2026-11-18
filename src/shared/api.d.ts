import type { DevicesListData, DevicesChangedBatch, FsListData, IpcResult } from './types'
import type { FsListInput } from './api-contract'

/**
 * window.api 的完整类型声明（裁决 2 / I3、I4）。
 *
 * 红线：preload 暴露的每个方法都必须在这里有声明，渲染层不得用宽类型绕过 ——
 * 任务 1 审查点名过这个风险：一旦有人用宽类型绕过，后面所有 IPC 的类型安全就一次性拆掉了。
 *
 * 【I4】载荷类型不再在这里重复定义：
 * - `DevicesListData` / `FsListData` 直接来自 src/shared/types.ts；
 * - `FsListInput` 从 src/shared/api-contract.ts 的 zod schema 派生。
 * preload 也 import 同一批类型，因此「三份副本」收敛成「一份类型 + 一个 schema」。
 * 方法名集合由 tests/api-contract.test.ts 与 API_SURFACE 双向比对。
 */

export type Unsubscribe = () => void

export interface DshApi {
  app: {
    ping(): string
  }
  devices: {
    /** 取设备表 + adb 自检状态。 */
    list(): Promise<IpcResult<DevicesListData>>
    /** 订阅设备变更推送；返回退订函数。批次必然携带 adb 状态（I8）。 */
    onChanged(callback: (batch: DevicesChangedBatch) => void): Unsubscribe
  }
  fs: {
    /** 列举远程目录；入参类型从 api-contract 的 zod schema 派生。 */
    list(payload: FsListInput): Promise<IpcResult<FsListData>>
  }
}
declare global {
  interface Window {
    api: DshApi
  }
}
