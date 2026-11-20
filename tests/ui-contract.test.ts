import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { ERROR_CODES } from '../src/shared/errors'
import { t } from '../src/shared/i18n'

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
    'src/components/OpDialog.tsx',
    'src/pages/FilesPage.tsx',
    'src/store/opStore.ts',
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
    for (const rel of ['src/components/FileToolbar.tsx', 'src/components/OpDialog.tsx']) {
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
    /*
     * 【第 2 轮复审 N1】下载流程搬进了 src/shared/download-flow.ts。
     *
     * 原因：busy 复位漏在下载成功路径上，而 opStore 在 tsconfig.node.json 里
     * 不可 import（include 不含 src/），于是「下载」这条最容易卡死整个对话框的
     * 路径零测试覆盖。流程抽到 shared 才能被单测直接打。
     * 所以这里断言的位置跟着搬：opStore 只负责注入 window.api，真正的
     * enqueue + direction 在 download-flow 里。
     */
    expect(opStore).toContain('window.api.transfer.enqueue(')
    const downloadFlow = read('src/shared/download-flow.ts')
    expect(downloadFlow).toContain('direction: \'pull\'')
    /*
     * 【R4 事项 2 删除】这里原本还有两条：
     *   expect(read('src/store/localStore.ts')).toContain('window.api.local.list(')
     *   expect(read('src/store/localStore.ts')).toContain('window.api.local.pickRoot(')
     * 它们查的是本地栏的 store，而本地栏已由用户裁决删除（本地面板 + localStore + 测试一并移除）。
     * 按裁决「删除而不是放宽」：断言的**对象文件**已不存在，保留任何放宽版只会变成
     * 「某个字符串在某个文件里出现过」的空转。local:list / local:pick-root 这两条 IPC
     * 通道本身仍在使用（另一个调用方是「选择要推送的文件」对话框），
     * 它们的真门禁在 tests/ipc-handlers.test.ts（含 preload 载荷与取消语义）。
     */
  })

  /*
   * 【终审 I-1 / 第 9 次假护栏】这里原本是：
   *   const fnBody = opStore.slice(fnStart, fnStart + 900)
   *   expect(fnBody.indexOf('removeFacts(')).toBeLessThan(fnBody.indexOf("type: 'openConfirm'"))
   * 位置比对的对象是**源码文本**，注释即满足。终审实测：把 opStore 里真实的
   * window.api.fs.removeFacts(...) 换成「一行诱饵注释 + 常量桩」后 tsc exit 0、
   * 全量 1164 passed，而确认框会稳定显示「将删除 0 项」—— 裁决 1 的最后一道
   * 落地保障是空的。**已删除该断言**，替代品都是行为断言：
   *   - tests/delete-flow.test.ts：注入式 makePrepareDelete，断言「成功时 openConfirm
   *     恰好一次且拿到主进程给的事实 / 失败与抛异常时零调用 / 入参逐字节透传」；
   *   - tests/store-wiring.test.ts：换成假 window.api 直接驱动 opStore，断言
   *     「removeFacts 真的被调用一次、facts 真的是主进程给的、且取事实阶段不调 remove」。
   * 本文件只保留「哪些判断必须来自 shared（有单测）」这类确实只能静态查的规则。
   */
  /*
   * 【第 14 次假护栏 / 合并前复审】这里原本是：
   *   expect(read('src/components/OpDialog.tsx')).toContain('canConfirm(')
   * 而这条**永远为真**：文件顶部有
   *   import { canConfirm, isDestructive, type OpDialog } from '@shared/op-view'
   * import 行本身就含 'canConfirm('。复审实测：把组件里的判断改成
   *   const canGo = true（后跟一行 canConfirm 注释）
   * → 全量 1203 passed、tsc exit 0。与 I-4 的 toContain('hasUnauthorized') 被 import
   * 满足是同一种形态。**已删除该行**，替代品是两层真门禁：
   *   - tests/op-view.test.ts：canConfirm 纯函数的正/反/按 kind 分别的真值表；
   *   - tests/component-wiring.test.tsx：真渲染删除框，断言「确定」按钮在 count>0 时
   *     **没有 disabled**、count 为 0 时**有 disabled** —— 组件若绕过 canConfirm，两条都会红。
   * 只保留下面那条「opStore 不得自己编 facts 数字」的正则：它查的是**禁止形态**
   * （断言某写法不存在），不是「某函数名出现过」，无法被注释满足。
   */
  it('裁决 1：store 不得自己编造删除事实数量（必须是主进程给的）', () => {
    expect(read('src/store/opStore.ts')).not.toMatch(/facts:\s*\{[^}]*count:\s*\d/)
  })

  /*
   * 【终审 I-5 / 第 13 次假护栏】这里原本断言 DeleteFacts **函数体内**有 tf('op.delete.count'、
   * facts.names.map、facts.hasNonEmptyDir 等字样。问题：它证明的是「函数写了」，
   * 不是「函数被调用」。终审实测：把 OpDialog.tsx 里 <DeleteFacts facts={dialog.facts} />
   * 整块换成 null（数量 / 前 3 个名字 / 非空提示全消失）后全量 1164 passed、tsc exit 0。
   * **已删除**，替代品是 tests/component-wiring.test.tsx 的 renderToStaticMarkup 渲染断言：
   * 真组件渲染出的 HTML 里必须逐个出现「将删除 5 项」「a.txt/dir1/b.txt」「另有 2 项未列出」
   * 「其中有非空文件夹…」「1 项被安全策略拒绝」，且事实随输入变化（没有就不显示）。
   */
  /*
   * 【第 14 次假护栏 / 合并前复审】这里原本还有一条：
   *   expect(dialog).toContain('isDestructive(')
   * 复审实测两种注入：干净地把两处改成 false → 1 failed（文本断言此刻能红）；
   * 但只要在改动处留一句 isDestructive(dialog) 的注释诱饵 → **全量 1203 passed、tsc 0**。
   * 即「注释即满足」，与第 9~13 次逐字同款。**已删除**，替代品是：
   *   - tests/op-view.test.ts：isDestructive 纯函数真值表（delete→true，其余→false，null→false）；
   *   - tests/component-wiring.test.tsx：真渲染删除框断言标题带 text-red-600、
   *     确认按钮带 bg-red-600；渲染「新建文件夹」框断言**不带**这两个红色类 ——
   *     组件若把 isDestructive 写死 true/false，两个方向都会红。
   * 剩下两条（titleKey 映射与词面标题）保留：它查的是「标题走哪个 key」这一映射，
   * 而 import 行满足在这里不成立（'return \'op.delete.title\'' 只出现在函数体内）。
   */
  it('裁决 1：确认框标题经 titleKey() 映射到 i18n key（不写死文案）', () => {
    const dialog = read('src/components/OpDialog.tsx')
    expect(dialog).toContain("return 'op.delete.title'")
    expect(dialog).toContain('t(titleKey(dialog))')
  })

  it('裁决 4：界面显示「N 成功 / M 失败」且失败项可展开看文案', () => {
    const dialog = read('src/components/OpDialog.tsx')
    expect(dialog).toContain("tf('op.result.title'")
    expect(dialog).toContain('summary.failures.map')
    expect(dialog).toContain('errorText(')
  })

  /*
   * 【R4 事项 2 删除】这里原本有一条「起始浏览目录的文案带 {dir} 占位」的断言，
   * 守的是本地面板顶部那行「起始目录：<路径>」（第 15 次假护栏留下的替代品）。
   *
   * 本地面板已由用户裁决删除（组件 / store / 渲染用例 / i18n 的 local.* 一批一起移除），
   * 这条断言的对象——`local.startDir` 这个 key——也随之不存在了。
   * 按裁决「删除而不是放宽」：把断言改成 not.toBe 或换 key 都是空转。
   *
   * 注意这里**不是**在放宽门禁：本地面板的可观测行为整块消失，对应的门禁理应一起消失。
   * 上传仍有两条真实入口，它们的行为门禁分别在
   * tests/drag-flow.test.ts（拖入）与 tests/transfer-*（底栏上传按钮走的队列）。
   */

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

  /*
   * 【R2-1】这里原来是三条源码文本断言（realpath / isInsideRoot / E_OUTSIDE_ROOT）。
   * 本地根沙箱被用户裁决移除后 isInsideRoot 与 E_OUTSIDE_ROOT 都不存在了，
   * 而「有没有真的做 realpath」本来就该由**行为**断言守
   * （tests/local.test.ts：「经由符号链接的写入路径被解析成链接指向的真实位置」）。
   * 源码文本断言在本项目已经出过 14 次「注入缺陷仍全绿」，因此不再保留。
   *
   * 仍然保留一条可执行的事实：沙箱的错误码彻底下线了（表里没有它，渲染层也就
   * 不可能再收到一个指向「目录之外」的提示）—— 这是可以被变异验证的：
   * 把 E_OUTSIDE_ROOT 加回 ERROR_CODES，这一条立刻红。
   */
  it('R2-1：本地根沙箱的错误码已从错误码表下线', () => {
    expect(ERROR_CODES).not.toContain('E_OUTSIDE_ROOT')
    expect(t('local.root')).toBe('local.root')
    expect(t('local.restricted')).toBe('local.restricted')
  })

  /*
   * 【终审 I-2 / 第 10 次假护栏】这里原本是 expect(page).toContain('onDownload=') +
   * toContain('download(')。后者连「函数定义」都能满足（const handleDownload = …）；
   * 前者只证明这行属性出现过。终审实测：把 FilesPage 的 onDownload 接到 onClick 空操作后
   * 全量 1164 passed、tsc exit 0，按钮照样渲染照样可点，点击毫无反应 ——
   * 正是任务 9 裁决 7 明令禁止的「有队列没界面」。
   * **两条文本断言已删除**，替代品是 tests/download-flow.test.ts 的
   * makeDownloadHandler 行为断言（真的调 runDownload、带什么 serial/sources/localDir，
   * 没选中/没选目录时必须不调用并给提示，失败返回错误码）。
   * 这里只留「按钮与文案确实存在」这一层——它本来就该由渲染测试守，
   * 但 FileToolbar 的按钮渲染已被 overview-buttons 之外的用例间接覆盖，此处仅存文案 key。
   */
  it('裁决 7：下载按钮有 i18n 文案（入口行为见 tests/download-flow.test.ts）', () => {
    const toolbar = read('src/components/FileToolbar.tsx')
    expect(toolbar).toContain("t('op.toolbar.download')")
    // i18n 里必须有对应文案（任务 8 曾主动删掉该 key，说「留 key 不留入口是许愿池」）
    expect(read('src/shared/i18n.ts')).toContain("'transfer.download'")
  })
})

describe('任务 10：批量操作与总览页契约（静态断言）', () => {
  const BATCH_SOURCES = [
    'src/pages/OverviewPage.tsx',
    'src/store/batchStore.ts',
    'src/shared/batch.ts',
    'src/shared/batch-flow.ts',
    'src/shared/batch-shell.ts',
  ]

  it('新增源码不 import node 内置模块、不直接 import electron、无 as any', () => {
    for (const rel of BATCH_SOURCES) {
      const source = read(rel)
      expect(source, rel).not.toMatch(/from ['"]node:/)
      expect(source, rel).not.toMatch(/require\(/)
      expect(source, rel).not.toMatch(/from ['"]electron['"]/)
      expect(source, rel).not.toMatch(/\bas\s+any\b/)
      expect(source, rel).not.toMatch(/@ts-ignore|@ts-expect-error/)
    }
  })

  /*
   * 【第 4 轮 N10】这里原本有一条「危险命令的提交必须经 makeShellSubmitter」的断言，
   * 判据是 expect(source).toContain('makeShellSubmitter(')。**已删除。**
   *
   * 复审实测：把组件里的真调用整段删掉、只留一行
   *   // 曾经调用 makeShellSubmitter( ，N10 后已改写
   * —— 断言仍然绿（ui-contract 37 passed、全量 1148 passed、tsc 0）。
   * 它抓的只是「字符串出现过」，注释即满足；更糟的是连「用变量传参」都抓不住
   * （void run(shellArgs) 里没有 action: 'shell' 字样，过滤出空集，整段空转）。
   *
   * 替代品是 tests/overview-shell.test.ts —— 直接驱动 buildShellSubmitter
   * 并断言 confirm / run 的调用次数与载荷，不读任何源码文本。
   *
   * 组件里 onClick 那一行（把 deps 交给 buildShellSubmitter）**确实没有门禁**，
   * 且渲染期无法观测。这一层如实记为「靠 code review」——不再编造断言。
   */

  it('总览页文案全部走 i18n（无硬编码中文）', () => {
    for (const rel of ['src/pages/OverviewPage.tsx', 'src/store/batchStore.ts']) {
      const source = read(rel)
      const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      const hanInCode = /['"`>][^'"`<]*[\u4e00-\u9fff][^'"`<]*['"`<]/.test(noComments)
      expect(hanInCode, rel).toBe(false)
    }
  })

  /*
   * 【复审 C1】这里原本有三条 toContain(源码文本) 的断言，全部删除。
   *
   * 它们检查的是源码里有没有某个字样，而注释也是源码文本 —— 审查实测：
   * 把 batchStore 里真正的 window.api.batch.shell(...) 调用换成常量 + 一行含该字样的
   * 注释，全套 1063 个用例仍然全绿（V2）；同理「电量伪造 0%」（V3）与
   * 「结果矩阵不再走 resultRows」（V5）也都能骗过。
   *
   * 替代品都是**行为断言**，不再依赖任何源码文本：
   *   - 四个动作真的调用到哪个 window.api 方法 → tests/batch-store.test.ts（假 window.api）
   *   - 电量/存储占位、按钮可点性 → tests/batch-view.test.ts 的 batteryPercent /
   *     storageView / canSubmit（纯函数，输入输出可断言）
   *   - 结果矩阵行 → tests/batch-store.test.ts 的 resultRows
   * 本文件只保留「只能静态查」的两类规则（node-free / 无 as any / 无硬编码中文）。
   */
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

/*
 * R2-2：设置页与默认下载路径的**只能静态查**的那几条规则。
 *
 * 这里刻意只保留「禁止形态」类断言（不 import node / 不用 as any / 不硬编码中文）——
 * 它们无法被注释满足，也没有对应的行为用例可以替代（组件里写死一句中文，
 * 行为测试不会红，因为那句话本来就会出现在 HTML 里）。
 *
 * 与设置有关的**行为**（持久化真读写、坏值降级、下载目标优先级）在
 * tests/settings-store.test.ts / tests/settings-flow.test.ts / tests/settings-ipc.test.ts，
 * 渲染期在 tests/settings-page.test.tsx。本文件不再放任何 toContain(源码) 断言。
 */
describe('R2-2：设置页与下载路径的静态契约', () => {
  const SETTINGS_SOURCES = [
    'src/pages/SettingsPage.tsx',
    'src/store/settingsStore.ts',
    'src/shared/settings.ts',
    'electron/settings/store.ts',
  ]

  it('新增源码不 import 渲染层禁用的 node 模块 / electron，且无 as any', () => {
    for (const rel of SETTINGS_SOURCES) {
      const source = read(rel)
      expect(source, rel).not.toMatch(/\bas\s+any\b/)
      expect(source, rel).not.toMatch(/@ts-ignore|@ts-expect-error/)
    }
    // 渲染层三件（shared / store / page）不得 import node 内置模块或 electron
    for (const rel of ['src/pages/SettingsPage.tsx', 'src/store/settingsStore.ts', 'src/shared/settings.ts']) {
      const source = read(rel)
      expect(source, rel).not.toMatch(/from ['"]node:/)
      expect(source, rel).not.toMatch(/require\(/)
      expect(source, rel).not.toMatch(/from ['"]electron['"]/)
    }
  /*
   * 【复审 E / 第 15 次假护栏】这里原本还有两条：
   *   expect(store).toMatch(/from ['"]electron-store['"]/)
   *   expect(store).toMatch(/from ['"]node:fs['"]/)
   * 复审实测：把 electron/settings/store.ts 的 import 换成注释（真 import 删掉）
   * → 本文件 44 passed 全绿。它们查的是「某段文本出现过」，注释即可满足。
   *
   * **已删除**。这两条从来不是 load-bearing：
   *   - 同一变异下 `npx tsc -b` → TSC=1（TS2351：这个表达式不可构造）；
   *   - tests/settings-store.test.ts 12 条红（真实 electron-store 文件读写跑不起来）。
   * 也就是说「用没用真的 electron-store / node:fs」已经由类型系统 + 真读写用例
   * 双重守住；再补一条静态断言只会是第二个假护栏，故此处**刻意不再加**。
   */
  })

  it('设置页与 store 的文案全部走 i18n（无硬编码中文）', () => {
    for (const rel of ['src/pages/SettingsPage.tsx', 'src/store/settingsStore.ts', 'src/shared/settings.ts']) {
      const source = read(rel)
      const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      const hanInCode = /['"`>][^'"`<]*[\u4e00-\u9fff][^'"`<]*['"`<]/.test(noComments)
      expect(hanInCode, rel).toBe(false)
    }
  })

  it('下载目标只有一个来源：shared 的判定与设置 store 都不碰已删除的本地栏状态', () => {
    /*
     * 这条查的是**禁止形态**（断言某种写法不存在），不是「某函数名出现过」——
     * 后者会被注释满足（本项目已经吃过 15 次亏）。
     *
     * 【R4 事项 2】本地面板与 localStore 已删除，所以「回退到本地面板目录」这条路
     * 连类型都不成立了（import 会直接编译失败）。这里保留禁止形态是第二道保险：
     * 拦住有人重新引入一个同名的「别的本地目录来源」写进判定。
     */
    for (const rel of ['src/shared/settings.ts', 'src/store/settingsStore.ts']) {
      const source = read(rel)
      expect(source, rel).not.toMatch(/localStore/)
      expect(source, rel).not.toMatch(/useLocalStore/)
    }
    // 设置页不得自己拼默认下载路径（必须来自主进程的 getDefaultDownloadDir / reset）
    const page = read('src/pages/SettingsPage.tsx')
    expect(page).not.toMatch(/Downloads['"`]/)
  })

  /*
   * 【如实记录门禁边界】FilesPage 里那一行注入（localDir: () => downloadDirForDownload(...)）
   * 是**点击时才执行**的组件接线，本工程无 jsdom、只做 SSR 渲染，
   * 实测把它换成别的实现后全量仍然全绿 —— 与项目里已记录的
   * N10 / I-3 属于同一类「组件内调用点无法观测」的缺口。
   *
   * 所以这里保留一条**接线存在性**断言：FilesPage 必须把 downloadDirForDownload 的
   * 结果注入 localDir（不是别的目录来源）。R4 之后签名只收 settings 一个参数，
   * 断言随之收窄 —— 多传一个「本地目录」会直接编译失败，不需要靠正则拦。
   * 判定本身仍在 src/shared/settings.ts（tests/settings-flow.test.ts 有优先级用例）。
   */
  it('FilesPage 的下载目标注入来自 downloadDirForDownload（接线存在性）', () => {
    const page = read('src/pages/FilesPage.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(page).toMatch(/localDir:\s*\(\)\s*=>\s*downloadDirForDownload\(/)
    // 反向：不得再出现任何「本地栏目录」作为下载目标
    expect(page).not.toMatch(/localDir:\s*\(\)\s*=>\s*[^,\n]*useLocalStore/)
    expect(page).not.toMatch(/localStore/)
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

  /*
   * 【终审 I-3 / 第 11 次假护栏】这里原本是 expect(page).toContain('syncDevices(') ——
   * import 行（:71）与 store 定义都能满足。终审实测：删掉 FilesPage 里真实的 useEffect
   * 调用、只留注释 + void deviceSerials 后全量 1164 passed、tsc exit 0；
   * 后果是分片永不 forget（每台设备残留整份 entries，内存单调增长，与规格 <400MB 冲突）。
   * **已删除该断言**，替代品是 tests/device-lifecycle.test.ts：
   * ① 新设备出现 → 真的得到 view state；② 设备消失超过 30 分钟保留期 → manager gc
   * 发 removed、分片随之 forget（30 分钟内必须保留）；③ 超过上限时在线设备不被淘汰。
   * 剩下两条仍保留在这里，因为它们查的是**模型实现内部结构**（tombstone 拦截与去重键），
   * 已有对应的行为用例压着（file-view.test.ts 的 N3/N5 块）。
   */
  it('I5/I6：分片模型的两条内部约束（行为见 file-view.test.ts）', () => {
    const model = read('src/shared/file-view.ts')
    // tombstone 必须真的在 dispatch 路径上拦截
    expect(model).toContain('tombstones.has(serial)')
    // 去重键必须是目录，不是代次
    expect(model).toContain("const key = serial + '\\u0001' + dir")
  })
})

describe('简报 C：双向拖拽契约（静态断言）', () => {
  const DRAG_SOURCES = [
    'src/shared/drag.ts',
    'src/shared/drag-flow.ts',
    'src/store/dragStore.ts',
    'src/components/FileTable.tsx',
    'src/pages/FilesPage.tsx',
  ]

  it('拖拽源码不 import node 内置模块 / electron，且无 as any', () => {
    for (const rel of DRAG_SOURCES) {
      const source = read(rel)
      expect(source, rel).not.toMatch(/from ['"]node:/)
      expect(source, rel).not.toMatch(/require\(/)
      expect(source, rel).not.toMatch(/from ['"]electron['"]/)
      expect(source, rel).not.toMatch(/\bas\s+any\b/)
      expect(source, rel).not.toMatch(/@ts-ignore|@ts-expect-error/)
    }
  })

  it('拖拽新增文件（纯逻辑与 store）文案走 i18n，无硬编码中文', () => {
    for (const rel of ['src/shared/drag.ts', 'src/shared/drag-flow.ts', 'src/store/dragStore.ts']) {
      const source = read(rel)
      const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      const hanInCode = /['"`>][^'"`<]*[\u4e00-\u9fff][^'"`<]*['"`<]/.test(noComments)
      expect(hanInCode, rel).toBe(false)
    }
  })

  /*
   * 下面两条查的是**禁止形态**（断言某种写法不存在），不是「某函数名出现过」——
   * 后者会被注释满足（本项目已经吃过 14 次亏）。
   */
  it('渲染层不得自己拼 adb 命令 / 自己 spawn（拖拽必须复用传输队列）', () => {
    for (const rel of DRAG_SOURCES) {
      const source = read(rel)
      expect(source, rel).not.toMatch(/child_process/)
      expect(source, rel).not.toMatch(/spawn\(/)
      expect(source, rel).not.toMatch(/execFile/)
    }
  })

  it('渲染层不得直接调 webUtils（File→路径只能经 preload 暴露的 getPathForFile）', () => {
    for (const rel of DRAG_SOURCES) {
      // 先剥注释再判：这条查的是**代码形态**，注释里提到 webUtils 是解释而不是实现
      const source = read(rel)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      expect(source, rel).not.toMatch(/\bwebUtils\b/)
    }
  })
})
/*
 * 简报 R5 的**只能静态查**的那几条规则（禁止形态，注释无法满足：匹配前先剥注释）。
 *
 * 判断本身的门禁在别处，这里刻意**不**放任何 toContain(源码文本) 断言：
 *   - 自动消失与否         → tests/notice-auto-dismiss.test.ts（假时钟 20 条）
 *   - 结果条的样子         → tests/component-wiring.test.tsx（renderToStaticMarkup）
 *   - 菜单项 / 右键语义 / 夹取 → tests/context-menu.test.ts（表驱动 40 条）
 *   - 菜单的样子与定位      → tests/component-wiring.test.tsx
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('简报 R5：自动消失与右键菜单的静态契约', () => {
  const R5_SOURCES = [
    'src/shared/notice-auto-dismiss.ts',
    'src/shared/context-menu.ts',
    'src/components/ContextMenu.tsx',
    'src/components/OpDialog.tsx',
    'src/components/FileTable.tsx',
    'src/pages/FilesPage.tsx',
  ]

  it('新增源码不 import node 内置模块 / electron，且无 as any / @ts-ignore', () => {
    for (const rel of R5_SOURCES) {
      const source = read(rel)
      expect(source, rel).not.toMatch(/from ['"]node:/)
      expect(source, rel).not.toMatch(/require\(/)
      expect(source, rel).not.toMatch(/from ['"]electron['"]/)
      expect(source, rel).not.toMatch(/\bas\s+any\b/)
      expect(source, rel).not.toMatch(/@ts-ignore|@ts-expect-error/)
    }
  })

  it('新增组件与共享模块的文案全部走 i18n（无硬编码中文）', () => {
    for (const rel of ['src/components/ContextMenu.tsx', 'src/shared/context-menu.ts', 'src/shared/notice-auto-dismiss.ts']) {
      const source = stripComments(read(rel))
      const hanInCode = /['"`>][^'"`<]*[一-鿿][^'"`<]*['"`<]/.test(source)
      expect(hanInCode, rel).toBe(false)
    }
  })

  it('自动消失的判断不得写回组件（时长与判定都只能来自 shared）', () => {
    const dialog = stripComments(read('src/components/OpDialog.tsx'))
    // 禁止形态：组件里不得出现裸的 2000 字面量（时长只能来自 AUTO_DISMISS_MS）。
    // 注意**不**断言「组件里没有 summary.failed === 0」：OpResultNotice 用它选配色
    // （成功绿 / 失败红），那是纯展示判断，本来就该留在组件里；
    // 真正禁止的是拿它决定**要不要计时**，而那件事已经由下面这条「不排定时器」的
    // 行为用例矩阵覆盖（tests/notice-auto-dismiss.test.ts：失败结果 schedule 零调用）。
    expect(dialog).not.toMatch(/setTimeout\([^)]*,\s*2000\s*\)/)
  })

  it('右键菜单的取项与夹取不得写回组件', () => {
    const menu = stripComments(read('src/components/ContextMenu.tsx'))
    // 禁止形态：组件里自己按选中数决定菜单项 / 自己做翻转算术
    expect(menu).not.toMatch(/selectedCount\s*===\s*1/)
    expect(menu).not.toMatch(/point\.x\s*\+\s*width/)
  })

  it('右键的选中语义与菜单条数只在 shared 判定（FilesPage 只转发）', () => {
    const page = stripComments(read('src/pages/FilesPage.tsx'))
    // 禁止形态：页面里自己写「右键后选中数」（replace ? 1 : …）
    expect(page).not.toMatch(/replace\s*\?\s*1\s*:/)
    // 禁止形态：页面里自己按选中数量拼菜单项
    expect(page).not.toMatch(/id:\s*'rename'/)
    /*
     * 禁止形态：菜单条数不得直接取**渲染期**的 current.selected.length。
     *
     * 这条是变异实测补的：把
     *   menuItemsFor(selectedCountAfterContext(menu.name, current.selected))
     * 改成 menuItemsFor(current.selected.length) 后，全量仍然全绿
     * （组件里的取值 SSR 观测不到，而 selectedCountAfterContext 的单测只管纯函数本身）。
     * 后果很具体：右键一个未选中的行时，选中项已变成 1 但菜单仍按旧的 N 项算，
     * 「重命名」入口凭空消失。所以这里用**禁止形态**把它钉住。
     */
    expect(page).not.toMatch(/menuItemsFor\(current\.selected\.length\)/)
  })

  it('行的 mousedown 必须区分按键（右键不得塌缩多选）', () => {
    const table = stripComments(read('src/components/FileTable.tsx'))
    // 禁止形态：无条件在 mousedown 里 onSelect（右键也会发 mousedown）
    expect(table).not.toMatch(/onMouseDown=\{\(event\)\s*=>\s*\{\s*props\.onSelect\(/)
  })
})

describe('简报 R4：文件行焦点的静态契约（真单测见 tests/file-row.test.ts）', () => {
  /*
   * 【事项 3 的门禁分工】class 的**内容**由 tests/file-row.test.ts 直接断言返回值
   * （outline-none 必须存在、focus-visible:ring-1 必须存在、不得出现裸 ring）——
   * 那是真门禁：改坏实现就红。
   *
   * 而「FileTable 那一行到底有没有调用 rowClassName」发生在渲染期，本工程
   * environment: node、无 jsdom，SSR 也渲染不出虚拟列表（useVirtualizer 需要真实滚动容器），
   * 所以那段接线**没有门禁**，已如实登记进「已知无门禁清单」。
   *
   * 这里只加一条**禁止形态**（注释无法满足，因为匹配前先剥注释）：行的排版/状态 class
   * 不得再inline 回 FileTable —— 那正是修前导致黄框的写法。revert 到旧实现会立刻红。
   */
  it('行的 class 不得inline 回 FileTable（黄框修前就是那种写法）', () => {
    const table = read('src/components/FileTable.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    // 旧实现里的行 class 片段：cursor-default + 状态色直接拼在组件里
    expect(table).not.toMatch(/cursor-default/)
    expect(table).not.toMatch(/bg-neutral-200 text-neutral-900/)
    expect(table).not.toMatch(/outline-none/)
    expect(table).not.toMatch(/focus-visible:/)
  })
})
