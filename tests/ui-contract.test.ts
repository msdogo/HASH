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
    // 加载必须经过协调器（裁决 2：过期响应丢弃 + 在飞去重）。
    // 审查轮 1 后协调器从 store 下沉到 shared 的模型层（store 只剩一层壳），断言随之指向实现处。
    expect(read('src/shared/file-view.ts')).toContain('createLoadCoordinator')
  })

  it('fileStore 不重复实现状态机（状态机/协调器/模型全部来自 shared，有单测）', () => {
    const store = read('src/store/fileStore.ts')
    // 修前断言的是 fileViewsReducer；审查轮 1 后 store 收敛成「模型的一层壳」，
    // 迁移入口变成 createFileViewsModel（内部仍用 fileViewsReducer）。断言随之更新：
    // 重点是「状态迁移逻辑不在 store 里自己实现」，而不是某个具体函数名。
    expect(store).toContain('createFileViewsModel')
    expect(store).toContain('@shared/file-view')
    expect(store).not.toMatch(/switch \(action\.type\)/)
  })
})
describe('任务 9：文件操作与本地双栏契约（静态断言）', () => {
  const OP_SOURCES = [
    'src/components/FileToolbar.tsx',
    'src/components/LocalPanel.tsx',
    'src/components/OpDialog.tsx',
    'src/pages/FilesPage.tsx',
    'src/store/opStore.ts',
    'src/store/localStore.ts',
    'src/shared/op-view.ts',
    'src/shared/fs-ops.ts',
    'src/shared/path-guard.ts',
    'src/shared/file-ops.ts',
  ]

  it('新增源码不 import node 内置模块 / electron，且无 as any', () => {
    for (const rel of OP_SOURCES) {
      const source = read(rel)
      expect(source, rel).not.toMatch(/from ['"]node:/)
      expect(source, rel).not.toMatch(/require\(/)
      expect(source, rel).not.toMatch(/from ['"]electron['"]/)
      expect(source, rel).not.toMatch(/\bas\s+any\b/)
      expect(source, rel).not.toMatch(/@ts-ignore|@ts-expect-error/)
    }
  })

  it('新增组件文案全部走 i18n（无硬编码中文）', () => {
    for (const rel of ['src/components/FileToolbar.tsx', 'src/components/LocalPanel.tsx', 'src/components/OpDialog.tsx']) {
      const source = read(rel)
      const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      const hanInCode = /['"`>][^'"`<]*[\u4e00-\u9fff][^'"`<]*['"`<]/.test(noComments)
      expect(hanInCode, rel).toBe(false)
    }
  })

  it('渲染层的文件操作与本地访问只经 window.api（不绕过 preload）', () => {
    const opStore = read('src/store/opStore.ts')
    // 写操作必须走 api-contract 里的通道
    for (const call of ['window.api.fs.mkdir(', 'window.api.fs.rename(', 'window.api.fs.removeFacts(', 'window.api.fs.remove(', 'window.api.fs.copy(', 'window.api.fs.move(']) {
      expect(opStore, call).toContain(call)
    }
    // 裁决 7：下载必须走传输队列（不是自己 spawn / 不是 fs.copy）
    expect(opStore).toContain('window.api.transfer.enqueue(')
    expect(opStore).toContain("direction: 'pull'")
    // 本地访问只经 local 命名空间
    expect(read('src/store/localStore.ts')).toContain('window.api.local.list(')
    expect(read('src/store/localStore.ts')).toContain('window.api.local.pickRoot(')
  })

  it('裁决 1：删除必须先取事实再开确认框（渲染层不允许盲删）', () => {
    const opStore = read('src/store/opStore.ts')
    // prepareDelete 里 removeFacts 必须在 openConfirm 之前
    const fnStart = opStore.indexOf('prepareDelete: async')
    const fnBody = opStore.slice(fnStart, fnStart + 900)
    expect(fnBody.indexOf('removeFacts(')).toBeGreaterThan(-1)
    expect(fnBody.indexOf('removeFacts(')).toBeLessThan(fnBody.indexOf("type: 'openConfirm'"))
    // 确认按钮的可用性来自 shared 的 canConfirm（有单测），不在组件里重写
    expect(read('src/components/OpDialog.tsx')).toContain('canConfirm(')
    expect(opStore).not.toMatch(/facts:\s*\{[^}]*count:\s*\d/)
  })

  it('裁决 1：确认框必须显示数量、前 3 个名字与非空提示', () => {
    const dialog = read('src/components/OpDialog.tsx')
    // 标题经 titleKey() 映射到 i18n key（不是直接 t('op.delete.title')）
    expect(dialog).toContain("return 'op.delete.title'")
    expect(dialog).toContain('t(titleKey(dialog))')
    expect(dialog).toContain("tf('op.delete.count'")
    expect(dialog).toContain('facts.names.map')
    expect(dialog).toContain('facts.hasNonEmptyDir')
    expect(dialog).toContain("t('op.delete.nonEmpty')")
    expect(dialog).toContain('facts.blocked')
    expect(dialog).toContain("t('op.delete.irreversible')")
  })

  it('裁决 4：界面显示「N 成功 / M 失败」且失败项可展开看文案', () => {
    const dialog = read('src/components/OpDialog.tsx')
    expect(dialog).toContain("tf('op.result.title'")
    expect(dialog).toContain('summary.failures.map')
    expect(dialog).toContain('errorText(')
  })

  it('裁决 5：本地面板显示当前限制范围（用户必须看得见）', () => {
    expect(read('src/components/LocalPanel.tsx')).toContain("tf('local.root'")
  })

  it('裁决 1：主进程写操作必须过统一路径闸门与受保护判定', () => {
    const ops = read('electron/fs/operations.ts')
    expect(ops).toContain('assertSafeRemotePath')
    expect(ops).toContain('isProtectedRemotePath')
    // 删除前必须 stat 判类型（决定递归与链接处理）
    expect(ops).toContain('statKind(')
    expect(ops).toMatch(/rm -rf -- |'rm -rf -- '/)
    // 移动必须带 -n（不覆盖）
    expect(ops).toContain('mv -n -- ')
    /*
     * 【审查 I2】这里原来是一条正则：expect(ops).not.toMatch(/\['\s*\+\s*path\b/)。
     * 它匹配的是「数组字面量后紧跟 + path」，而真实的旁路形态是字符串字面量
     * 'raw ' + path（前面是引号不是 [）。复审把 opPath 返回值改成 'raw ' + path
     * （完全绕过 shellQuote）后，本文件仍是 34 passed —— 这条断言从来没生效过。
     *
     * 现在改为**行为断言**，放在 tests/operations.test.ts 的
     * describe('审查 I1/I2：闸门行为') 里：直接比较命令构造函数的输出
     * 与 shellQuote 的产物，并验证含 .. 的输入真的会抛 E_PATH_UNSAFE。
     * 那种断言无法被「换个写法绕过正则」骗过去。
     */
  })

  it('裁决 2：所有远程写路径都来自 shared/path-guard 的单一闸门', () => {
    const guard = read('src/shared/path-guard.ts')
    expect(guard).toContain('export function checkRemotePath')
    expect(guard).toContain('export function assertSafeRemotePath')
    expect(guard).toContain('export function checkName')
    /*
     * 【审查 I1】这里原来是一条正则：not.toMatch(/split(...).*=== '..'/)
     * —— 源码里从来没有这种形态（真实写法是 .some((seg) => seg === '..')），
     * 所以它在任何情况下都通过。复审往 gate() 里塞了一份重复的 '..' 规则后，
     * 本文件仍是 34 passed（全绿），一条断言都没变红。
     *
     * 改成**行为断言**（见 tests/operations.test.ts 的「审查 I1/I2：闸门行为」块）：
     * 对含 '..' 的输入，命令构造函数必须一律抛 E_PATH_UNSAFE；
     * 合法输入的命令输出必须逐字节等于 shellQuote 的产物。
     * 判据从「源码长什么样」变成「行为是什么」—— 换个写法骗不过去。
     */
  })

  it('裁决 5：本地访问必须在主进程做 realpath 判定（词法检查防不住符号链接）', () => {
    const local = read('electron/fs/local.ts')
    expect(local).toContain('realpath')
    expect(local).toContain('isInsideRoot')
    expect(local).toContain('E_OUTSIDE_ROOT')
  })

  it('裁决 7：文件页有下载入口（不允许「有队列没界面」）', () => {
    const toolbar = read('src/components/FileToolbar.tsx')
    expect(toolbar).toContain("t('op.toolbar.download')")
    const page = read('src/pages/FilesPage.tsx')
    expect(page).toContain('onDownload=')
    expect(page).toContain('download(')
    // i18n 里必须有对应文案（任务 8 曾主动删掉该 key，说「留 key 不留入口是许愿池」）
    expect(read('src/shared/i18n.ts')).toContain("'transfer.download'")
  })
})

describe('任务 8：传输底栏契约（静态断言）', () => {
  const TRANSFER_SOURCES = [
    'src/components/TransferDock.tsx',
    'src/store/transferStore.ts',
    'src/shared/transfer.ts',
    'src/shared/transfer-view.ts',
  ]

  it('传输源码不 import node 内置模块、不直接 import electron、无 as any', () => {
    for (const rel of TRANSFER_SOURCES) {
      const source = read(rel)
      expect(source, rel).not.toMatch(/from ['"]node:/)
      expect(source, rel).not.toMatch(/require\(/)
      expect(source, rel).not.toMatch(/from ['"]electron['"]/)
      expect(source, rel).not.toMatch(/\bas\s+any\b/)
      expect(source, rel).not.toMatch(/@ts-ignore|@ts-expect-error/)
    }
  })

  it('传输组件文案全部走 i18n（无硬编码中文）', () => {
    for (const rel of ['src/components/TransferDock.tsx', 'src/store/transferStore.ts']) {
      const source = read(rel)
      const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      const hanInCode = /['"`>][^'"`<]*[\u4e00-\u9fff][^'"`<]*['"`<]/.test(noComments)
      expect(hanInCode, rel).toBe(false)
    }
  })

  it('TransferDock 只做展示与接线：判断全部来自 shared 纯函数', () => {
    const source = read('src/components/TransferDock.tsx')
    // 进度/排序/可取消可重试的判断必须来自 shared（有单测）
    expect(source).toContain('dockRows(')
    expect(source).toContain('@shared/transfer-view')
    // 不得在组件里自己写百分比算法
    expect(source).not.toMatch(/doneBytes\s*\/\s*totalBytes/)
  })

  it('I1：main.ts 用事件批次驱动掉线暂停（不得自己 diff 两次 list()）', () => {
    const main = read('electron/main.ts')
    // 第 2 轮审查：第 1 轮的「两次 devices.list() 自 diff」是空转
    // （manager 先改状态再 emit，回调里两次 list() 读到同一份表）。
    // 这条静态断言守的是「不再走那条死路」，行为级链路由 transfer-wiring.test.ts 守。
    expect(main).toContain('wireBatchToTransfer(')
    expect(main).toContain('TransferOnlineTracker')
    // 必须在设备变化回调里做，而不是启动时做一次
    expect(main).toMatch(/onDevicesChanged\([\s\S]{0,700}wireBatchToTransfer\(/)
    /*
     * 【裁决 8 / 任务 9】反向断言：回调里禁止再调用 devices.list()。
     *
     * 复审变异 M1c 抓到的缺口：喂一个空批次时上面那条静态断言仍然全绿 ——
     * 它只证明了「接线存在」，证明不了「接线拿的是真实变化」。
     * 第 1 轮的死路正是「回调里读两次 list() 再自 diff」，所以这条禁用是它的另一半：
     * 少了它，将来有人把 wireBatchToTransfer 的参数换成「现取的快照」也不会被发现。
     */
    const callback = /onDevicesChanged\(\([^)]*\)\s*=>\s*\{[\s\S]*?\n\s*\}\)/.exec(main)
    expect(callback).not.toBeNull()
    if (callback !== null) expect(callback[0]).not.toMatch(/devices\.list\(/)
    // 反例：不允许退回「取两次快照再自 diff」
    expect(main).not.toContain('diffOnlineSerials(')
  })

  it('transferStore 所有请求经 window.api（不绕过 preload），且不自己轮询', () => {
    const store = read('src/store/transferStore.ts')
    expect(store).toContain('window.api.transfer.enqueue(')
    expect(store).toContain('window.api.transfer.onChanged(')
    // 渲染层绝不自己轮询进度（轮询在主进程）
    expect(store).not.toMatch(/setInterval/)
  })
})

describe('任务 7 审查轮 1：修复项的静态契约', () => {
  it('C1：FilesPage 不在 handleOpen/handleJump 里清空列表（导航只登记目标）', () => {
    const page = read('src/pages/FilesPage.tsx')
    // 组件不直接改 entries / selected / cwd，全部交给 store 的 openDir（内部走 navigate + resolve）
    expect(page).not.toMatch(/entries: \[\]/)
    expect(page).not.toMatch(/selected: \[\]/)
    expect(page).toContain('openDir(')
  })

  it('C1：reducer 的 navigate 不清空 entries（用 pendingCwd 延迟提交）', () => {
    const source = read('src/shared/file-view.ts')
    const navigateCase = source.slice(source.indexOf("case 'navigate':"), source.indexOf("case 'beginLoad':"))
    expect(navigateCase).toContain('pendingCwd')
    expect(navigateCase).not.toContain('entries: []')
    expect(navigateCase).not.toContain('selected: []')
    expect(navigateCase).not.toContain('scrollTop: 0')
  })

  it('I4：FilesPage 用 openTarget 决定导航目标（不再直接 if (!entry.isDir) return）', () => {
    const page = read('src/pages/FilesPage.tsx')
    expect(page).toContain('openTarget(')
    expect(page).not.toMatch(/if \(!entry\.isDir\) return/)
    // 链接错误必须给提示（不是静默返回）
    expect(page).toContain("type: 'addressError'")
  })

  it('I7：键盘处理挂且只挂一处（避免 Backspace 被处理两次）', () => {
    const page = read('src/pages/FilesPage.tsx')
    const table = read('src/components/FileTable.tsx')
    const pageBindings = (page.match(/onKeyDown=\{/g) ?? []).length
    expect(pageBindings).toBe(0)
    expect(table).toContain('onKeyDown={props.onKeyNav}')
    expect(table).toContain('tabIndex={0}')
    expect(page).toContain('navKeyCommand(')
  })

  it('I3：滚动上报的 rAF 用 ref 持有最新回调，并在切换时取消挂起的帧', () => {
    const table = read('src/components/FileTable.tsx')
    expect(table).toContain('latestOnScrollTop')
    expect(table).toContain('cancelAnimationFrame')
    // 不允许 rAF 闭包直接调 props.onScrollTop（旧闭包会把上一台设备的值写进新设备）
    expect(table).not.toMatch(/requestAnimationFrame\(\(\) => \{[\s\S]{0,120}props\.onScrollTop/)
  })

  it('I5/I6：设备表变化接到分片生命周期（forget 有调用方）', () => {
    const page = read('src/pages/FilesPage.tsx')
    expect(page).toContain('syncDevices(')
    const model = read('src/shared/file-view.ts')
    // tombstone 必须真的在 dispatch 路径上拦截
    expect(model).toContain('tombstones.has(serial)')
    // 去重键必须是目录，不是代次
    expect(model).toContain("const key = serial + '\\u0001' + dir")
  })
})
