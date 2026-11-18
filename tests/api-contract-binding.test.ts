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
 * 轮 3：**不再用任何正则匹配源码**，改用 `export function buildApi(deps): DshApi` 的返回类型标注。
 * 轮 4（本文件当前形态）：复审发现仅靠返回类型标注仍有一个漏洞 —— 把对象字面量
 *       先赋给中间变量再 return（极常见的重构）后，多余属性检查失效。
 *       现在 preload 里是 `return { ... } satisfies DshApi`（检查点落在字面量本身），
 *       与返回类型标注、本文件的 never 断言一起构成三层防护。
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

  /*
   * 【审查轮 4】这里原本还有一条「契约的命名空间与方法集合」用例。复审实测它的断言力接近零：
   *   type AppKeys = keyof DshApi['app']; const appKeys: AppKeys[] = ['ping']
   * 这只能证明「清单 ⊆ 契约」，是**单向**的；配合运行期断言硬编码长度，
   * 于是「契约新增了方法、清单没跟」这个方向完全抓不住（实测加一个一致性方法后全绿）。
   *
   * 已删除（采纳复审建议的 (b)）。理由：方法集合已经由 buildApi 的返回类型标注 +
   * 字面量 satisfies + 本文件的 never 断言三层覆盖，这条是冗余且更弱的。
   * 留一条更弱但看起来在守的测试，比没有更糟 —— 这正是本任务两轮来一直在清的东西。
   */
})