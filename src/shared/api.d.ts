import type { DshApi } from './api-contract'

/**
 * window.api 的声明（裁决 2 / I3）。
 *
 * 【I3】这里**不再**自己定义接口结构，只把契约里的唯一接口 DshApi 挂到 window 上。
 *
 * preload 侧的实现与契约绑定方式是（审查轮 4 更正，此前写的是"靠 satisfies 绑定"）：
 *   `export function buildApi(deps): DshApi { return { ... } satisfies DshApi }`
 *   —— 返回类型标注 + 字面量上的 satisfies，两层都在编译期生效，不是靠正则比对。
 * 因此：
 *   - preload 加了方法、DshApi 没加 → preload 编译报错（多余属性）
 *   - DshApi 加了方法、preload 没实现 → preload 编译报错（缺必填成员）
 * 这两条都有变异验证记录在 task-6-report.md。
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