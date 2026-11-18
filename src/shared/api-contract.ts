import { z } from 'zod'

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

export type { DevicesListData, FsListData } from './types'

/* ============ API 面清单（preload 与 api.d.ts 的双向比对基准） ============ */

/** 每个命名空间下的方法名。preload 与 api.d.ts 都必须是它的超集/等价集。 */
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