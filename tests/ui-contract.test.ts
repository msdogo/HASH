import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/*
 * 裁决 8：本任务不为 React 组件写单元测试（测试工程 import 不了 src/ 下非 shared 的目录，
 * 装 jsdom 会破坏 tsconfig 的工程划分）。组件本身靠手工验证（见 task-6-report.md）。
 *
 * 这里只做一件低成本、高价值的事：用【源码静态断言】锁住「组件里不写死文案、不用 as any、
 * 不 import node 模块、只走 window.api 类型面」这几条契约 —— 它们没法靠纯函数测试覆盖，
 * 但正是任务 1 审查点名过、也最容易在后续任务里被悄悄破坏的地方。
 */

const root = path.resolve(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

/** 递归收集 .ts/.tsx 源文件（跳过 node_modules 与测试自身）。 */
function collectSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(path.join(root, dir))) {
    const rel = dir + '/' + entry
    const stat = statSync(path.join(root, rel))
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue
      out.push(...collectSources(rel))
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(rel)
    }
  }
  return out
}

describe('渲染层契约（静态断言）', () => {
  it('组件与 store 不 import 任何 node 内置模块', () => {
    for (const rel of ['src/components/DeviceRail.tsx', 'src/store/deviceStore.ts', 'src/App.tsx']) {
      const source = read(rel)
      expect(source, rel).not.toMatch(/from ['"]node:/)
      expect(source, rel).not.toMatch(/require\(/)
      expect(source, rel).not.toMatch(/from ['"]electron['"]/)
    }
  })

  it('全仓无 as any / @ts-ignore / @ts-expect-error', () => {
    // 直接扫源码树：新加的文件自动纳入，不会因为忘改清单而漏检。
    const files = [...collectSources('electron'), ...collectSources('src')]
    expect(files.length).toBeGreaterThan(10)
    for (const rel of files) {
      const source = read(rel)
      expect(source, rel).not.toMatch(/\bas\s+any\b/)
      expect(source, rel).not.toMatch(/@ts-ignore/)
      expect(source, rel).not.toMatch(/@ts-expect-error/)
    }
  })

  /*
   * 【审查轮 3】这里原本还有一条「preload 用 satisfies DshApi 绑定」的正则断言。
   * 复审证明它**能被注释满足**：源码注释里出现 satisfies DshApi 字样就够了，
   * 把真正的绑定删掉后测试仍然绿 —— 与上一轮修掉的假护栏同类，只是伪装更好。
   *
   * 已删除。防护不再依赖任何源码文本匹配：
   *   - electron/preload.ts 的 `buildApi(deps): DshApi` 返回类型标注 +
   *     函数体内 `return { ... } satisfies DshApi`（审查轮 4 补的兜底），
   *     两者一起在编译期挡住「少实现」（缺必填成员）与「多实现」（多余属性）；
   *   - src/shared/api.d.ts 只写 `interface Window { api: DshApi }`；
   *   - tests/api-contract-binding.test.ts 只做类型层等价断言（无正则）。
   * 变异验证记录在 task-6-report.md。
   */

  it('preload 通过 ipcRenderer.invoke 只调用白名单通道', () => {
    const source = read('electron/preload.ts')
    const used = [...source.matchAll(/invoke\((CH\.[A-Z_]+)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(0)
    const channels = read('electron/ipc/channels.ts')
    for (const ref of used) expect(channels, ref).toContain(ref.replace('CH.', '') + ':')
    // 不允许裸通道字符串（绕过 CH 常量就等于绕过白名单）
    expect(source).not.toMatch(/invoke\(['"]/)
  })

  it('DeviceRail 的文案全部走 i18n，不硬编码中文', () => {
    const source = read('src/components/DeviceRail.tsx')
    // JSX 文本节点与字符串字面量里不得出现汉字（注释除外：先剥掉注释再判）
    const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const hanInCode = /['"`>][^'"`<]*[\u4e00-\u9fff][^'"`<]*['"`<]/.test(noComments)
    expect(hanInCode).toBe(false)
  })

  it('DeviceRail 只通过 store / window.api 拿数据（不直接 import electron）', () => {
    // 组件本身走 store；window.api 只在 deviceStore 里出现（下面单独断言）。
    const rail = read('src/components/DeviceRail.tsx')
    expect(rail).toContain('useDeviceStore')
    expect(rail).not.toMatch(/from ['"]electron['"]/)
    expect(rail).not.toMatch(/ipcRenderer/)
    const store = read('src/store/deviceStore.ts')
    expect(store).toContain('window.api')
    expect(store).not.toMatch(/from ['"]electron['"]/)
  })

  it('deviceStore 订阅设备推送并在卸载时退订（不漏监听器）', () => {
    const source = read('src/store/deviceStore.ts')
    expect(source).toMatch(/onChanged\(/)
    // 订阅必须把 onChanged 的退订函数原样返回（调用方才能在卸载时解开）
    expect(source).toMatch(/return\s+window\.api\.devices\.onChanged\(/)
  })
})
describe('任务 7：文件页契约（静态断言）', () => {
  const FILE_SOURCES = [
    'src/components/FileTable.tsx',
    'src/components/Breadcrumb.tsx',
    'src/pages/FilesPage.tsx',
    'src/store/fileStore.ts',
  ]

  it('文件页源码不 import node 内置模块、不直接 import electron、无 as any', () => {
    for (const rel of FILE_SOURCES) {
      const source = read(rel)
      expect(source, rel).not.toMatch(/from ['"]node:/)
      expect(source, rel).not.toMatch(/require\(/)
      expect(source, rel).not.toMatch(/from ['"]electron['"]/)
      expect(source, rel).not.toMatch(/\bas\s+any\b/)
      expect(source, rel).not.toMatch(/@ts-ignore|@ts-expect-error/)
    }
  })

  it('文件页组件的文案全部走 i18n（无硬编码中文）', () => {
    for (const rel of FILE_SOURCES) {
      const source = read(rel)
      const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      const hanInCode = /['"`>][^'"`<]*[\u4e00-\u9fff][^'"`<]*['"`<]/.test(noComments)
      expect(hanInCode, rel).toBe(false)
    }
  })

  it('排序与过滤只走 shared 纯函数（组件里不自己写 sort/filter 判断）', () => {
    const page = read('src/pages/FilesPage.tsx')
    // 必须用 visibleEntries（过滤 + 排序的唯一实现），且包在 useMemo 里（裁决 4）
    expect(page).toContain('visibleEntries(')
    expect(page).toContain('useMemo')
    expect(page).not.toMatch(/\.sort\(/)
    expect(page).not.toMatch(/entries\.filter\(/)
  })

  it('虚拟滚动的行高只有一个来源（ROW_HEIGHT），组件不写字面量 34', () => {
    const table = read('src/components/FileTable.tsx')
    expect(table).toContain('ROW_HEIGHT')
    expect(table).toContain('estimateSize: () => ROW_HEIGHT')
    expect(table).not.toMatch(/height:\s*34/)
    expect(table).not.toMatch(/height:\s*'34px'/)
  })

  it('fileStore 按 serial 分片且所有请求经 window.api（不绕过 preload）', () => {
    const store = read('src/store/fileStore.ts')
    expect(store).toContain('window.api.fs.list(')
    // 分片键必须来自 serial（裁决 7）
    expect(store).toMatch(/\[serial\]/)
    // 加载必须经过协调器（裁决 2：过期响应丢弃 + 在飞去重）
    expect(store).toContain('createLoadCoordinator')
  })

  it('fileStore 不重复实现状态机（reducer 来自 shared，有单测）', () => {
    const store = read('src/store/fileStore.ts')
    expect(store).toContain('fileViewsReducer')
    expect(store).toContain('@shared/file-view')
  })
})
