import { contextBridge, ipcRenderer } from 'electron'
import { CH } from './ipc/channels'
import type { AdbState, DeviceSession, DevicesChangedBatch, FsListData, IpcResult } from '../src/shared/types'

/** devices:list 的返回载荷（与 src/shared/api.d.ts 的 DevicesListPayload 同形）。 */
interface DevicesListPayload {
  devices: DeviceSession[]
  adb: AdbState
}

/**
 * 唯一 API 面（裁决 2）。
 *
 * 红线：这里暴露的每一个方法都必须在 src/shared/api.d.ts 里有对应声明 ——
 * tests/ui-contract.test.ts 用静态断言逐项比对，漏一个就红。
 * 渲染层没有任何 node 能力，一切都要经过这里。
 *
 * 通道名只允许引用 CH 常量（裸字符串等于绕过白名单）。
 */

type Unsubscribe = () => void

const api = {
  app: {
    /** 之前的 ping 保留，作为「桥是否活着」的探针。 */
    ping: (): string => 'pong',
  },
  devices: {
    /** 取设备表 + adb 自检状态。 */
    list: (): Promise<IpcResult<DevicesListPayload>> =>
      ipcRenderer.invoke(CH.DEVICES_LIST) as Promise<IpcResult<DevicesListPayload>>,
    /** 订阅设备变更推送；返回退订函数（组件卸载时必须调用）。 */
    onChanged: (callback: (batch: DevicesChangedBatch) => void): Unsubscribe => {
      const listener = (_event: unknown, batch: DevicesChangedBatch): void => { callback(batch) }
      ipcRenderer.on(CH.DEVICES_CHANGED, listener)
      return () => { ipcRenderer.off(CH.DEVICES_CHANGED, listener) }
    },
  },
  fs: {
    /** 列举远程目录（裁决 7：真实实现，带 degraded/exitCode）。 */
    list: (payload: { serial: string; dir: string }): Promise<IpcResult<FsListData>> =>
      ipcRenderer.invoke(CH.FS_LIST, payload) as Promise<IpcResult<FsListData>>,
  },
}

contextBridge.exposeInMainWorld('api', api)