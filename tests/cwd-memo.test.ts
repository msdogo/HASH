import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CWD,
  createFileView,
  fileViewReducer,
  viewFromPartial,
  type FileViewState,
} from '../src/shared/file-view'
import {
  createCwdMemo,
  createCwdRestore,
  firstCwdOf,
  openedAt,
  resolveRestoreCwd,
  type CwdRestoreDeps,
} from '../src/shared/cwd-memo'

/*
 * R9：按设备记住上次停留的目录 —— 纯逻辑门禁。
 *
 * 这里不碰 window.api / 不碰文件系统：**判断**全部收在 @shared/cwd-memo，
 * 逐条断言真实行为（不是源码文本）。存储层的真读写在 tests/settings-store.test.ts，
 * IPC 层在 tests/settings-ipc.test.ts。
 */

describe('R9：createFileView / viewFromPartial 接受初始目录（纯函数）', () => {
  it('不给初始目录 → /sdcard（布局与老行为一致）', () => {
    expect(createFileView().cwd).toBe(DEFAULT_CWD)
    expect(createFileView(undefined).cwd).toBe('/sdcard')
  })

  it('给了初始目录 → 用它，且其它字段仍是默认值', () => {
    const view = createFileView('/sdcard/DCIM')
    expect(view.cwd).toBe('/sdcard/DCIM')
    expect(view.status).toBe('idle')
    expect(view.loadedOnce).toBe(false)
    // 恢复提示默认不出现：没打开过任何目录时说「已回到 /sdcard」是假话
    expect(view.cwdFallback).toBe(false)
  })

  it('viewFromPartial 同样接受初始目录（分片还没建时的首帧）', () => {
    expect(viewFromPartial(undefined, '/sdcard/DCIM').cwd).toBe('/sdcard/DCIM')
    expect(viewFromPartial({}, '/sdcard/Download').cwd).toBe('/sdcard/Download')
    expect(viewFromPartial(undefined).cwd).toBe(DEFAULT_CWD)
  })

  it('分片里已有 cwd 时，viewFromPartial 的初始目录不覆盖它', () => {
    expect(viewFromPartial({ cwd: '/sdcard/Movies' }, '/sdcard/DCIM').cwd).toBe('/sdcard/Movies')
  })
})

describe('R9：resolveRestoreCwd 表驱动（有/无记录 × 成功/失败）', () => {
  const cases: Array<{
    name: string
    stored: string | undefined
    listOk: boolean
    cwd: string
    fallback: boolean
  }> = [
    { name: '有记录 + 列举成功 → 用记录，不提示', stored: '/sdcard/DCIM', listOk: true, cwd: '/sdcard/DCIM', fallback: false },
    { name: '有记录 + 列举失败 → 回退 /sdcard，提示', stored: '/sdcard/DCIM', listOk: false, cwd: '/sdcard', fallback: true },
    { name: '无记录 + 列举失败 → 回退 /sdcard，提示', stored: undefined, listOk: false, cwd: '/sdcard', fallback: true },
    { name: '无记录 + 列举成功 → /sdcard，不提示', stored: undefined, listOk: true, cwd: '/sdcard', fallback: false },
  ]

  for (const c of cases) {
    it(c.name, () => {
      expect(resolveRestoreCwd(c.stored, c.listOk)).toEqual({ cwd: c.cwd, fallback: c.fallback })
    })
  }

  it('空白记录当作没有记录（不当成目录名）', () => {
    expect(resolveRestoreCwd('   ', true)).toEqual({ cwd: DEFAULT_CWD, fallback: false })
    expect(resolveRestoreCwd('', true)).toEqual({ cwd: DEFAULT_CWD, fallback: false })
  })

  it('记录里的冗余写法会被归一化（尾斜杠 / 重复斜杠）', () => {
    expect(resolveRestoreCwd('/sdcard//DCIM/', true).cwd).toBe('/sdcard/DCIM')
  })

  it('firstCwdOf：有记录用记录，没有用 DEFAULT_CWD', () => {
    expect(firstCwdOf('/sdcard/DCIM')).toBe('/sdcard/DCIM')
    expect(firstCwdOf(undefined)).toBe(DEFAULT_CWD)
    expect(firstCwdOf('  ')).toBe(DEFAULT_CWD)
  })

  /* 表驱动的「两个输入都动一动」的补充：防止实现把 stored 或 listOk 其中一条写死 */
  it('同一条记录，列举结果不同 → 结论不同（listOk 真的参与判定）', () => {
    expect(resolveRestoreCwd('/sdcard/DCIM', true)).not.toEqual(resolveRestoreCwd('/sdcard/DCIM', false))
  })

  it('同一次列举成功，记录不同 → 落点不同（stored 真的参与判定）', () => {
    expect(resolveRestoreCwd('/sdcard/DCIM', true).cwd).toBe('/sdcard/DCIM')
    expect(resolveRestoreCwd('/sdcard/Movies', true).cwd).toBe('/sdcard/Movies')
  })
})

describe('R9：openedAt 判定「这次 openDir 真的进去了」', () => {
  const view = (over: Partial<{ cwd: string; status: string; loadedOnce: boolean }>) => ({
    cwd: '/sdcard/DCIM',
    status: 'ready',
    loadedOnce: true,
    ...over,
  })

  it('已加载 + ready + cwd 一致 → true', () => {
    expect(openedAt(view({}), '/sdcard/DCIM')).toBe(true)
  })

  it('cwd 归一化后比较（尾斜杠不影响判定）', () => {
    expect(openedAt(view({}), '/sdcard/DCIM/')).toBe(true)
    expect(openedAt(view({}), '/sdcard//DCIM')).toBe(true)
  })

  it('其它目录 → false（迟到的结果不算进去）', () => {
    expect(openedAt(view({}), '/sdcard/Movies')).toBe(false)
  })

  it('还没成功加载过 → false（首帧就是 idle，不能算成功）', () => {
    expect(openedAt(view({ loadedOnce: false, status: 'idle' }), '/sdcard/DCIM')).toBe(false)
    expect(openedAt(createFileView('/sdcard/DCIM'), '/sdcard/DCIM')).toBe(false)
  })

  it('加载失败后状态不是 ready → false（目录被删掉时 cwd 不前移）', () => {
    expect(openedAt(view({ status: 'error' }), '/sdcard/DCIM')).toBe(false)
    expect(openedAt(view({ status: 'loading' }), '/sdcard/DCIM')).toBe(false)
  })

  it('分片不存在 → false（不抛）', () => {
    expect(openedAt(undefined, '/sdcard/DCIM')).toBe(false)
  })
})

/* ============ 恢复流程（注入假依赖，断言真实调用顺序） ============ */

function restoreHarness(over: {
  stored?: string | undefined
  storedThrows?: boolean
  /** 哪些目录能打开（其余返回 false）。 */
  openable?: string[]
  /** 分片是否已经加载过（true = 切设备回来 / 重连）。 */
  alreadyLoaded?: boolean
} = {}) {
  const opened: string[] = []
  const seeded: Array<{ serial: string; cwd: string }> = []
  const fallbackMarked: string[] = []
  const reloaded: string[] = []
  const openable = new Set(over.openable ?? [])
  const deps: CwdRestoreDeps = {
    readStored: async () => {
      if (over.storedThrows === true) throw new Error('E_UNKNOWN')
      return over.stored
    },
    seed: (serial, cwd) => { seeded.push({ serial, cwd }) },
    openDir: async (_serial, dir) => {
      opened.push(dir)
      return openable.has(dir)
    },
    markFallback: (serial) => { fallbackMarked.push(serial) },
    isLoaded: () => over.alreadyLoaded === true,
    reload: (serial) => { reloaded.push(serial) },
  }
  return { restore: createCwdRestore(deps), opened, seeded, fallbackMarked, reloaded }
}

describe('R9：createCwdRestore 的恢复顺序与提示时机', () => {
  it('有记录 + 打得开 → 只列一次记录目录，不提示', async () => {
    const h = restoreHarness({ stored: '/sdcard/DCIM', openable: ['/sdcard/DCIM'] })
    const decision = await h.restore.restore('S1')
    expect(h.opened).toEqual(['/sdcard/DCIM'])
    expect(decision).toEqual({ cwd: '/sdcard/DCIM', fallback: false, restored: true })
    expect(h.fallbackMarked).toEqual([])
  })

  it('有记录 + 打不开 → 再列 /sdcard，回退成功才标记提示', async () => {
    const h = restoreHarness({ stored: '/sdcard/Gone', openable: ['/sdcard'] })
    const decision = await h.restore.restore('S1')
    expect(h.opened).toEqual(['/sdcard/Gone', '/sdcard'])
    expect(decision).toEqual({ cwd: '/sdcard', fallback: true, restored: true })
    expect(h.fallbackMarked).toEqual(['S1'])
  })

  it('有记录 + 都打不开 → 不标记提示（此时整页是错误态，说「已回到 /sdcard」是假话）', async () => {
    const h = restoreHarness({ stored: '/sdcard/Gone', openable: [] })
    const decision = await h.restore.restore('S1')
    expect(h.opened).toEqual(['/sdcard/Gone', '/sdcard'])
    expect(decision.fallback).toBe(true)
    expect(h.fallbackMarked).toEqual([])
  })

  it('无记录 → 直接列 /sdcard；打开成功时不提示', async () => {
    const h = restoreHarness({ stored: undefined, openable: ['/sdcard'] })
    await h.restore.restore('S1')
    expect(h.opened).toEqual(['/sdcard'])
    expect(h.fallbackMarked).toEqual([])
  })

  it('无记录 → 列 /sdcard 失败：提示（连默认目录都打不开，问题在设备侧）', async () => {
    const h = restoreHarness({ stored: undefined, openable: [] })
    await h.restore.restore('S1')
    expect(h.opened).toEqual(['/sdcard'])
    expect(h.fallbackMarked).toEqual(['S1'])
  })

  it('记录本身就是 /sdcard 且打不开：不重复列同一个目录，但仍然提示', async () => {
    const h = restoreHarness({ stored: '/sdcard/', openable: [] })
    await h.restore.restore('S1')
    expect(h.opened).toEqual(['/sdcard'])
    expect(h.fallbackMarked).toEqual(['S1'])
  })

  it('读记录抛错 → 当成没有记录，照常列 /sdcard（记忆坏了不该让文件页打不开）', async () => {
    const h = restoreHarness({ storedThrows: true, openable: ['/sdcard'] })
    const decision = await h.restore.restore('S1')
    expect(h.opened).toEqual(['/sdcard'])
    expect(decision).toEqual({ cwd: '/sdcard', fallback: false, restored: true })
  })

  it('seed 一定发生在第一次列举之前，且带的是将要打开的目录', async () => {
    const order: string[] = []
    const restore = createCwdRestore({
      readStored: async () => '/sdcard/DCIM',
      seed: (_serial, cwd) => { order.push('seed:' + cwd) },
      openDir: async (_serial, dir) => { order.push('open:' + dir); return dir === '/sdcard/DCIM' },
      markFallback: () => { order.push('fallback') },
      isLoaded: () => false,
      reload: () => { order.push('reload') },
    })
    await restore.restore('S1')
    expect(order).toEqual(['seed:/sdcard/DCIM', 'open:/sdcard/DCIM'])
  })

  it('seed 用的是归一化后的目录（面包屑不该显示 /sdcard//DCIM/）', async () => {
    const h = restoreHarness({ stored: '/sdcard//DCIM/', openable: ['/sdcard/DCIM'] })
    await h.restore.restore('S1')
    expect(h.seeded).toEqual([{ serial: 'S1', cwd: '/sdcard/DCIM' }])
    expect(h.opened).toEqual(['/sdcard/DCIM'])
  })

  /*
   * 切设备回来 / 掉线重连都会再走到这个 effect。分片还在、内容还在，
   * 这时若按记忆值再跳一次，用户会被从他正在看的地方拽走 ——
   * 所以只刷新，不跳转、不读取记录、也不提示。
   */
  it('分片已经加载过 → 只刷新，不跳转、不读记录、不提示', async () => {
    const h = restoreHarness({ stored: '/sdcard/DCIM', openable: ['/sdcard/DCIM'], alreadyLoaded: true })
    const outcome = await h.restore.restore('S1')
    expect(h.reloaded).toEqual(['S1'])
    expect(h.seeded).toEqual([])
    expect(h.opened).toEqual([])
    expect(h.fallbackMarked).toEqual([])
    expect(outcome.restored).toBe(false)
  })
})

/* ============ 写盘：fire-and-forget（裁决 A） ============ */

describe('R9：createCwdMemo 是 fire-and-forget（不阻塞、失败只 warn）', () => {
  it('remember 返回 undefined（同步完成）—— 调用方在结构上就不可能 await 它', () => {
    const writes: Array<[string, string]> = []
    const memo = createCwdMemo({ write: async (serial, cwd) => { writes.push([serial, cwd]) } })
    const returned: void = memo.remember('S1', '/sdcard/DCIM')
    expect(returned).toBeUndefined()
    expect(writes).toEqual([['S1', '/sdcard/DCIM']])
  })

  it('写盘 Promise 还没 settle，remember 就已经返回（UI 不会被它卡住）', () => {
    let resolveWrite: (() => void) | undefined
    let sawPending = false
    const memo = createCwdMemo({
      write: () => new Promise<void>((resolve) => { resolveWrite = resolve; sawPending = true }),
    })
    memo.remember('S1', '/sdcard/DCIM')
    // remember 返回时 write 仍在飞：若实现里 await 了，这里会是 false
    expect(sawPending).toBe(true)
    expect(resolveWrite).toBeTypeOf('function')
    resolveWrite?.()
  })

  it('写盘被拒绝 → 只 warn，不抛、不产生未处理 rejection', async () => {
    const warnings: string[] = []
    const memo = createCwdMemo({
      write: async () => { throw new Error('E_NO_SERIAL') },
      warn: (message) => { warnings.push(message) },
    })
    expect(() => memo.remember('S1', '/sdcard/DCIM')).not.toThrow()
    // 等到微任务队列排空：拒绝被 .catch 吃掉了，warn 已发生
    await Promise.resolve()
    await Promise.resolve()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('E_NO_SERIAL')
  })

  it('write 同步抛错 → 同样只 warn（preload 还没注入时就是这种）', () => {
    const warnings: string[] = []
    const memo = createCwdMemo({
      write: () => { throw new Error('window.api is not defined') },
      warn: (message) => { warnings.push(message) },
    })
    expect(() => memo.remember('S1', '/sdcard/DCIM')).not.toThrow()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('window.api')
  })

  it('没有设备 / 空目录 → 零调用（不产生垃圾记录）', () => {
    const writes: Array<[string, string]> = []
    const memo = createCwdMemo({ write: async (serial, cwd) => { writes.push([serial, cwd]) } })
    memo.remember(null, '/sdcard/DCIM')
    memo.remember('  ', '/sdcard/DCIM')
    memo.remember('S1', '   ')
    expect(writes).toEqual([])
  })

  it('多次成功进入目录 → 每次写一次（裁决 A：不防抖，只认最后一次的值）', () => {
    const writes: Array<[string, string]> = []
    const memo = createCwdMemo({ write: async (serial, cwd) => { writes.push([serial, cwd]) } })
    memo.remember('S1', '/sdcard')
    memo.remember('S1', '/sdcard/DCIM')
    memo.remember('S1', '/sdcard/DCIM/Camera')
    expect(writes).toEqual([
      ['S1', '/sdcard'],
      ['S1', '/sdcard/DCIM'],
      ['S1', '/sdcard/DCIM/Camera'],
    ])
  })

  it('两台设备互不影响（各自记各自的目录）', () => {
    const writes: Array<[string, string]> = []
    const memo = createCwdMemo({ write: async (serial, cwd) => { writes.push([serial, cwd]) } })
    memo.remember('A', '/sdcard/DCIM')
    memo.remember('B', '/sdcard/Download')
    expect(writes).toEqual([['A', '/sdcard/DCIM'], ['B', '/sdcard/Download']])
  })
})

/* ============ reducer：seedCwd 与 cwdFallback ============ */

describe('R9：reducer 的 seedCwd / cwdFallback 语义', () => {
  const reduce = (state: FileViewState, action: Parameters<typeof fileViewReducer>[1]) =>
    fileViewReducer(state, action)

  it('seedCwd 把待打开的目录先写进 cwd，且不置 loading、不发请求', () => {
    const view = reduce(createFileView(), { type: 'seedCwd', cwd: '/sdcard/DCIM' })
    expect(view.cwd).toBe('/sdcard/DCIM')
    expect(view.status).toBe('idle')
    expect(view.loadedOnce).toBe(false)
  })

  it('seedCwd 归一化路径', () => {
    expect(reduce(createFileView(), { type: 'seedCwd', cwd: '/sdcard//DCIM/' }).cwd).toBe('/sdcard/DCIM')
  })

  it('已经成功加载过的分片不被 seedCwd 覆盖（用户的导航历史比记忆值新）', () => {
    const loaded = reduce(createFileView(), {
      type: 'resolve',
      generation: 0,
      data: {
        dir: '/sdcard/Movies',
        entries: [],
        degraded: false,
        unparsed: 0,
        usedFallback: false,
        exitCode: 0,
        tzOffsetMinutes: 0,
      },
    })
    expect(loaded.loadedOnce).toBe(true)
    expect(reduce(loaded, { type: 'seedCwd', cwd: '/sdcard/DCIM' })).toBe(loaded)
  })

  it('seedCwd 值没变时返回原引用（不触发重渲染）', () => {
    const state = createFileView('/sdcard/DCIM')
    expect(reduce(state, { type: 'seedCwd', cwd: '/sdcard/DCIM' })).toBe(state)
  })

  it('cwdFallback 置位 / 可关闭，重复置位返回原引用', () => {
    const marked = reduce(createFileView(), { type: 'cwdFallback' })
    expect(marked.cwdFallback).toBe(true)
    expect(reduce(marked, { type: 'cwdFallback' })).toBe(marked)
    const dismissed = reduce(marked, { type: 'dismissCwdFallback' })
    expect(dismissed.cwdFallback).toBe(false)
    expect(reduce(dismissed, { type: 'dismissCwdFallback' })).toBe(dismissed)
  })

  it('用户主动导航会清掉回退提示（那条提示已经过期）', () => {
    const marked = reduce(createFileView('/sdcard'), { type: 'cwdFallback' })
    const navigated = reduce(marked, { type: 'navigate', cwd: '/sdcard/DCIM' })
    expect(navigated.cwdFallback).toBe(false)
  })

  it('resolve 不清掉回退提示（回退那次列举本身也要走 resolve）', () => {
    const marked = reduce(createFileView('/sdcard/DCIM'), { type: 'cwdFallback' })
    const navigated = reduce(marked, { type: 'navigate', cwd: '/sdcard' })
    // seed 之后 navigate 会清（用户/流程主动导航），这里直接构造一个已 mark 的 loading 态
    const loading = { ...navigated, cwdFallback: true }
    const resolved = reduce(loading, {
      type: 'resolve',
      generation: loading.generation,
      data: {
        dir: '/sdcard',
        entries: [],
        degraded: false,
        unparsed: 0,
        usedFallback: false,
        exitCode: 0,
        tzOffsetMinutes: 0,
      },
    })
    expect(resolved.cwdFallback).toBe(true)
  })
})
