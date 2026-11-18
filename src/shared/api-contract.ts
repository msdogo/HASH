import { z } from 'zod'
import type { DevicesChangedBatch, DevicesListData, FsListData, IpcResult } from './types'

/**
 * IPC API 契约的【单一事实源】（审查轮 1 / I3、I4）。
 *
 * 修前的问题：同一份 API 形状有三处副本 ——
 *   1. electron/preload.ts 里自写的 `interface DevicesListPayload`
 *   2. src/shared/api.d.ts 里再写一份 `DevicesListPayload` / `FsListPayload`
 *   3. electron/ipc/handlers.ts 里手写的 zod schema
 * 三份靠人肉同步，守卫还是单向的（只从 preload 往 api.d.ts 比）。
 *
 * 修后：本文件是唯一事实源，包含
 *   - 入参的 zod schema（handlers 直接复用，不再各写一份）
 *   - 出参的类型（从 shared/types 派生，不重新定义）
 *   - API 面清单（preload 与 api.d.ts 都据此派生，测试做双向比对）
 *
 * 红线：本文件同时被渲染层与主进程编译。zod 是纯 JS 依赖（无 node 内置模块），
 * 渲染层可以安全 import。
 */

/* ============ 入参 schema（唯一副本） ============ */

/** fs:list 入参。 */
export const FS_LIST_INPUT = z.object({
  serial: z.string().min(1),
  dir: z.string().min(1),
})

/** fs:list 入参的类型（从 schema 派生，永远与校验一致）。 */
export type FsListInput = z.infer<typeof FS_LIST_INPUT>

/**
 * devices:list 入参。
 *
 * 它不接收任何有意义的载荷（handler 只用自己的会话表），但仍然写成 schema：
 * 一是「所有 IPC 入参一律 zod 校验」这条契约不能有例外，
 * 二是显式记录「这个通道会忽略载荷」——用 unknown() 而不是 z.undefined()，
 * 这样任何输入都能被安全解析、不会因为渲染层多传字段就报 E_BAD_ARGS。
 */
export const DEVICES_LIST_INPUT = z.unknown()

/* ============ 出参类型（从 shared/types 派生，不重复定义） ============ */

export type { DevicesChangedBatch, DevicesListData, FsListData, IpcResult } from './types'

/* ============ 唯一 API 接口（I3：编译期强制的唯一事实源） ============ */

/** 退订函数。 */
export type Unsubscribe = () => void

/**
 * window.api 的**唯一**接口定义（审查轮 2 / I3）。
 *
 * 为什么必须放在这里：原来的实现里 api.d.ts 自己写了一份 DshApi，
 * 与 preload 的实现之间【没有任何编译期约束】—— 往 d.ts 里注入一个 rename() 方法，
 * 测试照样全绿。那比不修更危险：后续任务会以为有护栏而大胆加 API。
 *
 * 现在两侧都绑到这一个接口，防护是三层（审查轮 4 更正：此前这里写的是"靠 satisfies 绑定"，
 * 那是轮 3 之前的机制，已经不准确了）：
 *   1. electron/preload.ts 的返回类型标注 `function buildApi(deps): DshApi`
 *      → 挡住「少实现」（缺必填成员）；
 *   2. 同一函数里 `return { ... } satisfies DshApi` → 检查点落在**字面量本身**，
 *      挡住「多实现」（多余属性），并且即使将来把字面量提取成中间变量也仍然生效；
 *   3. tests/api-contract-binding.test.ts 的 never 断言 → 把「标注 ≡ 契约」也钉住。
 *   - src/shared/api.d.ts：`interface Window { api: DshApi }` ← 声明与实现同源
 * 于是「改一侧不同步另一侧」是**编译错误**，不再依赖正则比对。
 *
 * 已知限制：方法参数的二变性意味着「形参改成更宽的结构兼容类型」不会报错，
 * 参数签名的精确一致性仍需人工核对。
 */
export interface DshApi {
  app: {
    /** 桥是否活着。 */
    ping(): string
  }
  devices: {
    /** 取设备表 + adb 自检状态（含首屏与迟到订阅者的自愈入口）。 */
    list(): Promise<IpcResult<DevicesListData>>
    /** 订阅设备变更推送；返回退订函数。批次必然携带 adb 状态（I8）。 */
    onChanged(callback: (batch: DevicesChangedBatch) => void): Unsubscribe
  }
  fs: {
    /** 列举远程目录；入参类型从 FsListInput（zod schema 派生）来。 */
    list(payload: FsListInput): Promise<IpcResult<FsListData>>
  }
}

/* ============ API 面清单（运行期反射用；类型层的等价性由 DshApi 保证） ============ */

/**
 * 每个命名空间下的方法名。
 *
 * 注意：这里只是给「运行期静态检查 / 文档」用的便利清单，
 * **真正的守卫是 DshApi 接口 + satisfies**（tests/api-contract-binding.test.ts 会断言这一点）。
 * 若两者不一致，tests 里对 DshApi 键集合的类型断言会编译失败。
 */
export const API_SURFACE = {
  app: ['ping'],
  devices: ['list', 'onChanged'],
  fs: ['list'],
} as const

export type ApiSurface = typeof API_SURFACE

/** 拍平后的方法名列表（'app.ping', 'devices.list', ...）。 */
export function apiMethodNames(): string[] {
  const out: string[] = []
  for (const [group, methods] of Object.entries(API_SURFACE)) {
    for (const method of methods) out.push(group + '.' + method)
  }
  return out
}

/** 命名空间名列表。 */
export function apiGroupNames(): string[] {
  return Object.keys(API_SURFACE)
}