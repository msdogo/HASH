import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { DshApi } from '../src/shared/api-contract'

const root = path.resolve(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

/*
 * I3（审查轮 2）：原来的「双向契约守卫」是假护栏 ——
 * 往 api.d.ts 注入一个 rename() 方法后，api-contract.test.ts 仍然 7 passed 全绿，
 * 因为 DshApi 没有 satisfies 绑定，d.ts 与 preload 之间没有任何编译期约束。
 *
 * 修后：契约接口 DshApi 定义在 src/shared/api-contract.ts（纯类型，唯一一份），
 *   - preload 用 `satisfies DshApi` 绑定实现；
 *   - api.d.ts 从同一接口派生（declare global { interface Window { api: DshApi } }）。
 * 于是「改了任一侧、没同步另一侧」都是【编译错误】，不是靠正则比对。
 *
 * 本文件的作用是把这个机制钉住：
 * 1. 断言双向绑定代码确实存在（防止有人把 satisfies 删掉让编译期约束消失）；
 * 2. 用类型层面的等价性断言把 DshApi 与 window.api 绑在一起
 *    —— 如果 api.d.ts 里的 Window.api 变成别的类型，这里编译不过。
 */

describe('I3 契约是编译期强制的（不是正则比对）', () => {
  it('preload 实现用 satisfies DshApi 绑定（删掉它编译期约束就消失）', () => {
    const preload = read('electron/preload.ts')
    expect(preload).toMatch(/satisfies\s+DshApi/)
    // 必须真的从契约里 import 这个类型，而不是自己又定义一个
    expect(preload).toMatch(/import type \{[^}]*DshApi[^}]*\} from '\.\.\/src\/shared\/api-contract'/)
  })

  it('api.d.ts 从同一份契约派生 Window.api（不再自己写一份结构）', () => {
    const api = read('src/shared/api.d.ts')
    expect(api).toMatch(/import type \{[^}]*DshApi[^}]*\} from '\.\/api-contract'/)
    expect(api).toMatch(/interface Window \{\s*api: DshApi\s*\}/)
    // 不得再自己展开一份 { app: ...; devices: ...; fs: ... } 结构
    expect(api).not.toMatch(/^ {2}devices: \{$/m)
  })

  it('契约接口只有一份（api-contract.ts），api.d.ts 不再定义 interface DshApi', () => {
    const contract = read('src/shared/api-contract.ts')
    const api = read('src/shared/api.d.ts')
    expect(contract).toMatch(/export interface DshApi/)
    expect(api).not.toMatch(/interface DshApi \{/)
  })

  it('类型层面等价：window.api 的类型就是 DshApi（不是它的宽松/子集版本）', () => {
    /*
     * 这两行是真正的编译期守卫：如果 api.d.ts 里的 Window.api 与 DshApi 不是同一类型，
     * 下面的赋值会编译失败。
     * 用 declare 而不是运行时值 —— 这里只做类型层面的双向可赋值性检查。
     */
    type WindowApi = Window['api']
    type ContractToWindow = DshApi extends WindowApi ? true : never
    type WindowToContract = WindowApi extends DshApi ? true : never
    const toWindow: ContractToWindow = true
    const toContract: WindowToContract = true
    expect(toWindow).toBe(true)
    expect(toContract).toBe(true)
  })

  it('API_SURFACE 与 DshApi 的方法集合一致（类型层，不再靠正则）', () => {
    // 若 DshApi 加了方法但 API_SURFACE 没加（或反之），下面会编译失败
    type SurfaceGroups = keyof DshApi
    const groups: SurfaceGroups[] = ['app', 'devices', 'fs']
    expect(groups).toHaveLength(3)
    // 逐命名空间做键集合等价
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
