import { describe, it, expect } from 'vitest'
import type { DshApi } from '../src/shared/api-contract'
// 只取类型：import type 会被完全擦除，测试运行时不会加载 electron。
import type { buildApi } from '../electron/preload'

/*
 * I3（审查轮 2 / 3）：契约的编译期守卫。
 *
 * ===== 历史（为什么这个文件长这样）=====
 * 轮 1：api.d.ts 自己写了一份 DshApi，与 preload 之间没有任何编译期约束 → 假护栏。
 * 轮 2：改用 `satisfies DshApi`，但仍然留了**正则匹配源码文本**的测试 → 复审证明
 *       注释里出现 `satisfies DshApi` 就能满足它，真的 satisfies 删掉后测试照样绿，
 *       「多实现」方向静默失守。
 * 轮 3（本文件当前形态）：**不再用任何正则匹配源码**。防护完全由编译期承担：
 *       electron/preload.ts 的 `export function buildApi(deps): DshApi`
 *       —— 返回类型标注同时挡住「多实现」（多余属性）与「少实现」（缺必填成员）。
 *
 * 因此本文件只保留**类型层**断言（编译不过就是失败，不依赖任何文本匹配）。
 * 「删掉防护后仍然报错」的证据来自变异验证，记录在 task-6-report.md。
 */

describe('I3 契约由编译期强制（本文件不做源码文本匹配）', () => {
  it('preload 的 buildApi 返回类型就是契约 DshApi（双向可赋值）', () => {
    type PreloadApi = ReturnType<typeof buildApi>
    // 若 buildApi 的返回类型被改成别的类型（或标注被删掉导致推成字面量类型），
    // 下面任一条会编译失败。
    type PreloadToContract = PreloadApi extends DshApi ? true : never
    type ContractToPreload = DshApi extends PreloadApi ? true : never
    const toContract: PreloadToContract = true
    const fromContract: ContractToPreload = true
    expect(toContract).toBe(true)
    expect(fromContract).toBe(true)
  })

  it('window.api 的类型就是 DshApi（不是它的宽松/子集版本）', () => {
    type WindowApi = Window['api']
    type ContractToWindow = DshApi extends WindowApi ? true : never
    type WindowToContract = WindowApi extends DshApi ? true : never
    const toWindow: ContractToWindow = true
    const toContract: WindowToContract = true
    expect(toWindow).toBe(true)
    expect(toContract).toBe(true)
  })

  it('契约的命名空间与方法集合（类型层，加错会编译失败）', () => {
    type SurfaceGroups = keyof DshApi
    const groups: SurfaceGroups[] = ['app', 'devices', 'fs']
    expect(groups).toHaveLength(3)

    type AppKeys = keyof DshApi['app']
    const appKeys: AppKeys[] = ['ping']
    expect(appKeys).toEqual(['ping'])

    type DeviceKeys = keyof DshApi['devices']
    const deviceKeys: DeviceKeys[] = ['list', 'onChanged']
    expect(deviceKeys).toHaveLength(2)

    type FsKeys = keyof DshApi['fs']
    const fsKeys: FsKeys[] = ['list']
    expect(fsKeys).toEqual(['list'])
  })
})
