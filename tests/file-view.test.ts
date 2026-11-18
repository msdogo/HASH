import { describe, it, expect } from 'vitest'
import type { FileEntry } from '../src/shared/types'
import {
  ROW_HEIGHT,
  compareByName,
  createFileView,
  createLoadCoordinator,
  fileViewReducer,
  fileViewsReducer,
  filterEntries,
  formatMtime,
  formatSize,
  isDotEntry,
  isHiddenName,
  isMetaKnown,
  joinEntryPath,
  normalizePath,
  noticeFromList,
  parentOf,
  parseTypedPath,
  segmentsOf,
  sortEntries,
  summarizeEntries,
  viewFromPartial,
  viewOf,
  visibleEntries,
  type FileViewAction,
  type FileViewState,
  type FileViews,
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
    // 真机 /acct 之类：mtime 正好是 0，但这是真实元数据（设备时区 +08:00）
    const real1970 = entry({ name: 'acct', mtime: 0, metaKnown: true })
    expect(formatMtime(real1970, 480)).toBe('1970-01-01 08:00')
    expect(formatMtime(real1970, 0)).toBe('1970-01-01 00:00')
  })

  it('size=0 的已知条目显示 0 B，不是「未知」', () => {
    expect(formatSize(entry({ name: 'empty.txt', size: 0 }))).toBe('0 B')
  })

  it('按时间排序：未知项恒排最后（升序与降序都最后）', () => {
    const list = [
      entry({ name: 'unknown.bin', metaKnown: false, mtime: 0 }),
      entry({ name: 'new.txt', mtime: 3000 }),
      entry({ name: 'old.txt', mtime: 1000 }),
    ]
    expect(names(sortEntries(list, 'time', 'asc'))).toEqual(['old.txt', 'new.txt', 'unknown.bin'])
    expect(names(sortEntries(list, 'time', 'desc'))).toEqual(['new.txt', 'old.txt', 'unknown.bin'])
  })

  it('按大小排序：未知项恒排最后（不会因为 size=0 挤到最前）', () => {
    const list = [
      entry({ name: 'unknown.bin', metaKnown: false, size: 0 }),
      entry({ name: 'zero.txt', size: 0 }),
      entry({ name: 'big.bin', size: 9999 }),
    ]
    expect(names(sortEntries(list, 'size', 'asc'))).toEqual(['zero.txt', 'big.bin', 'unknown.bin'])
    expect(names(sortEntries(list, 'size', 'desc'))).toEqual(['big.bin', 'zero.txt', 'unknown.bin'])
  })

  it('按名称排序时未知项不受影响（名字总是已知）', () => {
    const list = [
      entry({ name: 'b.bin', metaKnown: false }),
      entry({ name: 'a.bin', metaKnown: false }),
    ]
    expect(names(sortEntries(list, 'name', 'asc'))).toEqual(['a.bin', 'b.bin'])
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

describe('裁决 4：万级条目排序性能', () => {
  it('1 万条按名称排序 < 100ms', () => {
    const list = bigDirectory(10_000)
    const start = performance.now()
    const sorted = sortEntries(list, 'name', 'asc')
    const elapsed = performance.now() - start
    expect(sorted).toHaveLength(10_000)
    expect(elapsed).toBeLessThan(100)
  })

  it('1 万条按大小排序 < 100ms', () => {
    const list = bigDirectory(10_000)
    const start = performance.now()
    const sorted = sortEntries(list, 'size', 'desc')
    const elapsed = performance.now() - start
    expect(sorted).toHaveLength(10_000)
    expect(elapsed).toBeLessThan(100)
  })

  it('1 万条按时间排序 + 过滤 < 100ms', () => {
    const list = bigDirectory(10_000)
    const start = performance.now()
    const sorted = sortEntries(filterEntries(list, { showHidden: false }), 'time', 'asc')
    const elapsed = performance.now() - start
    expect(sorted.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(100)
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
    // 输入不规范也要归一化后再切
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
    const notice = noticeFromList({ degraded: true, unparsed: 7, usedFallback: true, exitCode: 0 })
    expect(notice).toEqual({ degraded: true, unparsed: 7, usedFallback: true, exitCode: 0 })
  })

  it('exitCode 非 0 但有条目（/proc 半可读）也给出提示', () => {
    const notice = noticeFromList({ degraded: false, unparsed: 0, usedFallback: false, exitCode: 1 })
    expect(notice).toEqual({ degraded: false, unparsed: 0, usedFallback: false, exitCode: 1 })
  })
})

/* ============ 裁决 2 / 7：视图状态（store 层的纯 reducer） ============ */

/** 造一份 fs:list 的返回数据（省略 serial，reducer 不需要它）。 */
function listData(over: Partial<{ dir: string; entries: FileEntry[]; degraded: boolean; unparsed: number; usedFallback: boolean; exitCode: number | null; tzOffsetMinutes: number }> = {}) {
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

function reduce(view: FileViewState, ...actions: Parameters<typeof fileViewReducer>[1][]): FileViewState {
  let next = view
  for (const action of actions) next = fileViewReducer(next, action)
  return next
}

describe('视图状态：初始值与导航', () => {
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
  })

  it('navigate 归一化路径、请求代次+1、清空条目与选中、滚动归零', () => {
    const view = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/sdcard/DCIM/' },
      { type: 'setScrollTop', value: 400 },
      { type: 'select', name: 'a.txt', additive: false },
    )
    const next = reduce(view, { type: 'navigate', cwd: '/sdcard/Download' })
    expect(next.cwd).toBe('/sdcard/Download')
    expect(next.status).toBe('loading')
    expect(next.entries).toEqual([])
    expect(next.selected).toEqual([])
    expect(next.scrollTop).toBe(0)
    expect(next.generation).toBe(view.generation + 1)
  })

  it('beginLoad（刷新）保留条目、选中与滚动位置，只推进代次', () => {
    const loaded = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/sdcard/DCIM' },
      { type: 'resolve', generation: 1, data: listData({ dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' })] }) },
      { type: 'select', name: 'a.jpg', additive: false },
      { type: 'setScrollTop', value: 250 },
    )
    const next = reduce(loaded, { type: 'beginLoad' })
    expect(next.status).toBe('loading')
    expect(names(next.entries)).toEqual(['a.jpg'])
    expect(next.selected).toEqual(['a.jpg'])
    expect(next.scrollTop).toBe(250)
    expect(next.generation).toBe(loaded.generation + 1)
  })
})

describe('裁决 2：过期响应必须丢弃（A 先请求、B 后请求、A 后到）', () => {
  it('先请求 A 再请求 B，A 的结果晚到也不能覆盖 B 的内容', () => {
    // 1) 打开 /A → 代次 1
    let view = reduce(createFileView(), { type: 'navigate', cwd: '/A' })
    expect(view.generation).toBe(1)
    // 2) 用户马上切到 /B → 代次 2
    view = reduce(view, { type: 'navigate', cwd: '/B' })
    expect(view.generation).toBe(2)
    // 3) B 的结果先到
    view = reduce(view, { type: 'resolve', generation: 2, data: listData({ dir: '/B', entries: [entry({ name: 'b.txt' })] }) })
    expect(names(view.entries)).toEqual(['b.txt'])
    // 4) A 的结果后到（世代已过期）→ 必须丢弃
    const stale = reduce(view, { type: 'resolve', generation: 1, data: listData({ dir: '/A', entries: [entry({ name: 'a.txt' })] }) })
    expect(names(stale.entries)).toEqual(['b.txt'])
    expect(stale.cwd).toBe('/B')
    expect(stale.status).toBe('ready')
    // 同一份状态必须原样返回，避免无意义的重渲染
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
    // 重新加载后应当再次提示（新结果可能仍有问题）
    const reloaded = reduce(view, { type: 'beginLoad' })
    expect(reloaded.noticeDismissed).toBe(false)
  })

  it('零条目 + 错误码 → 错误态（界面显示重试）；保留错误码供 i18n 翻译', () => {
    const view = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/nope' },
      { type: 'fail', generation: 1, code: 'E_NOT_FOUND' },
    )
    expect(view.status).toBe('error')
    expect(view.error).toBe('E_NOT_FOUND')
    expect(view.entries).toEqual([])
  })

  it('已有条目时失败不整页变错误（保留内容 + 错误码提示）', () => {
    const loaded = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/sdcard/DCIM' },
      { type: 'resolve', generation: 1, data: listData({ dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' })] }) },
    )
    const failed = reduce(loaded, { type: 'beginLoad' }, { type: 'fail', generation: loaded.generation + 1, code: 'E_TIMEOUT' })
    expect(failed.status).toBe('ready')
    expect(names(failed.entries)).toEqual(['a.jpg'])
    expect(failed.error).toBe('E_TIMEOUT')
  })
})

describe('视图状态：排序、隐藏文件、选中、滚动、地址栏', () => {
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

  it('点击选中：非累加替换、累加切换', () => {
    let view = reduce(createFileView(), { type: 'select', name: 'a', additive: false })
    expect(view.selected).toEqual(['a'])
    view = reduce(view, { type: 'select', name: 'b', additive: true })
    expect(view.selected).toEqual(['a', 'b'])
    view = reduce(view, { type: 'select', name: 'a', additive: true })
    expect(view.selected).toEqual(['b'])
    view = reduce(view, { type: 'select', name: 'c', additive: false })
    expect(view.selected).toEqual(['c'])
  })

  it('滚动位置写入状态（切设备回来要恢复）', () => {
    const view = reduce(createFileView(), { type: 'setScrollTop', value: 1234 })
    expect(view.scrollTop).toBe(1234)
  })

  it('地址栏非法路径只写行内错误，不破坏当前目录与条目', () => {
    const loaded = reduce(
      createFileView(),
      { type: 'navigate', cwd: '/sdcard/DCIM' },
      { type: 'resolve', generation: 1, data: listData({ dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' })] }) },
      { type: 'addressError', code: 'E_INVALID_PATH' },
    )
    expect(loaded.addressError).toBe('E_INVALID_PATH')
    expect(loaded.cwd).toBe('/sdcard/DCIM')
    expect(names(loaded.entries)).toEqual(['a.jpg'])
    // 合法的跳转要清掉行内错误
    const next = reduce(loaded, { type: 'navigate', cwd: '/sdcard/Download' })
    expect(next.addressError).toBeNull()
  })
})

describe('裁决 7：每设备独立视图（按 serial 分片）', () => {
  it('两台设备各自 setCwd / 条目 / 滚动位置互不影响', () => {
    let views = fileViewsReducer({}, { serial: 'A', type: 'navigate', cwd: '/sdcard/DCIM' })
    views = fileViewsReducer(views, { serial: 'B', type: 'navigate', cwd: '/sdcard/Download' })
    views = fileViewsReducer(views, { serial: 'A', type: 'resolve', generation: 1, data: listData({ dir: '/sdcard/DCIM', entries: [entry({ name: 'a.jpg' })] }) })
    views = fileViewsReducer(views, { serial: 'B', type: 'resolve', generation: 1, data: listData({ dir: '/sdcard/Download', entries: [entry({ name: 'b.zip' })] }) })
    views = fileViewsReducer(views, { serial: 'A', type: 'setScrollTop', value: 900 })
    views = fileViewsReducer(views, { serial: 'A', type: 'select', name: 'a.jpg', additive: false })

    expect(views.A.cwd).toBe('/sdcard/DCIM')
    expect(views.B.cwd).toBe('/sdcard/Download')
    expect(names(views.A.entries)).toEqual(['a.jpg'])
    expect(names(views.B.entries)).toEqual(['b.zip'])
    expect(views.A.scrollTop).toBe(900)
    expect(views.A.selected).toEqual(['a.jpg'])
    // B 机不受 A 机影响
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
/* ============ 裁决 2：加载协调器（过期响应丢弃 + 在飞去重） ============ */

/** 造一个可控的假 fs:list：请求挂起，由测试决定谁先返回。 */
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
      const item = pending[index]
      pending[index] = undefined as unknown as typeof item
      item.resolve({ ok: true, data: listData(data) })
    },
    failAt: (index: number, code: string): void => {
      const item = pending[index]
      pending[index] = undefined as unknown as typeof item
      item.resolve({ ok: false, error: code })
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

    // B 先到
    h.resolveAt(1, { dir: '/B', entries: [entry({ name: 'b.txt' })] })
    await loadB
    expect(names(h.views.S.entries)).toEqual(['b.txt'])
    expect(h.views.S.cwd).toBe('/B')

    // A 后到（过期）→ 丢弃
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
    expect(h.views.S.status).toBe('ready')
  })

  it('同一目录同代次的并发加载只发一次请求（StrictMode 双挂 / N4）', async () => {
    const h = harness()
    const first = h.coordinator.load('S')
    const second = h.coordinator.load('S')
    expect(h.requests).toHaveLength(1)
    h.resolveAt(0, { dir: '/sdcard', entries: [entry({ name: 'x' })] })
    await Promise.all([first, second])
    expect(names(h.views.S.entries)).toEqual(['x'])
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
    // B 的结果先到、A 的后到，都不该丢
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
describe('分片还没建立时的默认值（页面首帧兜底）', () => {
  it('undefined / 空对象都给出完整默认视图（entries 必须是数组，不能是 undefined）', () => {
    for (const input of [undefined, {}, { cwd: '/sdcard/DCIM' }]) {
      const view = viewFromPartial(input)
      expect(Array.isArray(view.entries), String(input)).toBe(true)
      expect(view.entries).toEqual([])
      expect(Array.isArray(view.selected)).toBe(true)
      expect(typeof view.cwd).toBe('string')
      expect(typeof view.generation).toBe('number')
      expect(typeof view.scrollTop).toBe('number')
    }
  })

  it('选择性订阅得到的「半桶水」对象能补齐（undefined 字段回落默认值，已有字段保持）', () => {
    const partial = {
      cwd: '/sdcard/Download',
      sort: 'size' as const,
      sortDir: 'desc' as const,
      showHidden: true,
      entries: [entry({ name: 'a.zip' })],
      status: 'ready' as const,
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
    // 未提供的字段回落默认值
    expect(view.generation).toBe(0)
    expect(view.scrollTop).toBe(0)
  })

  it('visibleEntries 能吃 viewFromPartial 的结果（首帧不会炸 "entries is not iterable"）', () => {
    const view = viewFromPartial({ cwd: '/sdcard' })
    expect(() => visibleEntries(view.entries, { showHidden: false, sort: view.sort, sortDir: view.sortDir })).not.toThrow()
    expect(visibleEntries(view.entries, { showHidden: false, sort: 'name', sortDir: 'asc' })).toEqual([])
  })
})
