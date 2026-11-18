import { contextBridge, ipcRenderer } from 'electron'
import { CH } from './ipc/channels'
import type { DshApi, FsListInput } from '../src/shared/api-contract'
import type { DevicesChangedBatch, DevicesListData, FsListData, IpcResult } from '../src/shared/types'

/**
 * 唯一 API 面（裁决 2 / I3）。
 *
 * 红线：这里的实现必须与契约接口 DshApi **完全一致** —— 靠 `satisfies DshApi` 在
 * **编译期**强制，而不是靠测试里的正则比对。少实现一个方法、多实现一个方法、
 * 参数类型写错，都是 tsc 报错。
 *
 * 渲染层没有任何 node 能力，一切都要经过这里。
 * 通道名只允许引用 CH 常量（裸字符串等于绕过白名单）。
 */

const implementation = {
  app: {
    /** 之前的 ping 保留，作为「桥是否活着」的探针。 */
    ping: (): string => 'pong',
  },
  devices: {
    /** 取设备表 + adb 自检状态。 */
    list: (): Promise<IpcResult<DevicesListData>> =>
      ipcRenderer.invoke(CH.DEVICES_LIST) as Promise<IpcResult<DevicesListData>>,
    /** 订阅设备变更推送；返回退订函数（组件卸载时必须调用）。 */
    onChanged: (callback: (batch: DevicesChangedBatch) => void): (() => void) => {
      const listener = (_event: unknown, batch: DevicesChangedBatch): void => { callback(batch) }
      ipcRenderer.on(CH.DEVICES_CHANGED, listener)
      return () => { ipcRenderer.off(CH.DEVICES_CHANGED, listener) }
    },
  },
  fs: {
    /** 列举远程目录（裁决 7：真实实现，带 degraded/exitCode）。 */
    list: (payload: FsListInput): Promise<IpcResult<FsListData>> =>
      ipcRenderer.invoke(CH.FS_LIST, payload) as Promise<IpcResult<FsListData>>,
  },
} satisfies DshApi

// satisfies 之后再断言一次给 exposeInMainWorld：它接受 unknown，
// 但显式标注能让「这里传出去的就是 DshApi」在代码里可见。
const api: DshApi = implementation

contextBridge.exposeInMainWorld('api', api)