import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  API_SURFACE,
  FS_LIST_INPUT,
  DEVICES_LIST_INPUT,
  apiGroupNames,
  apiMethodNames,
} from '../src/shared/api-contract'

const root = path.resolve(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

/*
 * I3 / I4（审查轮 1）：契约守卫单向 + 类型事实源三份副本。
 *
 * 修前：preload 自写一份 DevicesListPayload，api.d.ts 又写一份，两者靠人肉同步；
 * ui-contract 只从 preload 往 api.d.ts 单向比对，改了 api.d.ts 不会红。
 *
 * 修后：src/shared/api-contract.ts 是唯一事实源（含 zod 入参 schema 与 API 面清单），
 * preload 与 api.d.ts 都从它派生。测试做双向比对。
 */

describe('I4 API 契约单一事实源', () => {
  /*
   * 【审查轮 2 / I3、N1】这里原来有两条「正则比对 preload 与 api.d.ts 方法名」的用例。
   * 复审实测它们抓不住任何东西：往 api.d.ts 注入一个 rename() 方法后，本文件仍然全绿。
   * 也就是说它们是**假护栏**，而假护栏比没有更危险（后续任务会以为有保护）。
   *
   * 已删除，替换为真正的编译期守卫：
   *   - electron/preload.ts 用 `satisfies DshApi` 绑定实现；
   *   - src/shared/api.d.ts 只写 `interface Window { api: DshApi }`；
   *   - tests/api-contract-binding.test.ts 断言这两个绑定存在，并做类型层等价检查。
   * 改任一侧不同步另一侧 = tsc 报错（已做变异验证，见 task-6-report.md）。
   */



  it('api.d.ts 不再重复定义载荷类型（消除第三份副本）', () => {
    const api = read('src/shared/api.d.ts')
    // 修前这里有一个 interface DevicesListPayload { devices; adb }，与 shared/types 重复
    expect(api).not.toMatch(/interface DevicesListPayload/)
    expect(api).not.toMatch(/interface FsListPayload/)
    expect(api).toContain('DevicesListData')
    expect(api).toContain('FsListData')
  })

  it('preload 不再自写载荷类型（消除第二份副本）', () => {
    const preload = read('electron/preload.ts')
    expect(preload).not.toMatch(/interface DevicesListPayload/)
    expect(preload).toContain('api-contract')
  })

  it('fs:list 入参 schema 校验 serial 与 dir，非法输入被拒', () => {
    expect(FS_LIST_INPUT.safeParse({ serial: 'S', dir: '/sdcard' }).success).toBe(true)
    expect(FS_LIST_INPUT.safeParse({ serial: '', dir: '/sdcard' }).success).toBe(false)
    expect(FS_LIST_INPUT.safeParse({ serial: 'S', dir: '' }).success).toBe(false)
    expect(FS_LIST_INPUT.safeParse({ serial: 1, dir: '/sdcard' }).success).toBe(false)
    expect(FS_LIST_INPUT.safeParse(null).success).toBe(false)
    expect(FS_LIST_INPUT.safeParse('x').success).toBe(false)
  })

  it('devices:list 入参 schema 不接受任何载荷（忽略渲染层传入的内容）', () => {
    expect(DEVICES_LIST_INPUT.safeParse(undefined).success).toBe(true)
    expect(DEVICES_LIST_INPUT.safeParse({ devices: [] }).success).toBe(true)
    // 严格模式：多传字段也不影响（handler 只用自己的会话表），但 schema 本身要能解析任意输入不抛错
    expect(() => DEVICES_LIST_INPUT.safeParse({ evil: 1 })).not.toThrow()
  })

  it('handler 引用契约里的 schema（不再自己手写 zod）', () => {
    const handlers = read('electron/ipc/handlers.ts')
    expect(handlers).toContain('api-contract')
    expect(handlers).toContain('FS_LIST_INPUT')
    expect(handlers).not.toMatch(/z\.object\(\{\s*serial: z\.string/)
  })
})