import type { DshApi } from './api-contract'

/**
 * window.api 的声明（裁决 2 / I3）。
 *
 * 【I3】这里**不再**自己定义接口结构，只把契约里的唯一接口 DshApi 挂到 window 上。
 * preload 用 `satisfies DshApi` 绑定实现，因此：
 *   - preload 加了方法、DshApi 没加 → preload 编译报错
 *   - DshApi 加了方法、preload 没实现 → preload 编译报错
 * 这两条都有测试做变异验证，不是靠正则比对。
 *
 * 载荷类型也不在这里重复定义：
 *   - DevicesListData / FsListData 来自 src/shared/types.ts
 *   - FsListInput 从 api-contract 的 zod schema 派生
 */

export type { DshApi }

declare global {
  interface Window {
    api: DshApi
  }
}
