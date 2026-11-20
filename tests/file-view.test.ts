import { describe, it, expect } from 'vitest'
import type { FileEntry } from '../src/shared/types'
import {
  MAX_LINK_HOPS,
  ROW_HEIGHT,
  compareByName,
  createFileView,
  createFileViewsModel,
  createLoadCoordinator,
  fileViewReducer,
  fileViewsReducer,
  filterEntries,
  formatMtime,
  formatSize,
  isDotEntry,
  isHiddenName,
  keyToSelectionAction,
  makeSelectAllHandler,
  rangeNames,
  selectModeOf,
  isMetaKnown,
  isOpenKey,
  joinEntryPath,
  navKeyCommand,
  normalizePath,
  noticeFromList,
  openTarget,
  parentOf,
  parseTypedPath,
  segmentsOf,
  sortEntries,
  summarizeEntries,
  viewFromPartial,
  viewOf,
  visibleEntries,
  type FileViewAction,
  type FileViews,
  type FileViewSlice,
  type FileViewState,
  type ListRequest,
  type ListResponse,
  type ListResultData,
} from '../src/shared/file-view'

/* ============ 测试夹具 ============ */

function entry(over: Partial<FileEntry> & { name: string }): FileEntry {
  return {
    name: over.name,
    isDir: over.isDir ?? false,
    isLink: over.isLink ?? false,
    size: over.size ?? 0,
    mtime: over.mtime ?? 0,
    mode: over.mode ?? '-rw-r--r--',
    owner: over.owner ?? 'u0_a104',
    group: over.group ?? 'u0_a104',
    linkTarget: over.linkTarget,
    linkTargetResolved: over.linkTargetResolved,
    metaKnown: over.metaKnown,
  }
}

const names = (list: readonly FileEntry[]): string[] => list.map((e) => e.name)

function listData(
  over: Partial<{
    dir: string
    entries: FileEntry[]
    degraded: boolean
    unparsed: number
    usedFallback: boolean
    exitCode: number | null
    tzOffsetMinutes: number
  }> = {},
) {
  return {
    dir: over.dir ?? '/sdcard',
    entries: over.entries ?? [],
    degraded: over.degraded ?? false,
    unparsed: over.unparsed ?? 0,
    usedFallback: over.usedFallback ?? false,
    exitCode: over.exitCode ?? 0,
    tzOffsetMinutes: over.tzOffsetMinutes ?? 480,
  }
}

function reduce(view: FileViewState, ...actions: FileViewAction[]): FileViewState {
  let next = view
  for (const action of actions) next = fileViewReducer(next, action)
  return next
}

/** 造一个「已经成功打开过 /sdcard/DCIM，有一条 a.jpg，选中并滚到 250px」的视图。 */
function loadedView(): FileViewState {
  return reduce(
    createFileView(),
    { type: 'navigate', cwd: '/sdcard/DCIM' },
    { type: 'resolve', generation: 1, data: listData({ dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' })] }) },
    { type: 'select', name: 'a.jpg', mode: 'replace' },
    { type: 'setScrollTop', value: 250 },
  )
}

/** 一万条随机条目：一半目录，size 与 mtime 随机；供排序性能测试用。 */
function bigDirectory(count: number): FileEntry[] {
  const out: FileEntry[] = []
  let seed = 987654321
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed
  }
  for (let i = 0; i < count; i++) {
    out.push(
      entry({
        name: 'entry-' + String(next() % 99991) + '-' + i,
        isDir: next() % 2 === 0,
        size: next() % 100000000,
        mtime: 1600000000000 + (next() % 90000000),
        metaKnown: next() % 50 !== 0,
      }),
    )
  }
  return out
}

/* ============ 裁决 5：. / .. 与隐藏文件 ============ */

describe('裁决 5：点目录与隐藏文件', () => {
  it('isDotEntry 只认 . 与 ..（不把 .nomedia 当点条目）', () => {
    expect(isDotEntry('.')).toBe(true)
    expect(isDotEntry('..')).toBe(true)
    expect(isDotEntry('.nomedia')).toBe(false)
    expect(isDotEntry('...')).toBe(false)
    expect(isDotEntry('a')).toBe(false)
  })

  it('isHiddenName 认 . 开头的普通名字（. / .. 不算隐藏项）', () => {
    expect(isHiddenName('.nomedia')).toBe(true)
    expect(isHiddenName('.thumbnails')).toBe(true)
    expect(isHiddenName('.')).toBe(false)
    expect(isHiddenName('..')).toBe(false)
    expect(isHiddenName('a.txt')).toBe(false)
  })

  it('后端真的返回了 . 与 .. 时，前端也必须过滤掉（不显示怪条目）', () => {
    const entries = [entry({ name: '.' }), entry({ name: '..' }), entry({ name: 'a.txt' })]
    expect(names(filterEntries(entries, { showHidden: true }))).toEqual(['a.txt'])
    expect(names(filterEntries(entries, { showHidden: false }))).toEqual(['a.txt'])
  })

  it('隐藏文件默认不显示，开关打开后显示', () => {
    const entries = [entry({ name: '.nomedia' }), entry({ name: 'a.txt' }), entry({ name: '.thumbnails', isDir: true })]
    expect(names(filterEntries(entries, { showHidden: false }))).toEqual(['a.txt'])
    expect(names(filterEntries(entries, { showHidden: true }))).toEqual(['.nomedia', 'a.txt', '.thumbnails'])
  })

  it('过滤不修改入参数组', () => {
    const entries = [entry({ name: '.' }), entry({ name: '.x' }), entry({ name: 'a' })]
    const before = names(entries)
    filterEntries(entries, { showHidden: false })
    expect(names(entries)).toEqual(before)
  })
})

/* ============ 裁决 1：metaKnown 语义 ============ */

describe('裁决 1：metaKnown 决定「未知」而不是 1970', () => {
  it('metaKnown 缺省视为已知（来自真实 ls 输出）', () => {
    expect(isMetaKnown(entry({ name: 'a' }))).toBe(true)
    expect(isMetaKnown(entry({ name: 'a', metaKnown: true }))).toBe(true)
    expect(isMetaKnown(entry({ name: 'a', metaKnown: false }))).toBe(false)
  })

  it('metaKnown=false：大小与时间都显示「未知」（返回 null 由界面映射文案）', () => {
    const unknown = entry({ name: 'x.bin', size: 0, mtime: 0, metaKnown: false })
    expect(formatSize(unknown)).toBeNull()
    expect(formatMtime(unknown, 480)).toBeNull()
  })

  it('metaKnown=true 且 mtime=0 是【真实】的 1970，必须照常显示日期而不是「未知」', () => {
    const real1970 = entry({ name: 'acct', mtime: 0, metaKnown: true })
    expect(formatMtime(real1970, 480)).toBe('1970-01-01 08:00')
    expect(formatMtime(real1970, 0)).toBe('1970-01-01 00:00')
  })

  it('size=0 的已知条目显示 0 B，不是「未知」', () => {
    expect(formatSize(entry({ name: 'empty.txt', size: 0 }))).toBe('0 B')
  })
})

/* ============ I1（审查轮 1）：名称排序不受 metaKnown 污染 ============ */

describe('I1：三种排序下的完整顺序（混知已知/未知条目）', () => {
  /**
   * 混合数据集：两个目录 + 三个文件，其中 a.bin 的元数据未知。
   * 名称是**永远已知**的字段，所以按名称排序时 a.bin 必须回到名字该在的位置
   * （审查发现：修前它被 metaKnown 规则推到所有已知文件之后，a.bin 排到了 z.txt 后面）。
   */
  const mixed = (): FileEntry[] => [
    entry({ name: 'z.txt', size: 1, mtime: 100 }),
    entry({ name: 'a.bin', size: 0, mtime: 0, metaKnown: false }),
    // 第二个未知项：没有它时，按名称【降序】无法区分「正确实现」与「被 metaKnown 污染的旧实现」
    // （两者都把未知项甩到最后）。加一个名字靠后的未知项后，正确实现里它应排第一，
    // 而被污染的实现会把它排到所有已知文件之后 —— 这才是一条真正的护栏。
    entry({ name: 'zz.bin', size: 0, mtime: 0, metaKnown: false }),
    entry({ name: 'm.txt', size: 5, mtime: 200 }),
    entry({ name: 'zdir', isDir: true, mtime: 50 }),
    entry({ name: 'adir', isDir: true, mtime: 300 }),
  ]

  it('按名称升序：目录在前，未知的 a.bin / zz.bin 回到名字该在的位置', () => {
    expect(names(sortEntries(mixed(), 'name', 'asc'))).toEqual(['adir', 'zdir', 'a.bin', 'm.txt', 'z.txt', 'zz.bin'])
  })

  it('按名称降序：未知的 zz.bin 排第一（若被 metaKnown 污染会掉到所有已知文件之后）', () => {
    expect(names(sortEntries(mixed(), 'name', 'desc'))).toEqual(['zdir', 'adir', 'zz.bin', 'z.txt', 'm.txt', 'a.bin'])
  })

  it('按大小升序：未知项恒排最后（不因 size=0 挤到最前）', () => {
    expect(names(sortEntries(mixed(), 'size', 'asc'))).toEqual(['adir', 'zdir', 'z.txt', 'm.txt', 'a.bin', 'zz.bin'])
  })

  it('按大小降序：未知项依然最后', () => {
    expect(names(sortEntries(mixed(), 'size', 'desc'))).toEqual(['adir', 'zdir', 'm.txt', 'z.txt', 'a.bin', 'zz.bin'])
  })

  it('按时间升序：未知项恒排最后', () => {
    // 目录也按时间比：zdir(50) 在 adir(300) 之前 —— 目录分组只保证「目录在文件前」，不冻结目录内顺序
    expect(names(sortEntries(mixed(), 'time', 'asc'))).toEqual(['zdir', 'adir', 'z.txt', 'm.txt', 'a.bin', 'zz.bin'])
  })

  it('按时间降序：未知项依然最后', () => {
    expect(names(sortEntries(mixed(), 'time', 'desc'))).toEqual(['adir', 'zdir', 'm.txt', 'z.txt', 'a.bin', 'zz.bin'])
  })

  it('目录内部也按同名规则排序（未知目录不会被赶后）', () => {
    const list = [
      entry({ name: 'd2', isDir: true, metaKnown: false }),
      entry({ name: 'd1', isDir: true }),
    ]
    expect(names(sortEntries(list, 'name', 'asc'))).toEqual(['d1', 'd2'])
    // 按大小排序时未知目录排在已知目录之后（未知不是「很小」）
    expect(names(sortEntries(list, 'size', 'asc'))).toEqual(['d1', 'd2'])
  })
})

/* ============ 排序与格式化 ============ */

describe('排序', () => {
  it('目录恒在文件之前（与升降序无关）', () => {
    const list = [
      entry({ name: 'z.txt' }),
      entry({ name: 'adir', isDir: true }),
      entry({ name: 'a.txt' }),
      entry({ name: 'bdir', isDir: true }),
    ]
    expect(names(sortEntries(list, 'name', 'asc'))).toEqual(['adir', 'bdir', 'a.txt', 'z.txt'])
    expect(names(sortEntries(list, 'name', 'desc'))).toEqual(['bdir', 'adir', 'z.txt', 'a.txt'])
  })

  it('名称排序数字自然序（file2 在 file10 之前）', () => {
    const list = [entry({ name: 'file10.txt' }), entry({ name: 'file2.txt' }), entry({ name: 'file1.txt' })]
    expect(names(sortEntries(list, 'name', 'asc'))).toEqual(['file1.txt', 'file2.txt', 'file10.txt'])
  })

  it('中文名可排序且不抛错', () => {
    const list = [entry({ name: '测试音频.opus' }), entry({ name: '阿凡达.mp4' })]
    const sorted = sortEntries(list, 'name', 'asc')
    expect(sorted).toHaveLength(2)
    expect(new Set(names(sorted))).toEqual(new Set(['测试音频.opus', '阿凡达.mp4']))
  })

  it('同 size 时用名称做确定性的次级排序', () => {
    const list = [entry({ name: 'b.bin', size: 5 }), entry({ name: 'a.bin', size: 5 })]
    expect(names(sortEntries(list, 'size', 'desc'))).toEqual(['a.bin', 'b.bin'])
  })

  it('排序不修改入参数组，且返回新数组', () => {
    const list = [entry({ name: 'b' }), entry({ name: 'a' })]
    const before = names(list)
    const sorted = sortEntries(list, 'name', 'asc')
    expect(names(list)).toEqual(before)
    expect(sorted).not.toBe(list)
  })

  it('compareByName 提供稳定的大小写不敏感比较', () => {
    expect(compareByName('a.txt', 'b.txt')).toBeLessThan(0)
    expect(compareByName('B', 'a')).toBeGreaterThan(0)
    expect(compareByName('same', 'same')).toBe(0)
  })
})

describe('格式化', () => {
  it('大小按 1024 进位', () => {
    expect(formatSize(entry({ name: 'a', size: 0 }))).toBe('0 B')
    expect(formatSize(entry({ name: 'a', size: 512 }))).toBe('512 B')
    expect(formatSize(entry({ name: 'a', size: 1024 }))).toBe('1.0 KB')
    expect(formatSize(entry({ name: 'a', size: 1536 }))).toBe('1.5 KB')
    expect(formatSize(entry({ name: 'a', size: 1048576 }))).toBe('1.0 MB')
    expect(formatSize(entry({ name: 'a', size: 5 * 1024 ** 3 }))).toBe('5.0 GB')
  })

  it('时间按设备时区显示（与宿主时区无关）', () => {
    const e = entry({ name: 'a', mtime: Date.UTC(2026, 10, 18, 8, 54), metaKnown: true })
    expect(formatMtime(e, 480)).toBe('2026-11-18 16:54')
    expect(formatMtime(e, 0)).toBe('2026-11-18 08:54')
    expect(formatMtime(e, -210)).toBe('2026-11-18 05:24')
  })

  it('summarizeEntries 统计目录与文件数', () => {
    const list = [entry({ name: 'a', isDir: true }), entry({ name: 'b' }), entry({ name: 'c' })]
    expect(summarizeEntries(list)).toEqual({ dirs: 1, files: 2, total: 3 })
    expect(summarizeEntries([])).toEqual({ dirs: 0, files: 0, total: 0 })
  })

  it('ROW_HEIGHT 是虚拟滚动的固定行高（与 estimateSize / CSS 共用）', () => {
    expect(ROW_HEIGHT).toBe(34)
  })
})

/* ============ 裁决 4：排序性能 ============ */

/*
 * 性能断言取【多次里的最好一次】（best-of-N）。
 *
 * 为什么不能只量一次：vitest 默认并行跑测试文件，机器一忙 GC/调度抖动就能让
 * 单次测量翻好几倍。任务 8 加了传输用例后这条开始偶发假红（实测：单独跑必过、
 * 全量并行偶挂），而排序代码一个字符都没改 —— 典型的测量噪声，不是性能回归。
 *
 * 取最好一次仍然是有意义的护栏：真正的算法劣化（例如把 Collator 从模块级缓存
 * 改成每次比较新建）会让【每一次】都变慢，最小值照样超阈值。
 */
const PERF_RUNS = 5

function bestOfSortMs(list: ReturnType<typeof bigDirectory>, sort: 'name' | 'size', dir: 'asc' | 'desc'): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < PERF_RUNS; i++) {
    const start = performance.now()
    const sorted = sortEntries(list, sort, dir)
    const elapsed = performance.now() - start
    expect(sorted).toHaveLength(list.length)
    if (elapsed < best) best = elapsed
  }
  return best
}

describe('裁决 4：万级条目排序性能', () => {
  it('1 万条按名称排序 < 100ms', () => {
    expect(bestOfSortMs(bigDirectory(10_000), 'name', 'asc')).toBeLessThan(100)
  })

  it('1 万条按大小排序 < 100ms', () => {
    expect(bestOfSortMs(bigDirectory(10_000), 'size', 'desc')).toBeLessThan(100)
  })

  /* 【审查 M】这条原来还是单次测量 —— 上一条改成 best-of-N 后漏了它，
   * 并行负载下同样会偶发假红。口径统一，理由同 bestOfSortMs 的注释。 */
  it('1 万条按时间排序 + 过滤 < 100ms', () => {
    const list = bigDirectory(10_000)
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < PERF_RUNS; i++) {
      const start = performance.now()
      const sorted = sortEntries(filterEntries(list, { showHidden: false }), 'time', 'asc')
      const elapsed = performance.now() - start
      expect(sorted.length).toBeGreaterThan(0)
      if (elapsed < best) best = elapsed
    }
    expect(best).toBeLessThan(100)
  })
})

/* ============ 裁决 6：路径与面包屑 ============ */

describe('裁决 6：路径解析与面包屑', () => {
  it('normalizePath 折叠重复斜杠、去掉尾斜杠、消掉点段', () => {
    expect(normalizePath('/sdcard//DCIM/')).toBe('/sdcard/DCIM')
    expect(normalizePath('/sdcard/./DCIM')).toBe('/sdcard/DCIM')
    expect(normalizePath('/sdcard/x/../DCIM')).toBe('/sdcard/DCIM')
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('//')).toBe('/')
    expect(normalizePath('')).toBe('/')
  })

  it("'..' 在根处被夹住，绝不逃出根", () => {
    expect(normalizePath('/..')).toBe('/')
    expect(normalizePath('/a/../..')).toBe('/')
  })

  it('relative 写法补前导斜杠', () => {
    expect(normalizePath('sdcard/DCIM')).toBe('/sdcard/DCIM')
  })

  it('segmentsOf 给出每一层的名字与可跳转路径（从根开始）', () => {
    expect(segmentsOf('/')).toEqual([{ name: '/', path: '/' }])
    expect(segmentsOf('/sdcard/DCIM/Camera')).toEqual([
      { name: '/', path: '/' },
      { name: 'sdcard', path: '/sdcard' },
      { name: 'DCIM', path: '/sdcard/DCIM' },
      { name: 'Camera', path: '/sdcard/DCIM/Camera' },
    ])
    expect(segmentsOf('/sdcard//DCIM/')).toEqual([
      { name: '/', path: '/' },
      { name: 'sdcard', path: '/sdcard' },
      { name: 'DCIM', path: '/sdcard/DCIM' },
    ])
  })

  it('joinEntryPath 拼子路径（名字里带空格中文也不变形）', () => {
    expect(joinEntryPath('/sdcard', 'DCIM')).toBe('/sdcard/DCIM')
    expect(joinEntryPath('/', 'sdcard')).toBe('/sdcard')
    expect(joinEntryPath('/sdcard/Download', "测试 文件'1'.txt")).toBe("/sdcard/Download/测试 文件'1'.txt")
  })

  it('parentOf 回到上一层，根没有上一层', () => {
    expect(parentOf('/sdcard/DCIM')).toBe('/sdcard')
    expect(parentOf('/sdcard')).toBe('/')
    expect(parentOf('/')).toBeNull()
  })

  it('parseTypedPath 接受绝对与相对写法并归一化', () => {
    expect(parseTypedPath('/sdcard/DCIM/')).toEqual({ ok: true, path: '/sdcard/DCIM' })
    expect(parseTypedPath('  /sdcard/DCIM  ')).toEqual({ ok: true, path: '/sdcard/DCIM' })
    expect(parseTypedPath('sdcard/DCIM')).toEqual({ ok: true, path: '/sdcard/DCIM' })
    expect(parseTypedPath('/')).toEqual({ ok: true, path: '/' })
  })

  it('parseTypedPath 拒绝空串/纯空白/含控制字符的路径（行内报错用）', () => {
    expect(parseTypedPath('')).toEqual({ ok: false, code: 'E_INVALID_PATH' })
    expect(parseTypedPath('    ')).toEqual({ ok: false, code: 'E_INVALID_PATH' })
    expect(parseTypedPath('/sdcard/a\nb')).toEqual({ ok: false, code: 'E_INVALID_PATH' })
    expect(parseTypedPath('/sdcard/a\u0000b')).toEqual({ ok: false, code: 'E_INVALID_PATH' })
    expect(parseTypedPath('/sdcard/a\rb')).toEqual({ ok: false, code: 'E_INVALID_PATH' })
  })
})

/* ============ 裁决 3：degraded / exitCode 提示 ============ */

describe('裁决 3：降级与退出码 -> 提示条', () => {
  it('干净结果（degraded=false, exitCode=0）没有提示', () => {
    expect(noticeFromList({ degraded: false, unparsed: 0, usedFallback: false, exitCode: 0 })).toBeNull()
  })

  it('exitCode 为 null 且未降级也没有提示', () => {
    expect(noticeFromList({ degraded: false, unparsed: 0, usedFallback: false, exitCode: null })).toBeNull()
  })

  it('degraded=true 给出可关闭提示，带未解析条数', () => {
    expect(noticeFromList({ degraded: true, unparsed: 7, usedFallback: true, exitCode: 0 })).toEqual({
      degraded: true,
      unparsed: 7,
      usedFallback: true,
      exitCode: 0,
    })
  })

  it('exitCode 非 0 但有条目（/proc 半可读）也给出提示', () => {
    expect(noticeFromList({ degraded: false, unparsed: 0, usedFallback: false, exitCode: 1 })).toEqual({
      degraded: false,
      unparsed: 0,
      usedFallback: false,
      exitCode: 1,
    })
  })
})

/* ============ 视图状态：初始值与导航 ============ */

describe('视图状态：初始值', () => {
  it('默认停在 /sdcard，按名称升序，隐藏文件关闭，未加载', () => {
    const view = createFileView()
    expect(view.cwd).toBe('/sdcard')
    expect(view.sort).toBe('name')
    expect(view.sortDir).toBe('asc')
    expect(view.showHidden).toBe(false)
    expect(view.status).toBe('idle')
    expect(view.entries).toEqual([])
    expect(view.selected).toEqual([])
    expect(view.scrollTop).toBe(0)
    expect(view.generation).toBe(0)
    expect(view.pendingCwd).toBeNull()
    expect(view.linkTrail).toEqual([])
    expect(view.loadedOnce).toBe(false)
  })
})

describe('C1（审查轮 1）：导航只在成功后提交 cwd', () => {
  it('navigate 只登记待加载目标，不清空当前目录 / 条目 / 选中 / 滚动', () => {
    const loaded = loadedView()
    const pending = reduce(loaded, { type: 'navigate', cwd: '/sdcard/Download' })
    expect(pending.pendingCwd).toBe('/sdcard/Download')
    expect(pending.cwd).toBe('/sdcard/DCIM')
    expect(names(pending.entries)).toEqual(['a.jpg'])
    expect(pending.selected).toEqual(['a.jpg'])
    expect(pending.scrollTop).toBe(250)
    expect(pending.status).toBe('loading')
    expect(pending.generation).toBe(loaded.generation + 1)
  })

  it('跳转失败：cwd / entries / selected / scrollTop 全部不变，addressError 有值', () => {
    const loaded = loadedView()
    const failed = reduce(
      loaded,
      { type: 'navigate', cwd: '/nope' },
      { type: 'fail', generation: loaded.generation + 1, code: 'E_NOT_FOUND' },
    )
    expect(failed.cwd).toBe('/sdcard/DCIM')
    expect(names(failed.entries)).toEqual(['a.jpg'])
    expect(failed.selected).toEqual(['a.jpg'])
    expect(failed.scrollTop).toBe(250)
    expect(failed.addressError).toBe('E_NOT_FOUND')
    expect(failed.status).toBe('ready')
    expect(failed.pendingCwd).toBeNull()
  })

  it('跳转成功后才提交 cwd；换目录会清空选中并重置滚动', () => {
    const loaded = loadedView()
    const done = reduce(
      loaded,
      { type: 'navigate', cwd: '/sdcard/Download' },
      { type: 'resolve', generation: loaded.generation + 1, data: listData({ dir: '/sdcard/Download', entries: [entry({ name: 'b.zip' })] }) },
    )
    expect(done.cwd).toBe('/sdcard/Download')
    expect(names(done.entries)).toEqual(['b.zip'])
    expect(done.selected).toEqual([])
    expect(done.scrollTop).toBe(0)
    expect(done.pendingCwd).toBeNull()
    expect(done.loadedOnce).toBe(true)
  })

  it('从未成功加载过的首次失败才显示整页错误态（有内容时绝不清空）', () => {
    const first = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/nope' },
      { type: 'fail', generation: 1, code: 'E_NOT_FOUND' },
    )
    expect(first.status).toBe('error')
    expect(first.error).toBe('E_NOT_FOUND')
    expect(first.entries).toEqual([])
  })

  it('地址栏非法输入只写行内错误，不动当前目录', () => {
    const loaded = loadedView()
    const withError = reduce(loaded, { type: 'addressError', code: 'E_INVALID_PATH' })
    expect(withError.addressError).toBe('E_INVALID_PATH')
    expect(withError.cwd).toBe('/sdcard/DCIM')
    expect(names(withError.entries)).toEqual(['a.jpg'])
    const next = reduce(withError, { type: 'navigate', cwd: '/sdcard/Download' })
    expect(next.addressError).toBeNull()
  })
})

/* ============ I2（审查轮 1）：刷新后的 selected 必须清理 ============ */

describe('I2：selected 不与条目脱节', () => {
  it('同目录刷新：selected 与新条目求交集（消失的条目不再被选中）', () => {
    const loaded = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/sdcard/DCIM' },
      { type: 'resolve', generation: 1, data: listData({ dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' }), entry({ name: 'gone.jpg' })] }) },
      { type: 'select', name: 'a.jpg', mode: 'replace' },
      { type: 'select', name: 'gone.jpg', mode: 'toggle' },
    )
    expect(loaded.selected).toEqual(['a.jpg', 'gone.jpg'])

    const refreshed = reduce(
      loaded,
      { type: 'beginLoad' },
      { type: 'resolve', generation: loaded.generation + 1, data: listData({ dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' })] }) },
    )
    expect(refreshed.selected).toEqual(['a.jpg'])
  })

  it('同目录刷新：仍然存在的选中项保留，滚动位置保留', () => {
    const loaded = loadedView()
    const refreshed = reduce(
      loaded,
      { type: 'beginLoad' },
      { type: 'resolve', generation: loaded.generation + 1, data: listData({ dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' })] }) },
    )
    expect(refreshed.selected).toEqual(['a.jpg'])
    expect(refreshed.scrollTop).toBe(250)
  })

  it('换目录成功：selected 清空（不对看不见的条目执行操作）', () => {
    const loaded = loadedView()
    const moved = reduce(
      loaded,
      { type: 'navigate', cwd: '/sdcard/Download' },
      { type: 'resolve', generation: loaded.generation + 1, data: listData({ dir: '/sdcard/Download', entries: [entry({ name: 'a.jpg' })] }) },
    )
    expect(moved.selected).toEqual([])
  })
})

/* ============ 裁决 2：过期响应必须丢弃 ============ */

describe('裁决 2：过期响应必须丢弃（A 先请求、B 后请求、A 后到）', () => {
  it('先请求 A 再请求 B，A 的结果晚到也不能覆盖 B 的内容', () => {
    let view = reduce(createFileView(), { type: 'navigate', cwd: '/A' })
    expect(view.generation).toBe(1)
    view = reduce(view, { type: 'navigate', cwd: '/B' })
    expect(view.generation).toBe(2)
    view = reduce(view, { type: 'resolve', generation: 2, data: listData({ dir: '/B', entries: [entry({ name: 'b.txt' })] }) })
    expect(names(view.entries)).toEqual(['b.txt'])
    const stale = reduce(view, { type: 'resolve', generation: 1, data: listData({ dir: '/A', entries: [entry({ name: 'a.txt' })] }) })
    expect(names(stale.entries)).toEqual(['b.txt'])
    expect(stale.cwd).toBe('/B')
    expect(stale.status).toBe('ready')
    expect(stale).toBe(view)
  })

  it('过期请求的失败也不能把当前目录打成错误态', () => {
    let view = reduce(createFileView(), { type: 'navigate', cwd: '/A' })
    view = reduce(view, { type: 'navigate', cwd: '/B' })
    view = reduce(view, { type: 'resolve', generation: 2, data: listData({ dir: '/B', entries: [entry({ name: 'b.txt' })] }) })
    const stale = reduce(view, { type: 'fail', generation: 1, code: 'E_NOT_FOUND' })
    expect(stale).toBe(view)
    expect(stale.error).toBeNull()
    expect(stale.status).toBe('ready')
  })
})

describe('视图状态：结果与错误', () => {
  it('resolve 写入条目、目录、时区与降级提示，状态变 ready', () => {
    const view = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/sdcard/DCIM' },
      {
        type: 'resolve',
        generation: 1,
        data: listData({ dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' })], degraded: true, unparsed: 3, usedFallback: true, exitCode: 0 }),
      },
    )
    expect(view.status).toBe('ready')
    expect(view.entries).toHaveLength(1)
    expect(view.tzOffsetMinutes).toBe(480)
    expect(view.notice).toEqual({ degraded: true, unparsed: 3, usedFallback: true, exitCode: 0 })
    expect(view.error).toBeNull()
  })

  it('提示条可关闭，关闭后不再出现（直到下一次加载）', () => {
    const view = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/proc/1' },
      { type: 'resolve', generation: 1, data: listData({ dir: '/proc/1', degraded: false, exitCode: 1 }) },
      { type: 'dismissNotice' },
    )
    expect(view.noticeDismissed).toBe(true)
    const reloaded = reduce(view, { type: 'beginLoad' })
    expect(reloaded.noticeDismissed).toBe(false)
  })

  it('已有条目时刷新失败：保留列表 + 顶部错误提示，不整页变错误', () => {
    const loaded = loadedView()
    const failed = reduce(loaded, { type: 'beginLoad' }, { type: 'fail', generation: loaded.generation + 1, code: 'E_TIMEOUT' })
    expect(failed.status).toBe('ready')
    expect(names(failed.entries)).toEqual(['a.jpg'])
    expect(failed.error).toBe('E_TIMEOUT')
  })
})

describe('视图状态：排序、隐藏文件、选中、滚动', () => {
  it('点同一列在升降序之间切换，换列回到升序', () => {
    let view = reduce(createFileView(), { type: 'setSort', sort: 'name' })
    expect(view.sortDir).toBe('desc')
    view = reduce(view, { type: 'setSort', sort: 'size' })
    expect(view.sort).toBe('size')
    expect(view.sortDir).toBe('asc')
  })

  it('切换隐藏文件展示', () => {
    const view = reduce(createFileView(), { type: 'setShowHidden', value: true })
    expect(view.showHidden).toBe(true)
  })

  it('点击选中：replace 替换、toggle 按存在与否增删', () => {
    let view = reduce(createFileView(), { type: 'select', name: 'a', mode: 'replace' })
    expect(view.selected).toEqual(['a'])
    view = reduce(view, { type: 'select', name: 'b', mode: 'toggle' })
    expect(view.selected).toEqual(['a', 'b'])
    view = reduce(view, { type: 'select', name: 'a', mode: 'toggle' })
    expect(view.selected).toEqual(['b'])
    view = reduce(view, { type: 'select', name: 'c', mode: 'replace' })
    expect(view.selected).toEqual(['c'])
  })

  it('滚动位置写入状态（切设备回来要恢复）', () => {
    const view = reduce(createFileView(), { type: 'setScrollTop', value: 1234 })
    expect(view.scrollTop).toBe(1234)
  })
})

/* ============ 裁决 7：每设备独立视图 ============ */

describe('裁决 7：每设备独立视图（按 serial 分片）', () => {
  it('两台设备各自 setCwd / 条目 / 滚动位置互不影响', () => {
    let views = fileViewsReducer({}, { serial: 'A', type: 'navigate', cwd: '/sdcard/DCIM' })
    views = fileViewsReducer(views, { serial: 'B', type: 'navigate', cwd: '/sdcard/Download' })
    views = fileViewsReducer(views, { serial: 'A', type: 'resolve', generation: 1, data: listData({ dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' })] }) })
    views = fileViewsReducer(views, { serial: 'B', type: 'resolve', generation: 1, data: listData({ dir: '/sdcard/Download', entries: [entry({ name: 'b.zip' })] }) })
    views = fileViewsReducer(views, { serial: 'A', type: 'setScrollTop', value: 900 })
    views = fileViewsReducer(views, { serial: 'A', type: 'select', name: 'a.jpg', mode: 'replace' })

    expect(views.A.cwd).toBe('/sdcard/DCIM')
    expect(views.B.cwd).toBe('/sdcard/Download')
    expect(names(views.A.entries)).toEqual(['a.jpg'])
    expect(names(views.B.entries)).toEqual(['b.zip'])
    expect(views.A.scrollTop).toBe(900)
    expect(views.A.selected).toEqual(['a.jpg'])
    expect(views.B.scrollTop).toBe(0)
    expect(views.B.selected).toEqual([])
  })

  it('未知 serial 首次访问自动建默认视图', () => {
    const views = fileViewsReducer({}, { serial: 'NEW', type: 'beginLoad' })
    expect(views.NEW.cwd).toBe('/sdcard')
    expect(views.NEW.generation).toBe(1)
  })

  it('无变化的 action 保持整个 views 对象的引用（不触发无谓重渲染）', () => {
    const views = fileViewsReducer({}, { serial: 'A', type: 'navigate', cwd: '/A' })
    const same = fileViewsReducer(views, { serial: 'A', type: 'resolve', generation: 0, data: listData({ dir: '/stale' }) })
    expect(same).toBe(views)
  })
})

/* ============ 分片默认值（编译期收窄 + 运行期兜底） ============ */

describe('viewFromPartial：分片默认值', () => {
  it('undefined / 空对象都给出完整 slice（entries 必须是数组）', () => {
    for (const input of [undefined, {}, { cwd: '/sdcard/DCIM' }]) {
      const view = viewFromPartial(input)
      expect(Array.isArray(view.entries), String(input)).toBe(true)
      expect(view.entries).toEqual([])
      expect(Array.isArray(view.selected)).toBe(true)
      expect(typeof view.cwd).toBe('string')
    }
  })

  it('半桶水对象能补齐：已有字段保持，缺的回落默认值', () => {
    const partial: Partial<FileViewSlice> = {
      cwd: '/sdcard/Download',
      sort: 'size',
      sortDir: 'desc',
      showHidden: true,
      entries: [entry({ name: 'a.zip' })],
      status: 'ready',
      error: null,
      addressError: null,
      notice: null,
      noticeDismissed: false,
      tzOffsetMinutes: 480,
      selected: ['a.zip'],
    }
    const view = viewFromPartial(partial)
    expect(view.cwd).toBe('/sdcard/Download')
    expect(view.sort).toBe('size')
    expect(view.showHidden).toBe(true)
    expect(names(view.entries)).toEqual(['a.zip'])
    expect(view.selected).toEqual(['a.zip'])
  })

  it('slice 里【没有】generation / scrollTop（避免后来者写 current.generation 静默拿到 0）', () => {
    const view = viewFromPartial({ cwd: '/sdcard' })
    expect('generation' in view).toBe(false)
    expect('scrollTop' in view).toBe(false)
  })

  it('visibleEntries 能吃 viewFromPartial 的结果（首帧不会炸 entries is not iterable）', () => {
    const view = viewFromPartial({ cwd: '/sdcard' })
    expect(() => visibleEntries(view.entries, { showHidden: false, sort: view.sort, sortDir: view.sortDir })).not.toThrow()
    expect(visibleEntries(view.entries, { showHidden: false, sort: 'name', sortDir: 'asc' })).toEqual([])
  })
})

/* ============ 裁决 2：加载协调器 ============ */

function harness() {
  let views: FileViews = {}
  const requests: ListRequest[] = []
  const pending: Array<{ request: ListRequest; resolve: (value: ListResponse) => void }> = []
  const coordinator = createLoadCoordinator({
    get: (serial) => viewOf(views, serial),
    dispatch: (serial, action) => {
      views = fileViewsReducer(views, { ...action, serial })
    },
    fetch: (request) => {
      requests.push(request)
      return new Promise<ListResponse>((resolve) => {
        pending.push({ request, resolve })
      })
    },
  })
  return {
    coordinator,
    requests,
    pending,
    get views(): FileViews {
      return views
    },
    dispatch: (serial: string, action: FileViewAction): void => {
      views = fileViewsReducer(views, { ...action, serial })
    },
    resolveAt: (index: number, data: Partial<ListResultData> & { dir: string }): void => {
      pending[index].resolve({ ok: true, data: listData(data) })
    },
    failAt: (index: number, code: string): void => {
      pending[index].resolve({ ok: false, error: code })
    },
  }
}

describe('裁决 2：加载协调器', () => {
  it('先请求 A 再请求 B，A 的结果晚到也不能覆盖 B', async () => {
    const h = harness()
    h.dispatch('S', { type: 'navigate', cwd: '/A' })
    const loadA = h.coordinator.load('S')
    h.dispatch('S', { type: 'navigate', cwd: '/B' })
    const loadB = h.coordinator.load('S')
    expect(h.requests.map((r) => r.dir)).toEqual(['/A', '/B'])

    h.resolveAt(1, { dir: '/B', entries: [entry({ name: 'b.txt' })] })
    await loadB
    expect(names(h.views.S.entries)).toEqual(['b.txt'])
    expect(h.views.S.cwd).toBe('/B')

    h.resolveAt(0, { dir: '/A', entries: [entry({ name: 'a.txt' })] })
    await loadA
    expect(names(h.views.S.entries)).toEqual(['b.txt'])
    expect(h.views.S.cwd).toBe('/B')
    expect(h.views.S.status).toBe('ready')
  })

  it('过期请求的失败也不会把当前目录打到错误态', async () => {
    const h = harness()
    h.dispatch('S', { type: 'navigate', cwd: '/A' })
    const loadA = h.coordinator.load('S')
    h.dispatch('S', { type: 'navigate', cwd: '/B' })
    const loadB = h.coordinator.load('S')
    h.resolveAt(1, { dir: '/B', entries: [entry({ name: 'b.txt' })] })
    await loadB
    h.failAt(0, 'E_NOT_FOUND')
    await loadA
    expect(h.views.S.error).toBeNull()
    expect(h.views.S.addressError).toBeNull()
    expect(h.views.S.status).toBe('ready')
  })

  it('I5：同一目录的并发/连点刷新只发一次请求（去重键是 serial+dir）', async () => {
    const h = harness()
    const first = h.coordinator.load('S')
    const second = h.coordinator.load('S')
    h.dispatch('S', { type: 'beginLoad' })
    const third = h.coordinator.load('S')
    const fourth = h.coordinator.load('S')
    expect(h.requests).toHaveLength(1)
    h.resolveAt(0, { dir: '/sdcard', entries: [entry({ name: 'x' })] })
    await Promise.all([first, second, third, fourth])
    expect(names(h.views.S.entries)).toEqual(['x'])
    expect(h.views.S.status).toBe('ready')
    expect(h.coordinator.inflight()).toBe(0)
  })

  it('加载完成后在飞表清空，可以再次加载', async () => {
    const h = harness()
    const first = h.coordinator.load('S')
    h.resolveAt(0, { dir: '/sdcard', entries: [] })
    await first
    expect(h.coordinator.inflight()).toBe(0)
    const second = h.coordinator.load('S')
    expect(h.requests).toHaveLength(2)
    h.resolveAt(1, { dir: '/sdcard', entries: [entry({ name: 'y' })] })
    await second
    expect(names(h.views.S.entries)).toEqual(['y'])
  })

  it('裁决 7：两台设备并发加载各写各的分片，互不覆盖', async () => {
    const h = harness()
    h.dispatch('A', { type: 'navigate', cwd: '/sdcard/DCIM' })
    h.dispatch('B', { type: 'navigate', cwd: '/sdcard/Download' })
    const loadA = h.coordinator.load('A')
    const loadB = h.coordinator.load('B')
    expect(h.requests).toEqual([
      { serial: 'A', dir: '/sdcard/DCIM' },
      { serial: 'B', dir: '/sdcard/Download' },
    ])
    h.resolveAt(1, { dir: '/sdcard/Download', entries: [entry({ name: 'b.zip' })] })
    await loadB
    h.resolveAt(0, { dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' })] })
    await loadA
    expect(names(h.views.A.entries)).toEqual(['a.jpg'])
    expect(names(h.views.B.entries)).toEqual(['b.zip'])
    expect(h.views.A.cwd).toBe('/sdcard/DCIM')
    expect(h.views.B.cwd).toBe('/sdcard/Download')
  })

  it('fetch 抛异常时收敛成错误态而不是未处理的 rejection', async () => {
    let views: FileViews = {}
    const coordinator = createLoadCoordinator({
      get: (serial) => viewOf(views, serial),
      dispatch: (serial, action) => {
        views = fileViewsReducer(views, { ...action, serial })
      },
      fetch: () => Promise.reject(new Error('boom')),
    })
    await coordinator.load('S')
    expect(views.S.status).toBe('error')
    expect(views.S.error).toBe('E_UNKNOWN')
  })
})

/* ============ I4（审查轮 1）：链接目录可以进入 ============ */

describe('I4：条目点击后的导航目标（含链接目录与防环）', () => {
  it('普通目录：进入 join(cwd, name)', () => {
    expect(openTarget(entry({ name: 'DCIM', isDir: true }), '/sdcard', [])).toEqual({
      kind: 'enter',
      path: '/sdcard/DCIM',
      followedLink: false,
    })
  })

  it('链接目录（有 linkTargetResolved）：进入解析后的目标，标记 followedLink', () => {
    // 真机最常见的入口：/sdcard 是符号链接 -> /storage/self/primary
    const link = entry({
      name: 'sdcard',
      isLink: true,
      isDir: false,
      linkTarget: '/storage/self/primary',
      linkTargetResolved: '/storage/self/primary',
    })
    expect(openTarget(link, '/', [])).toEqual({
      kind: 'enter',
      path: '/storage/self/primary',
      followedLink: true,
    })
  })

  it('相对目标的链接：用解析后的绝对路径', () => {
    const link = entry({
      name: 'downloads',
      isLink: true,
      linkTarget: 'Download',
      linkTargetResolved: '/sdcard/Download',
    })
    expect(openTarget(link, '/sdcard', [])).toMatchObject({ kind: 'enter', path: '/sdcard/Download' })
  })

  it('链接无法解析目标：给出 E_LINK_UNRESOLVED，而不是静默无反应', () => {
    const link = entry({ name: 'weird', isLink: true })
    expect(openTarget(link, '/data/local/tmp', [])).toEqual({ kind: 'error', code: 'E_LINK_UNRESOLVED' })
  })

  it('普通文件：noop（双击文件不该改变目录）', () => {
    expect(openTarget(entry({ name: 'a.txt' }), '/sdcard', [])).toEqual({ kind: 'noop', reason: 'file' })
  })

  it('防环：目标已在已访问轨迹里 -> E_LINK_CYCLE', () => {
    const link = entry({ name: 'loop', isLink: true, linkTargetResolved: '/a' })
    expect(openTarget(link, '/', ['/a'])).toEqual({ kind: 'error', code: 'E_LINK_CYCLE' })
  })

  it('防环：自己指向自己 / 指向当前目录也算环', () => {
    const self = entry({ name: 'here', isLink: true, linkTargetResolved: '/sdcard' })
    expect(openTarget(self, '/sdcard', [])).toEqual({ kind: 'error', code: 'E_LINK_CYCLE' })
  })

  it('防环：跳数达到上限后不再跟随', () => {
    // 审查轮 2 / N2 之后，跳数上限由显式的 hops 计数判定（trail 长度不再兼任计数器，
    // 因为它还存着「出发目录」，长度天然是跳数的两倍）。这里同步改成传 hops。
    const trail = Array.from({ length: MAX_LINK_HOPS * 2 }, (_, i) => '/l' + i)
    const link = entry({ name: 'n', isLink: true, linkTargetResolved: '/fresh' })
    expect(openTarget(link, '/', trail, MAX_LINK_HOPS)).toEqual({ kind: 'error', code: 'E_LINK_CYCLE' })
    // 未达上限时仍可跟随
    expect(openTarget(link, '/', trail, MAX_LINK_HOPS - 1)).toMatchObject({ kind: 'enter' })
  })

  it('跟随链接时把目标登记进轨迹（供下一次点击做环检测）', () => {
    const link = entry({ name: 'sdcard', isLink: true, linkTargetResolved: '/storage/self/primary' })
    const result = openTarget(link, '/', [])
    expect(result).toMatchObject({ kind: 'enter', followedLink: true })
    if (result.kind !== 'enter') throw new Error('expected enter')
    const trail = ['/storage/self/primary']
    // 在这个目标目录里再点一个指回 / 的链接 → 环
    const back = entry({ name: 'back', isLink: true, linkTargetResolved: '/' })
    expect(openTarget(back, result.path, trail)).toEqual({ kind: 'enter', path: '/', followedLink: true })
  })
})

/* ============ I7（审查轮 1）：键盘操作 ============ */

describe('I7：键盘命令', () => {
  it('Backspace 回上一级；根目录下无动作', () => {
    expect(navKeyCommand('Backspace', '/sdcard/DCIM')).toEqual({ kind: 'up', path: '/sdcard' })
    expect(navKeyCommand('Backspace', '/sdcard')).toEqual({ kind: 'up', path: '/' })
    expect(navKeyCommand('Backspace', '/')).toEqual({ kind: 'none' })
  })

  it('F5 刷新', () => {
    expect(navKeyCommand('F5', '/sdcard')).toEqual({ kind: 'refresh' })
  })

  it('其它键不拦截（输入框里的方向键等不该被吞掉）', () => {
    expect(navKeyCommand('ArrowDown', '/sdcard')).toEqual({ kind: 'none' })
    expect(navKeyCommand('a', '/sdcard')).toEqual({ kind: 'none' })
    expect(navKeyCommand('Enter', '/sdcard')).toEqual({ kind: 'none' })
  })

  it('isOpenKey 只认 Enter（空格留给未来的多选）', () => {
    expect(isOpenKey('Enter')).toBe(true)
    expect(isOpenKey(' ')).toBe(false)
    expect(isOpenKey('Escape')).toBe(false)
  })
})

/* ============ I5 / I6（审查轮 1）：模型层（forget / tombstone / LRU / 去重） ============ */

function modelHarness(options: { maxSerials?: number } = {}) {
  const requests: ListRequest[] = []
  const pending: Array<{ request: ListRequest; resolve: (value: ListResponse) => void }> = []
  let latest: FileViews = {}
  const model = createFileViewsModel({
    fetch: (request) => {
      requests.push(request)
      return new Promise<ListResponse>((resolve) => {
        pending.push({ request, resolve })
      })
    },
    onChange: (views) => {
      latest = views
    },
    maxSerials: options.maxSerials,
  })
  return {
    model,
    requests,
    pending,
    get views(): FileViews {
      return model.getViews()
    },
    get notified(): FileViews {
      return latest
    },
    resolveAt: (index: number, data: Partial<ListResultData> & { dir: string }): void => {
      pending[index].resolve({ ok: true, data: listData(data) })
    },
    failAt: (index: number, code: string): void => {
      pending[index].resolve({ ok: false, error: code })
    },
  }
}

describe('I5：连点刷新与 forget 语义', () => {
  it('连点三次刷新只发一次请求（同 serial + 同目录的在飞请求复用）', async () => {
    const h = modelHarness()
    const first = h.model.refresh('S')
    const second = h.model.refresh('S')
    const third = h.model.refresh('S')
    expect(h.requests).toHaveLength(1)
    h.resolveAt(0, { dir: '/sdcard', entries: [entry({ name: 'x' })] })
    await Promise.all([first, second, third])
    expect(names(h.views.S.entries)).toEqual(['x'])
    expect(h.model.inflight()).toBe(0)
  })

  it('不同目录才发新请求（去重按目录，而不是把新目录也复用掉）', async () => {
    const h = modelHarness()
    const a = h.model.openDir('S', '/A')
    const b = h.model.openDir('S', '/B')
    expect(h.requests.map((r) => r.dir)).toEqual(['/A', '/B'])
    h.resolveAt(1, { dir: '/B', entries: [entry({ name: 'b' })] })
    await b
    h.resolveAt(0, { dir: '/A', entries: [entry({ name: 'a' })] })
    await a
    expect(h.views.S.cwd).toBe('/B')
    expect(names(h.views.S.entries)).toEqual(['b'])
  })

  it('forget 后迟到的响应不会复活分片（tombstone）', async () => {
    const h = modelHarness()
    const load = h.model.openDir('S', '/sdcard')
    expect(h.views.S).toBeDefined()
    h.model.forget('S')
    expect(h.views.S).toBeUndefined()
    h.resolveAt(0, { dir: '/sdcard', entries: [entry({ name: 'ghost' })] })
    await load
    expect(h.views.S).toBeUndefined()
    expect(h.model.serials()).toEqual([])
  })

  it('forget 后迟到的失败也不会复活分片', async () => {
    const h = modelHarness()
    const load = h.model.load('S')
    h.model.forget('S')
    h.failAt(0, 'E_NOT_FOUND')
    await load
    expect(h.views.S).toBeUndefined()
  })

  it('设备重新出现时 ensure 清掉 tombstone，可以正常加载', async () => {
    const h = modelHarness()
    const load = h.model.openDir('S', '/sdcard')
    h.model.forget('S')
    h.resolveAt(0, { dir: '/sdcard', entries: [] })
    await load
    expect(h.views.S).toBeUndefined()

    h.model.ensure('S')
    expect(h.views.S).toBeDefined()
    const again = h.model.openDir('S', '/sdcard')
    expect(h.requests).toHaveLength(2)
    h.resolveAt(1, { dir: '/sdcard', entries: [entry({ name: 'back' })] })
    await again
    expect(names(h.views.S.entries)).toEqual(['back'])
  })

  it('分片数量有上限（LRU 淘汰），内存不会随设备数单调增长', async () => {
    const h = modelHarness({ maxSerials: 3 })
    for (const serial of ['A', 'B', 'C', 'D']) {
      h.model.ensure(serial)
      const load = h.model.openDir(serial, '/sdcard')
      h.resolveAt(h.requests.length - 1, { dir: '/sdcard', entries: [entry({ name: serial + '.bin' })] })
      await load
    }
    const serials = h.model.serials()
    expect(serials.length).toBeLessThanOrEqual(3)
    expect(serials).toContain('D')
    expect(serials).not.toContain('A')
  })

  it('C1（模型层）：openDir 到失败路径后当前目录与列表完全不变，行内有错误', async () => {
    const h = modelHarness()
    const first = h.model.openDir('S', '/sdcard/DCIM')
    h.resolveAt(0, { dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' })] })
    await first
    h.model.dispatch('S', { type: 'select', name: 'a.jpg', mode: 'replace' })
    h.model.dispatch('S', { type: 'setScrollTop', value: 250 })

    const bad = h.model.openDir('S', '/sdcard/NOPE')
    h.failAt(1, 'E_NOT_FOUND')
    await bad

    const view = h.views.S
    expect(view.cwd).toBe('/sdcard/DCIM')
    expect(names(view.entries)).toEqual(['a.jpg'])
    expect(view.selected).toEqual(['a.jpg'])
    expect(view.scrollTop).toBe(250)
    expect(view.addressError).toBe('E_NOT_FOUND')
    expect(view.status).toBe('ready')
  })

  it('C1（模型层）：跳转成功后 cwd 才更新', async () => {
    const h = modelHarness()
    const first = h.model.openDir('S', '/sdcard/DCIM')
    h.resolveAt(0, { dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' })] })
    await first

    const target = h.model.openDir('S', '/sdcard/Download')
    expect(h.views.S.cwd).toBe('/sdcard/DCIM') // 还没成功，不提交
    expect(h.views.S.pendingCwd).toBe('/sdcard/Download')
    h.resolveAt(1, { dir: '/sdcard/Download', entries: [entry({ name: 'b.zip' })] })
    await target
    expect(h.views.S.cwd).toBe('/sdcard/Download')
    expect(h.views.S.pendingCwd).toBeNull()
  })

  it('模型把每次变更通知出去（zustand 据此同步）', async () => {
    const h = modelHarness()
    const load = h.model.openDir('S', '/sdcard')
    h.resolveAt(0, { dir: '/sdcard', entries: [entry({ name: 'a' })] })
    await load
    expect(h.notified.S).toBeDefined()
    expect(names(h.notified.S.entries)).toEqual(['a'])
  })

  it('ensure 对已存在的分片是幂等的（不重置已加载内容）', async () => {
    const h = modelHarness()
    const load = h.model.openDir('S', '/sdcard/DCIM')
    h.resolveAt(0, { dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' })] })
    await load
    h.model.ensure('S')
    expect(h.views.S.cwd).toBe('/sdcard/DCIM')
    expect(names(h.views.S.entries)).toEqual(['a.jpg'])
  })
})
/* ============ N1（审查轮 2）：同目录导航不得卡在 loading ============ */

describe('N1：导航到当前目录不得置 loading', () => {
  it('reducer：navigate 到当前目录且已加载过 → 原样返回（不置 loading、不推进代次）', () => {
    const loaded = loadedView()
    expect(loaded.status).toBe('ready')
    const same = reduce(loaded, { type: 'navigate', cwd: loaded.cwd })
    expect(same).toBe(loaded)
    expect(same.status).toBe('ready')
    expect(same.generation).toBe(loaded.generation)
  })

  it('reducer：navigate 到当前目录的等价写法（尾斜杠/重复斜杠）也不置 loading', () => {
    const loaded = loadedView()
    for (const variant of ['/sdcard/DCIM/', '/sdcard//DCIM', '/sdcard/./DCIM', '/sdcard/DCIM/.']) {
      expect(reduce(loaded, { type: 'navigate', cwd: variant }).status, variant).toBe('ready')
    }
  })

  it('reducer：尚未加载过时，navigate 到当前目录仍然要置 loading（真的需要请求）', () => {
    const fresh = createFileView() // cwd=/sdcard, loadedOnce=false
    const next = reduce(fresh, { type: 'navigate', cwd: '/sdcard' })
    expect(next.status).toBe('loading')
    expect(next.generation).toBe(1)
  })

  it('model：点当前层面包屑不发新请求，且 status 保持 ready', async () => {
    const h = modelHarness()
    const first = h.model.openDir('S', '/sdcard/DCIM')
    h.resolveAt(0, { dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' })] })
    await first
    expect(h.requests).toHaveLength(1)

    // 点当前层面包屑 / 地址栏输入当前路径
    await h.model.openDir('S', '/sdcard/DCIM')
    expect(h.requests).toHaveLength(1) // 没有新请求
    const view = h.views.S
    expect(view.status).toBe('ready')
    expect(view.pendingCwd).toBeNull()
  })

  it('model：同目录导航后立刻再刷新仍能正常工作（状态没被卡死）', async () => {
    const h = modelHarness()
    const first = h.model.openDir('S', '/sdcard/DCIM')
    h.resolveAt(0, { dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' })] })
    await first
    await h.model.openDir('S', '/sdcard/DCIM')
    const reload = h.model.refresh('S')
    expect(h.requests).toHaveLength(2)
    h.resolveAt(1, { dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' }), entry({ name: 'b.jpg' })] })
    await reload
    expect(names(h.views.S.entries)).toEqual(['a.jpg', 'b.jpg'])
  })
})
/* ============ N2（审查轮 2）：linkTrail 必须真正接上 ============ */

describe('N2：链接轨迹与跳数上限必须真的生效', () => {
  const linkEntry = (name: string, target: string): FileEntry =>
    entry({ name, isLink: true, linkTarget: target, linkTargetResolved: target })

  it('进入链接并成功后，轨迹里记录了「从哪来 + 到哪去」', () => {
    const next = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/data/local/tmp/t7a' },
      { type: 'resolve', generation: 1, data: listData({ dir: '/data/local/tmp/t7a', entries: [] }) },
      { type: 'navigate', cwd: '/data/local/tmp/t7b', linkTarget: '/data/local/tmp/t7b' },
      { type: 'resolve', generation: 2, data: listData({ dir: '/data/local/tmp/t7b', entries: [] }) },
    )
    expect(next.linkTrail).toEqual(['/data/local/tmp/t7a', '/data/local/tmp/t7b'])
    expect(next.linkHops).toBe(1)
  })

  it('A→B→A 两跳环被拦（轨迹里已有 A）', () => {
    expect(
      openTarget(linkEntry('linka', '/data/local/tmp/t7a'), '/data/local/tmp/t7b', [
        '/data/local/tmp/t7a',
        '/data/local/tmp/t7b',
      ], 1),
    ).toEqual({ kind: 'error', code: 'E_LINK_CYCLE' })
  })

  it('导航到普通目录（面包屑/子目录）会重置轨迹与跳数', () => {
    const loaded = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/data/local/tmp/t7a' },
      { type: 'resolve', generation: 1, data: listData({ dir: '/data/local/tmp/t7a', entries: [] }) },
      { type: 'navigate', cwd: '/data/local/tmp/t7b', linkTarget: '/data/local/tmp/t7b' },
      { type: 'resolve', generation: 2, data: listData({ dir: '/data/local/tmp/t7b', entries: [] }) },
    )
    expect(loaded.linkTrail.length).toBeGreaterThan(0)
    const normal = reduce(loaded, { type: 'navigate', cwd: '/sdcard/DCIM' })
    expect(normal.linkTrail).toEqual([])
    expect(normal.linkHops).toBe(0)
  })

  it('合法的两级链接不被误拦（/sdcard → /storage/self/primary → /mnt/user/0/primary）', () => {
    const hop1 = openTarget(linkEntry('sdcard', '/storage/self/primary'), '/', [], 0)
    expect(hop1).toEqual({ kind: 'enter', path: '/storage/self/primary', followedLink: true })
    const hop2 = openTarget(
      linkEntry('primary', '/mnt/user/0/primary'),
      '/storage/self/primary',
      ['/', '/storage/self/primary'],
      1,
    )
    expect(hop2).toEqual({ kind: 'enter', path: '/mnt/user/0/primary', followedLink: true })
  })

  it('跳数上限真的累加：达到 MAX_LINK_HOPS 后拒绝继续跟随', () => {
    const link = linkEntry('deep', '/some/fresh/path')
    expect(openTarget(link, '/x', ['/1', '/2'], MAX_LINK_HOPS - 1)).toMatchObject({ kind: 'enter' })
    expect(openTarget(link, '/x', ['/1', '/2'], MAX_LINK_HOPS)).toEqual({ kind: 'error', code: 'E_LINK_CYCLE' })
  })

  it('轨迹有硬上限（不会无限增长吃内存）', () => {
    let view = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/start' },
      { type: 'resolve', generation: 1, data: listData({ dir: '/start', entries: [] }) },
    )
    for (let i = 0; i < 20; i++) {
      view = reduce(view, { type: 'navigate', cwd: '/hop' + i, linkTarget: '/hop' + i })
      view = reduce(view, { type: 'resolve', generation: view.generation, data: listData({ dir: '/hop' + i, entries: [] }) })
    }
    expect(view.linkTrail.length).toBeLessThanOrEqual(MAX_LINK_HOPS * 2)
  })

  it('model：真实点击链路 A→B→A 被拦，cwd 不变且给行内错误', async () => {
    const h = modelHarness()
    const enterA = h.model.openDir('S', '/data/local/tmp/t7a')
    h.resolveAt(0, { dir: '/data/local/tmp/t7a', entries: [linkEntry('linkb', '/data/local/tmp/t7b')] })
    await enterA

    const enterB = h.model.openDir('S', '/data/local/tmp/t7b', '/data/local/tmp/t7b')
    h.resolveAt(1, { dir: '/data/local/tmp/t7b', entries: [linkEntry('linka', '/data/local/tmp/t7a')] })
    await enterB
    expect(h.views.S.cwd).toBe('/data/local/tmp/t7b')
    expect(h.views.S.linkHops).toBe(1)

    const target = openTarget(linkEntry('linka', '/data/local/tmp/t7a'), h.views.S.cwd, h.views.S.linkTrail, h.views.S.linkHops)
    expect(target).toEqual({ kind: 'error', code: 'E_LINK_CYCLE' })
    h.model.dispatch('S', { type: 'addressError', code: 'E_LINK_CYCLE' })
    expect(h.views.S.cwd).toBe('/data/local/tmp/t7b')
    expect(h.views.S.addressError).toBe('E_LINK_CYCLE')
  })
})

/* ============ M1（审查轮 3）：失败跟随不得污染轨迹 ============ */

describe('M1：跟随失败不累积轨迹，后续合法链接仍能进入', () => {
  const linkEntry = (name: string, target: string): FileEntry =>
    entry({ name, isLink: true, linkTarget: target, linkTargetResolved: target })

  async function enterBaseline(h: ReturnType<typeof modelHarness>) {
    const enter = h.model.openDir('S', '/data/local/tmp/t7x')
    h.resolveAt(0, { dir: '/data/local/tmp/t7x', entries: [] })
    await enter
    expect(h.views.S.loadedOnce).toBe(true)
  }

  async function failFollows(h: ReturnType<typeof modelHarness>, times: number) {
    let index = 1
    for (let i = 0; i < times; i++) {
      const bad = h.model.openDir('S', '/data/local/tmp/broken', '/data/local/tmp/broken')
      h.failAt(index, 'E_NOT_A_DIRECTORY')
      index += 1
      await bad
    }
  }

  it('连续 MAX_LINK_HOPS 次失败跟随后，轨迹与跳数仍干净', async () => {
    const h = modelHarness()
    await enterBaseline(h)
    await failFollows(h, MAX_LINK_HOPS)
    expect(h.views.S.linkHops).toBe(0)
    expect(h.views.S.linkTrail).toEqual([])
    expect(h.views.S.cwd).toBe('/data/local/tmp/t7x')
  })

  it('连续 MAX_LINK_HOPS 次失败跟随后，合法链接仍能进入（不被误判为环）', async () => {
    const h = modelHarness()
    await enterBaseline(h)
    await failFollows(h, MAX_LINK_HOPS)

    const real = linkEntry('realdir', '/data/local/tmp/real')
    const target = openTarget(real, h.views.S.cwd, h.views.S.linkTrail, h.views.S.linkHops)
    expect(target).toEqual({ kind: 'enter', path: '/data/local/tmp/real', followedLink: true })

    const ok = h.model.openDir('S', '/data/local/tmp/real', '/data/local/tmp/real')
    h.resolveAt(h.requests.length - 1, { dir: '/data/local/tmp/real', entries: [] })
    await ok
    expect(h.views.S.cwd).toBe('/data/local/tmp/real')
    expect(h.views.S.linkHops).toBe(1)
  })

  it('reducer：navigate（跟随）不写轨迹，成功 resolve 后才提交', () => {
    const base = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/data/local/tmp/t7a' },
      { type: 'resolve', generation: 1, data: listData({ dir: '/data/local/tmp/t7a', entries: [] }) },
    )
    const pending = reduce(base, { type: 'navigate', cwd: '/data/local/tmp/t7b', linkTarget: '/data/local/tmp/t7b' })
    expect(pending.linkTrail).toEqual([])
    expect(pending.linkHops).toBe(0)
    expect(pending.pendingLink).toEqual({ from: '/data/local/tmp/t7a', to: '/data/local/tmp/t7b' })

    const done = reduce(pending, { type: 'resolve', generation: pending.generation, data: listData({ dir: '/data/local/tmp/t7b', entries: [] }) })
    expect(done.linkTrail).toEqual(['/data/local/tmp/t7a', '/data/local/tmp/t7b'])
    expect(done.linkHops).toBe(1)
    expect(done.pendingLink).toBeNull()
  })

  it('reducer：失败时丢弃待提交项，轨迹与跳数保持干净', () => {
    const base = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/data/local/tmp/t7a' },
      { type: 'resolve', generation: 1, data: listData({ dir: '/data/local/tmp/t7a', entries: [] }) },
    )
    const pending = reduce(base, { type: 'navigate', cwd: '/data/local/tmp/broken', linkTarget: '/data/local/tmp/broken' })
    const failed = reduce(pending, { type: 'fail', generation: pending.generation, code: 'E_NOT_A_DIRECTORY' })
    expect(failed.linkTrail).toEqual([])
    expect(failed.linkHops).toBe(0)
    expect(failed.pendingLink).toBeNull()
    expect(failed.cwd).toBe('/data/local/tmp/t7a')
    expect(failed.addressError).toBe('E_NOT_A_DIRECTORY')
  })

  it('多次失败后跳数不会涨到上限（防止把合法链接误判为环）', () => {
    let view = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/start' },
      { type: 'resolve', generation: 1, data: listData({ dir: '/start', entries: [] }) },
    )
    for (let i = 0; i < MAX_LINK_HOPS * 3; i++) {
      view = reduce(view, { type: 'navigate', cwd: '/broken' + i, linkTarget: '/broken' + i })
      view = reduce(view, { type: 'fail', generation: view.generation, code: 'E_NOT_A_DIRECTORY' })
    }
    expect(view.linkHops).toBe(0)
    expect(view.linkTrail).toEqual([])
  })
})

/* ============ N3（审查轮 2 回归护栏）：淘汰必须立 tombstone ============ */

describe('N3：LRU 淘汰不得被在飞响应复活', () => {
  it('被淘汰的分片不会被迟到的响应复活（淘汰 = forget：立 tombstone + reset 协调器）', async () => {
    const h = modelHarness({ maxSerials: 2 })
    const loadA = h.model.openDir('A', '/sdcard')
    h.model.ensure('B')
    h.model.ensure('C')
    expect(h.model.serials()).not.toContain('A')
    expect(h.views.A).toBeUndefined()

    h.resolveAt(0, { dir: '/sdcard', entries: [entry({ name: 'ghost' })] })
    await loadA
    expect(h.views.A).toBeUndefined()
    expect(h.model.serials()).not.toContain('A')
    expect(Object.keys(h.views).length).toBeLessThanOrEqual(2)
  })

  it('在线设备不会被淘汰（裁决 7：切回各自恢复）', () => {
    const h = modelHarness({ maxSerials: 2 })
    h.model.syncDevices(['A', 'B'])
    h.model.ensure('D')
    h.model.syncDevices(['A', 'B'])
    expect(h.views.A).toBeDefined()
    expect(h.views.B).toBeDefined()
    expect(h.views.D).toBeUndefined()
  })
})

/* ============ 多选增强（问题 2）：三态选中 / 区间 / 全选 / Esc ============ */

describe('多选增强：修饰键 → 选中语义', () => {
  it('Shift 优先于 Ctrl/Cmd，无修饰键是 replace', () => {
    expect(selectModeOf({})).toBe('replace')
    expect(selectModeOf({ ctrlKey: true })).toBe('toggle')
    expect(selectModeOf({ metaKey: true })).toBe('toggle')
    expect(selectModeOf({ shiftKey: true })).toBe('range')
    expect(selectModeOf({ shiftKey: true, ctrlKey: true })).toBe('range')
    expect(selectModeOf({ shiftKey: true, metaKey: true })).toBe('range')
  })
})

describe('多选增强：三种 mode 的 reducer 行为', () => {
  /** 已加载的视图：四个文件，entries 原始顺序是 d/b/a/c，展示顺序（名称升序）是 a/b/c/d。 */
  function fourFiles(): FileViewState {
    return reduce(
      createFileView(),
      { type: 'navigate', cwd: '/sdcard/DCIM' },
      {
        type: 'resolve',
        generation: 1,
        data: listData({
          dir: '/sdcard/DCIM',
          entries: [entry({ name: 'd' }), entry({ name: 'b' }), entry({ name: 'a' }), entry({ name: 'c' })],
        }),
      },
    )
  }

  it('replace：只选目标，anchor 落到目标', () => {
    const view = reduce(fourFiles(), { type: 'select', name: 'c', mode: 'replace' })
    expect(view.selected).toEqual(['c'])
    expect(view.anchor).toBe('c')
  })

  it('toggle：在已有选择上增删，anchor 跟随到本次点击的行', () => {
    let view = reduce(fourFiles(), { type: 'select', name: 'a', mode: 'replace' })
    view = reduce(view, { type: 'select', name: 'c', mode: 'toggle' })
    expect(view.selected).toEqual(['a', 'c'])
    expect(view.anchor).toBe('c')
    // 再点一次同一行 = 取消选中，anchor 仍然停在它
    view = reduce(view, { type: 'select', name: 'c', mode: 'toggle' })
    expect(view.selected).toEqual(['a'])
    expect(view.anchor).toBe('c')
  })

  it('range：从 anchor 到目标取一段（正向）', () => {
    let view = reduce(fourFiles(), { type: 'select', name: 'b', mode: 'replace' })
    view = reduce(view, { type: 'select', name: 'd', mode: 'range' })
    expect(view.selected).toEqual(['b', 'c', 'd'])
    // anchor 不动：连续 Shift 才能扩大/缩小
    expect(view.anchor).toBe('b')
  })

  it('range：反向（从下往上 Shift）同样取两端的闭区间', () => {
    let view = reduce(fourFiles(), { type: 'select', name: 'd', mode: 'replace' })
    view = reduce(view, { type: 'select', name: 'b', mode: 'range' })
    expect(view.selected).toEqual(['b', 'c', 'd'])
    expect(view.anchor).toBe('d')
  })

  it('连续 range：先把区间扩大，再在原 anchor 上缩小', () => {
    let view = reduce(fourFiles(), { type: 'select', name: 'b', mode: 'replace' })
    view = reduce(view, { type: 'select', name: 'd', mode: 'range' })
    expect(view.selected).toEqual(['b', 'c', 'd'])
    view = reduce(view, { type: 'select', name: 'c', mode: 'range' })
    expect(view.selected).toEqual(['b', 'c'])
    expect(view.anchor).toBe('b')
  })

  it('range：anchor 为 null（全新视图）时退化成单选', () => {
    const view = reduce(fourFiles(), { type: 'select', name: 'c', mode: 'range' })
    expect(view.selected).toEqual(['c'])
  })

  it('关键回归：range 取【展示顺序】（排序后）而不是 entries 原始顺序', () => {
    /*
     * 若实现用 entries 原始顺序（d b a c）切片，从 a 到 c 会得到 d、b、a ——
     * 内容与顺序都不对，而这正是「界面上连着的一大段，选中的却是散落几项」。
     */
    let view = reduce(fourFiles(), { type: 'select', name: 'a', mode: 'replace' })
    view = reduce(view, { type: 'select', name: 'c', mode: 'range' })
    expect(view.selected).toEqual(['a', 'b', 'c'])
    // 对照：原始 entries 顺序确实不是 a/b/c/d（否则这条用例区分不出两种实现）
    expect(names(view.entries)).toEqual(['d', 'b', 'a', 'c'])
  })

  it('range 也按【过滤后】的列表：隐藏文件不参与区间', () => {
    let view = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/sdcard/DCIM' },
      {
        type: 'resolve',
        generation: 1,
        data: listData({
          dir: '/sdcard/DCIM',
          entries: [entry({ name: 'a' }), entry({ name: '.hidden' }), entry({ name: 'b' })],
        }),
      },
      { type: 'select', name: 'a', mode: 'replace' },
    )
    view = reduce(view, { type: 'select', name: 'b', mode: 'range' })
    expect(view.selected).toEqual(['a', 'b'])
  })
})

describe('多选增强：selectAll 与 clearSelection', () => {
  it('selectAll 只选传入的可见条目，anchor 不动', () => {
    const base = reduce(createFileView(), { type: 'select', name: 'x', mode: 'replace' })
    const view = reduce(base, { type: 'selectAll', names: ['a', 'b', 'c'] })
    expect(view.selected).toEqual(['a', 'b', 'c'])
    expect(view.anchor).toBe('x')
  })

  it('selectAll 用的是【传入的可见名单】，不是 state.entries 全量', () => {
    // 视图里有 a/b/c，但调用方只报了两项（隐藏项被过滤掉的情形）
    const base = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/sdcard/DCIM' },
      {
        type: 'resolve',
        generation: 1,
        data: listData({
          dir: '/sdcard/DCIM',
          entries: [entry({ name: 'a' }), entry({ name: '.hidden' }), entry({ name: 'b' }), entry({ name: 'c' })],
        }),
      },
    )
    const view = reduce(base, { type: 'selectAll', names: ['a', 'b'] })
    expect(view.selected).toEqual(['a', 'b'])
  })

  it('selectAll 传入空列表（空目录）：选择保持为空，不报错', () => {
    const view = reduce(createFileView(), { type: 'selectAll', names: [] })
    expect(view.selected).toEqual([])
  })

  it('clearSelection：清空选中项，anchor 保留', () => {
    const selected = reduce(createFileView(), { type: 'select', name: 'a', mode: 'replace' })
    const cleared = reduce(selected, { type: 'clearSelection' })
    expect(cleared.selected).toEqual([])
    expect(cleared.anchor).toBe('a')
  })

  it('无变化时返回同一个 state 引用（不触发无谓重渲染）', () => {
    const empty = createFileView()
    expect(reduce(empty, { type: 'clearSelection' })).toBe(empty)
    expect(reduce(empty, { type: 'selectAll', names: [] })).toBe(empty)
    const all = reduce(empty, { type: 'selectAll', names: ['a', 'b'] })
    expect(reduce(all, { type: 'selectAll', names: ['a', 'b'] })).toBe(all)
  })
})

/*
 * 全选**入口**（R2-2 / 复审 Minor 3）。
 *
 * 复审变异 M3：把 FilesPage 里 onSelectAll={handleSelectAll} 改成空函数 →
 * 全量 1393 passed 全绿。这条链路全部发生在点击事件回调里，而无 jsdom 的 SSR
 * 工程拿不到 onClick（与已登记的 N10 / syncDevices / onDownload 同类）。
 *
 * 所以「取哪些名字 + 派发什么 action」被抽成 makeSelectAllHandler（生产代码里
 * 工具条按钮与 Ctrl+A 都调它）。这里直接驱动它 —— 断言的是**派发记录**，
 * 不是源码文本：把 entries 的映射写错、或者 dispatch 的 action 类型写错、
 * 或者没有设备时照样派发，这三种退化都会在这里红。
 *
 * 仍然无门禁的部分（已登记 progress.md）：FilesPage 里 onClick 那一行有没有接上它。
 */
describe('R2-2 全选入口：makeSelectAllHandler', () => {
  type Call = { serial: string; action: FileViewAction }

  function harness(): { calls: Call[]; selectAll: ReturnType<typeof makeSelectAllHandler> } {
    const calls: Call[] = []
    const selectAll = makeSelectAllHandler({
      dispatch: (serial, action) => { calls.push({ serial, action }) },
    })
    return { calls, selectAll }
  }

  it('把【传入的可见条目】的名字派发成 selectAll（逐字一致，顺序不变）', () => {
    const h = harness()
    h.selectAll('SERIAL1', [{ name: 'b.txt' }, { name: 'a.txt' }, { name: 'dir' }])
    expect(h.calls).toEqual([
      { serial: 'SERIAL1', action: { type: 'selectAll', names: ['b.txt', 'a.txt', 'dir'] } },
    ])
  })

  it('派发的 action 交给真正的 reducer 后，选中项就是全部可见条目', () => {
    // 端到端：入口 → action → 真状态机，而不是只比 action 字面量
    const h = harness()
    h.selectAll('SERIAL1', [{ name: 'a' }, { name: 'b' }, { name: 'c' }])
    const call = h.calls[0]
    expect(call).toBeDefined()
    const view = reduce(createFileView(), call!.action)
    expect(view.selected).toEqual(['a', 'b', 'c'])
  })

  it('没有设备（serial 为 null）时**零派发**', () => {
    const h = harness()
    h.selectAll(null, [{ name: 'a' }])
    expect(h.calls).toEqual([])
  })

  it('空目录：派发一个 names 为空的 selectAll，选择保持为空（不报错）', () => {
    const h = harness()
    h.selectAll('SERIAL1', [])
    expect(h.calls).toEqual([{ serial: 'SERIAL1', action: { type: 'selectAll', names: [] } }])
    const view = reduce(createFileView(), h.calls[0]!.action)
    expect(view.selected).toEqual([])
  })

  it('已经全选时再次全选不改变状态引用（依赖 reducer 的幂等，入口不重复造 state）', () => {
    const h = harness()
    const entries = [{ name: 'a' }, { name: 'b' }]
    h.selectAll('SERIAL1', entries)
    const first = reduce(createFileView(), h.calls[0]!.action)
    h.selectAll('SERIAL1', entries)
    const second = reduce(first, h.calls[1]!.action)
    expect(second).toBe(first)
  })
})

describe('多选增强：刷新后选中项与 anchor 一起收敛', () => {
  it('多选场景下刷新：仍存在的选中项保留，消失的被剔除', () => {
    const loaded = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/sdcard/DCIM' },
      {
        type: 'resolve',
        generation: 1,
        data: listData({
          dir: '/sdcard/DCIM',
          entries: [entry({ name: 'a' }), entry({ name: 'b' }), entry({ name: 'c' }), entry({ name: 'd' })],
        }),
      },
      { type: 'select', name: 'a', mode: 'replace' },
      { type: 'select', name: 'd', mode: 'range' },
    )
    expect(loaded.selected).toEqual(['a', 'b', 'c', 'd'])

    const refreshed = reduce(
      loaded,
      { type: 'beginLoad' },
      {
        type: 'resolve',
        generation: loaded.generation + 1,
        data: listData({ dir: '/sdcard/DCIM', entries: [entry({ name: 'a' }), entry({ name: 'c' })] }),
      },
    )
    expect(refreshed.selected).toEqual(['a', 'c'])
    expect(refreshed.anchor).toBe('a')
  })

  it('anchor 在刷新后消失 → anchor 置空，下一次 Shift 退化成单选', () => {
    const loaded = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/sdcard/DCIM' },
      {
        type: 'resolve',
        generation: 1,
        data: listData({ dir: '/sdcard/DCIM', entries: [entry({ name: 'a' }), entry({ name: 'b' })] }),
      },
      { type: 'select', name: 'a', mode: 'replace' },
    )
    expect(loaded.anchor).toBe('a')
    const refreshed = reduce(
      loaded,
      { type: 'beginLoad' },
      {
        type: 'resolve',
        generation: loaded.generation + 1,
        data: listData({ dir: '/sdcard/DCIM', entries: [entry({ name: 'b' })] }),
      },
    )
    expect(refreshed.anchor).toBeNull()
    expect(refreshed.selected).toEqual([])
    const shifted = reduce(refreshed, { type: 'select', name: 'b', mode: 'range' })
    expect(shifted.selected).toEqual(['b'])
  })

  it('换目录：selected 与 anchor 都清空', () => {
    const loaded = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/sdcard/DCIM' },
      {
        type: 'resolve',
        generation: 1,
        data: listData({ dir: '/sdcard/DCIM', entries: [entry({ name: 'a' }), entry({ name: 'b' })] }),
      },
      { type: 'select', name: 'a', mode: 'replace' },
      { type: 'select', name: 'b', mode: 'range' },
    )
    expect(loaded.selected).toEqual(['a', 'b'])
    const moved = reduce(
      loaded,
      { type: 'navigate', cwd: '/sdcard/Download' },
      {
        type: 'resolve',
        generation: loaded.generation + 1,
        data: listData({ dir: '/sdcard/Download', entries: [entry({ name: 'x' })] }),
      },
    )
    expect(moved.selected).toEqual([])
    expect(moved.anchor).toBeNull()
  })
})

describe('多选增强：Ctrl/Cmd+A 与 Esc 的按键映射（纯函数）', () => {
  it('Ctrl+A / Cmd+A（含大写 A）都是全选', () => {
    expect(keyToSelectionAction({ key: 'a', ctrlKey: true })).toEqual({ kind: 'selectAll' })
    expect(keyToSelectionAction({ key: 'A', ctrlKey: true })).toEqual({ kind: 'selectAll' })
    expect(keyToSelectionAction({ key: 'a', metaKey: true })).toEqual({ kind: 'selectAll' })
  })

  it('单独按 a 不是全选（不能吞掉正常字符输入）', () => {
    expect(keyToSelectionAction({ key: 'a' })).toEqual({ kind: 'none' })
  })

  it('Esc / Escape 都是清空', () => {
    expect(keyToSelectionAction({ key: 'Escape' })).toEqual({ kind: 'clear' })
    expect(keyToSelectionAction({ key: 'Esc' })).toEqual({ kind: 'clear' })
  })

  it('输入框焦点保护：input / textarea 里的 Ctrl+A 与 Esc 一律不拦截', () => {
    expect(keyToSelectionAction({ key: 'a', ctrlKey: true, target: { tagName: 'INPUT' } })).toEqual({ kind: 'none' })
    expect(keyToSelectionAction({ key: 'a', ctrlKey: true, target: { tagName: 'TEXTAREA' } })).toEqual({ kind: 'none' })
    expect(keyToSelectionAction({ key: 'Escape', target: { tagName: 'INPUT' } })).toEqual({ kind: 'none' })
    expect(keyToSelectionAction({ key: 'Escape', target: { tagName: 'TEXTAREA' } })).toEqual({ kind: 'none' })
  })

  it('其它目标（列表容器 / 行）不触发保护', () => {
    expect(keyToSelectionAction({ key: 'a', ctrlKey: true, target: { tagName: 'DIV' } })).toEqual({ kind: 'selectAll' })
    expect(keyToSelectionAction({ key: 'Escape', target: null })).toEqual({ kind: 'clear' })
  })

  it('其它键交给导航处理（不进选中命令）', () => {
    for (const key of ['Backspace', 'F5', 'Enter', 'ArrowDown']) {
      expect(keyToSelectionAction({ key }), key).toEqual({ kind: 'none' })
    }
  })
})

describe('多选增强：rangeNames 的边界', () => {
  it('anchor 为 null → 只选目标', () => {
    expect(rangeNames(['a', 'b', 'c'], null, 'c')).toEqual(['c'])
  })

  it('anchor 或目标不在列表里 → 只选目标', () => {
    expect(rangeNames(['a', 'b', 'c'], 'zzz', 'c')).toEqual(['c'])
    expect(rangeNames(['a', 'b', 'c'], 'a', 'zzz')).toEqual(['zzz'])
  })

  it('两端都命中 → 闭区间，且与方向无关', () => {
    expect(rangeNames(['a', 'b', 'c', 'd'], 'b', 'c')).toEqual(['b', 'c'])
    expect(rangeNames(['a', 'b', 'c', 'd'], 'c', 'b')).toEqual(['b', 'c'])
  })

  it('anchor 与目标是同一项 → 只有它自己', () => {
    expect(rangeNames(['a', 'b'], 'b', 'b')).toEqual(['b'])
  })
})
