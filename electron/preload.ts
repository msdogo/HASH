import { contextBridge, ipcRenderer } from 'electron'
import { CH } from './ipc/channels'
import type { DshApi, FsListInput } from '../src/shared/api-contract'
import type { DevicesChangedBatch, DevicesListData, FsListData, IpcResult } from '../src/shared/types'

/**
 * 唯一 API 面（裁决 2 / I3）。
 *
 * ===== 为什么用一个带显式返回类型标注的函数，而不是对象 + satisfies =====
 * 审查轮 3 发现：`satisfies DshApi` 这个语法可以被**替换掉**——把它换成 `const api: DshApi = {...}`
 * 是一个很自然的重构，而那样「多实现一个方法」就不再报错（对象字面量的多余属性检查只对
 * 直接标注的上下文生效，而这里经过了一次赋值）。更糟的是：原来那两条「钉住 satisfies」的
 * 测试是**用正则匹配源码文本**的，源码注释里出现 `satisfies DshApi` 字样就能满足它们 ——
 * 删掉真的 satisfies、留下注释，测试照样全绿。那和上一轮修掉的假护栏是同一类问题。
 *
 * 现在改为返回类型标注：
 *   - **多实现**：函数体返回对象字面量，返回类型写死 `DshApi`，多余属性是编译错误；
 *   - **少实现**：必填成员缺失是编译错误；
 *   - 两种方向都**不依赖任何可被注释满足的文本**，也不需要正则测试。
 *
 * 已知限制（如实记录）：方法参数的二变性使得「把形参改成更宽的对象类型」不会报错。
 * 彻底解决要用函数重载或精确类型，成本远超收益，故接受。
 */

/** preload 依赖的 Electron 面（注入以便脱离 Electron 单测）。 */
export interface PreloadDeps {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  /** 事件监听器：Electron 传的第一个参数是 IpcRendererEvent，其余是通道载荷。 */
  on: (channel: string, listener: (event: unknown, payload: DevicesChangedBatch) => void) => void
  off: (channel: string, listener: (event: unknown, payload: DevicesChangedBatch) => void) => void
}

/**
 * 造出 API 面。返回类型标注 + 字面量上的 satisfies 双保险，编译期强制，不靠测试。
 *
 * 为什么要【同时】写返回类型标注和 satisfies（审查轮 4 / A′）：
 *   多余属性检查只对「直接 return 的对象字面量」生效。若将来有人做一次极常见的重构
 *   ——把字面量先赋给中间变量再 return——仅靠返回类型标注就会**静默失守**：
 *   中间变量的推断类型保留那个多余属性，而它仍可赋值给 DshApi（多余属性不是错误），
 *   于是 tsc exit 0、never 断言也照样通过（因为 ReturnType 恒等于标注）。
 *   加上 satisfies 后，检查点落在**字面量本身**，提取中间变量也逃不掉。
 */
export function buildApi(deps: PreloadDeps): DshApi {
  return {
    app: {
      /** 之前的 ping 保留，作为「桥是否活着」的探针。 */
      ping: (): string => 'pong',
    },
    devices: {
      /** 取设备表 + adb 自检状态。 */
      list: (): Promise<IpcResult<DevicesListData>> =>
        deps.invoke(CH.DEVICES_LIST) as Promise<IpcResult<DevicesListData>>,
      /** 订阅设备变更推送；返回退订函数（组件卸载时必须调用）。 */
      onChanged: (callback: (batch: DevicesChangedBatch) => void): (() => void) => {
        const listener = (_event: unknown, batch: DevicesChangedBatch): void => { callback(batch) }
        deps.on(CH.DEVICES_CHANGED, listener)
        return () => { deps.off(CH.DEVICES_CHANGED, listener) }
      },
    },
    fs: {
      /** 列举远程目录（裁决 7：真实实现，带 degraded/exitCode）。 */
      list: (payload: FsListInput): Promise<IpcResult<FsListData>> =>
        deps.invoke(CH.FS_LIST, payload) as Promise<IpcResult<FsListData>>,
    },
  } satisfies DshApi
}

// 渲染层没有任何 node 能力，一切都要经过这里。
// 通道名只允许引用 CH 常量（裸字符串等于绕过白名单）。
const api = buildApi({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => { ipcRenderer.on(channel, listener) },
  off: (channel, listener) => { ipcRenderer.off(channel, listener) },
})

contextBridge.exposeInMainWorld('api', api)