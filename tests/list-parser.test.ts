import { describe, it, expect } from 'vitest'
import { parseLsLong, parseLsLongWithStats, parseStatWithFormat, splitLinkLine, unknownEntry } from '../electron/adb/list-parser'
import {
  REAL_DOWNLOAD,
  REAL_DEV,
  REAL_PROC1,
  REAL_ROOT,
  REAL_SDCARD,
  REAL_SDCARD_SELF,
  REAL_SPECIAL,
  REAL_STAT,
  REAL_TMP,
} from './fixtures/real-ls'

/** 简报给出的理想格式样例（逐字使用）。 */
const SAMPLE = [
  'total 24',
  'drwxrwx--x 4 root sdcard_r 4096 2024-10-12 09:31 Camera',
  '-rw-rw---- 1 root sdcard_r 2457600 2024-10-12 09:31 IMG_0001.jpg',
  '-rw-rw---- 1 root sdcard_r 12 2024-10-12 09:31 我的 照片.jpg',
  "lrwxrwxrwx 1 root root 21 2024-10-12 09:31 link -> /sdcard/DCIM",
].join('\n')

/** 真机设备时区：+08:00 = 480 分钟。 */
const TZ_CST = 480

describe('parseLsLong（简报样例）', () => {
  it('跳过 total 行并解析目录与文件', () => {
    const rows = parseLsLong(SAMPLE)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({ name: 'Camera', isDir: true, size: 4096 })
  })
  it('保留含空格的名称', () => {
    expect(parseLsLong(SAMPLE)[2].name).toBe('我的 照片.jpg')
  })
  it('解析符号链接目标', () => {
    expect(parseLsLong(SAMPLE)[3]).toMatchObject({ isLink: true, linkTarget: '/sdcard/DCIM' })
  })
  it('返回未解析比例用于降级判断', () => {
    expect(parseLsLongWithStats('garbage line\n').unparsed).toBe(1)
  })
})

describe('parseLsLong 基础行为', () => {
  it('空输入返回空数组而不是抛错', () => {
    expect(parseLsLong('')).toEqual([])
    expect(parseLsLongWithStats('').unparsed).toBe(0)
  })

  it('只有 total 行（空目录）算 0 条 0 未解析', () => {
    const stats = parseLsLongWithStats('total 0\r\n')
    expect(stats.entries).toEqual([])
    expect(stats.unparsed).toBe(0)
  })

  it('空白行与行尾 CRLF 不影响计数', () => {
    const stats = parseLsLongWithStats('total 8\r\n\r\n  \r\n-rw-r--r-- 1 a b 3 2024-10-12 09:31 x\r\n\r\n')
    expect(stats.unparsed).toBe(0)
    expect(stats.entries).toHaveLength(1)
    expect(stats.entries[0].name).toBe('x')
  })

  it('mode 保留类型位（与 ls -l 输出一致，共 10 位）', () => {
    const stats = parseLsLongWithStats(SAMPLE)
    expect(stats.entries[0].mode).toBe('drwxrwx--x')
    expect(stats.entries[1].mode).toBe('-rw-rw----')
  })

  it('属主/属组可能是数字 UID 而不是名字', () => {
    const [row] = parseLsLong('-rw-rw---- 1 1000 1000 12 2024-10-12 09:31 a.txt\n')
    expect(row).toMatchObject({ owner: '1000', group: '1000' })
  })

  it('未解析行保留原文供诊断', () => {
    const stats = parseLsLongWithStats('total 4\n-rw-r--r-- 1 a b 3 2024-10-12 09:31 ok.txt\ngarbage\n')
    expect(stats.unparsed).toBe(1)
    expect(stats.unparsedSamples).toEqual(['garbage'])
  })

  it('未解析样本最多保留 20 条，避免大目录吃内存', () => {
    const text = Array.from({ length: 100 }, (_, i) => 'garbage-' + i).join('\n')
    const stats = parseLsLongWithStats(text)
    expect(stats.unparsed).toBe(100)
    expect(stats.unparsedSamples).toHaveLength(20)
  })

  it('真实输出的条目一律 metaKnown = true', () => {
    const stats = parseLsLongWithStats(REAL_DOWNLOAD)
    expect(stats.entries.every((e) => e.metaKnown === true)).toBe(true)
  })
})

describe('parseLsLong 时间列变体（裁决 1）', () => {
  it('真机格式：单空格分隔日期与时间，按设备时区换算', () => {
    const [row] = parseLsLong('-rw------- 1 u0_a104 u0_a104 16800 2026-11-06 11:10 a.opus\n', {
      tzOffsetMinutes: TZ_CST,
    })
    // 设备本地 2026-11-06 11:10 (+08:00) == UTC 2026-11-06 03:10
    expect(row.mtime).toBe(Date.UTC(2026, 10, 6, 3, 10, 0))
  })

  it('有的 ls 在日期与时间之间插两个空格', () => {
    const [row] = parseLsLong('-rw-r--r-- 1 a b 1 2026-11-06  11:10 x\n', { tzOffsetMinutes: TZ_CST })
    expect(row.mtime).toBe(Date.UTC(2026, 10, 6, 3, 10, 0))
  })

  it('时间可以带秒', () => {
    const [row] = parseLsLong('-rw-r--r-- 1 a b 1 2026-11-06 11:10:33 x\n', { tzOffsetMinutes: TZ_CST })
    expect(row.mtime).toBe(Date.UTC(2026, 10, 6, 3, 10, 33))
  })

  it('只有日期没有时间（老 ls 对旧文件只给年）也能解析', () => {
    const stats = parseLsLongWithStats('-rw-r--r-- 1 a b 1 2023-01-15 x\n', { tzOffsetMinutes: TZ_CST })
    expect(stats.unparsed).toBe(0)
    expect(stats.entries[0].mtime).toBe(Date.UTC(2023, 0, 15, 0, 0, 0) - TZ_CST * 60_000)
  })

  it('英文月名格式（busybox/BSD 风格）可解析', () => {
    const stats = parseLsLongWithStats('-rw-r--r-- 1 a b 1 Jan  5  2023 x\n', { tzOffsetMinutes: TZ_CST })
    expect(stats.unparsed).toBe(0)
    expect(new Date(stats.entries[0].mtime).getUTCFullYear()).toBe(2023)
    expect(new Date(stats.entries[0].mtime).getUTCMonth()).toBe(0)
  })

  it('时间列完全缺失的行算未解析，不得凭空造时间', () => {
    const stats = parseLsLongWithStats('-rw-r--r-- 1 a b 1 x\n')
    expect(stats.unparsed).toBe(1)
  })

  // C2 的核心断言：同一份输出在任意宿主时区下都得到同一个 mtime
  it('同一份 ls 输出在不同宿主时区下解析结果完全一致（C2）', () => {
    const text = 'total 2\r\n' +
      '-rw------- 1 u0_a104 u0_a104 16800 2026-11-06 11:10 a.opus\r\n' +
      'dr-xr-xr-x 52 root root 0 1970-01-01 08:00 acct\r\n'
    const original = process.env.TZ
    const results: number[][] = []
    try {
      for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
        process.env.TZ = tz
        results.push(parseLsLong(text, { tzOffsetMinutes: TZ_CST }).map((e) => e.mtime))
      }
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
    expect(results[1]).toEqual(results[0])
    expect(results[2]).toEqual(results[0])
    // 且确实是按设备时区算的：1970-01-01 08:00 (+08:00) == epoch
    expect(results[0][1]).toBe(0)
    expect(results[0][0]).toBe(Date.UTC(2026, 10, 6, 3, 10, 0))
  })

  it('不给 tzOffsetMinutes 时按 UTC 解释（确定值，不跟随宿主）', () => {
    const [row] = parseLsLong('-rw-r--r-- 1 a b 1 2026-11-06 11:10 x\n')
    expect(row.mtime).toBe(Date.UTC(2026, 10, 6, 11, 10, 0))
  })
})

describe('parseLsLong 真机输出回归（裁决 1）', () => {
  it('/sdcard/Download 全量：中文、空格、加号、全角逗号名逐字还原，0 未解析', () => {
    const stats = parseLsLongWithStats(REAL_DOWNLOAD, { tzOffsetMinutes: TZ_CST })
    expect(stats.unparsed).toBe(0)
    expect(stats.entries.length).toBeGreaterThan(50)
    const names = stats.entries.map((e) => e.name)
    expect(names).toContain('DJI航点航线+喊话器，单曲循环.kmz')
    expect(names).toContain('route-20261113155534 (2).kmz')
    expect(names).toContain('OrthoPhoto_20251222174857_DSM.tif')
    const big = stats.entries.find((e) => e.name === 'OrthoPhoto_20251222174857_DSM.tif')
    expect(big?.size).toBe(19404962)
  })

  it('/sdcard/ 目录模式：s 位权限（drwxrws--x）原样保留', () => {
    const stats = parseLsLongWithStats(REAL_SDCARD)
    expect(stats.unparsed).toBe(0)
    const android = stats.entries.find((e) => e.name === 'Android')
    expect(android).toMatchObject({ isDir: true, mode: 'drwxrws--x', owner: 'media_rw', group: 'media_rw' })
  })

  it('真机 /data/local/tmp：含以点开头的隐藏项', () => {
    const stats = parseLsLongWithStats(REAL_TMP)
    expect(stats.unparsed).toBe(0)
    expect(stats.entries.some((e) => e.name.startsWith('.'))).toBe(true)
    expect(stats.entries.some((e) => e.isDir && e.name === '.studio')).toBe(true)
  })

  it('真机 /dev：字符设备行的 size 列是 "主, 次" 两段，取主设备号', () => {
    const stats = parseLsLongWithStats(REAL_DEV)
    expect(stats.unparsed).toBe(0)
    const dev = stats.entries.find((e) => e.name === '0:0:0:0')
    expect(dev).toMatchObject({ size: 242, isDir: false, isLink: false, mode: 'crw-------' })
  })

  it('真机 / ：1970 年 mtime 按设备时区换算（08:00 就是 epoch，不是 NaN）', () => {
    const stats = parseLsLongWithStats(REAL_ROOT, { tzOffsetMinutes: TZ_CST })
    expect(stats.unparsed).toBe(0)
    // 设备时区 +08:00 下 1970-01-01 08:01 == epoch + 60000ms
    expect(stats.entries.find((e) => e.name === 'metadata')?.mtime).toBe(60_000)
    // 08:00 正好是 epoch 本身：数值 0 与「解析失败」同值 —— 用 metaKnown 区分（I5）
    const acct = stats.entries.find((e) => e.name === 'acct')
    expect(acct?.mtime).toBe(0)
    expect(acct?.metaKnown).toBe(true)
  })

  it('真机 /proc/1：48 条条目全部可解析（虽然 ls 退出码是 1）', () => {
    const stats = parseLsLongWithStats(REAL_PROC1)
    expect(stats.unparsed).toBe(0)
    expect(stats.entries).toHaveLength(48)
  })

  it('操作数是符号链接时 ls 只输出链接自身一行（名字是完整路径）', () => {
    const stats = parseLsLongWithStats(REAL_SDCARD_SELF)
    expect(stats.unparsed).toBe(0)
    expect(stats.entries[0]).toMatchObject({
      name: '/sdcard',
      isLink: true,
      isDir: false,
      linkTarget: '/storage/self/primary',
    })
  })
})

describe('名字里的空白（I1）', () => {
  it('真机前导空格名 / lead.txt 原样还原（不得被贪婪吃掉）', () => {
    const stats = parseLsLongWithStats(REAL_SPECIAL)
    expect(stats.entries.map((e) => e.name)).toContain(' lead.txt')
  })

  it('行尾空格名 trail.txt␠ 原样还原', () => {
    const stats = parseLsLongWithStats(REAL_SPECIAL)
    expect(stats.entries.map((e) => e.name)).toContain('trail.txt ')
  })

  it('中间多空格名 mid␠␠␠spaces.txt 原样还原', () => {
    const stats = parseLsLongWithStats(REAL_SPECIAL)
    expect(stats.entries.map((e) => e.name)).toContain('mid   spaces.txt')
  })

  it('时间列与名字之间只吃一个分隔空格（前导空格 / 行尾空格 / 中间多空格三种名字）', () => {
    const text = [
      '-rw-r--r-- 1 a b 2 2026-11-18 17:20  lead.txt',
      '-rw-r--r-- 1 a b 2 2026-11-18 17:20 trail.txt ',
      '-rw-r--r-- 1 a b 2 2026-11-18 17:20 mid   spaces.txt',
    ].join('\n')
    expect(parseLsLong(text).map((e) => e.name)).toEqual([' lead.txt', 'trail.txt ', 'mid   spaces.txt'])
  })

  it('引号、反斜杠、分号等特殊字符名不被转义污染', () => {
    const stats = parseLsLongWithStats(REAL_SPECIAL)
    const names = stats.entries.map((e) => e.name)
    expect(names).toContain('quote"d.txt')
    expect(names).toContain('back\\slash.txt')
    expect(names).toContain("测试 文件'1'.txt")
  })
})

describe('链接切分（I2：名字与目标都含 " -> "）', () => {
  it('真机 a -> b -> real.txt：名字是 a -> b，目标是 real.txt', () => {
    const stats = parseLsLongWithStats(REAL_SPECIAL)
    expect(stats.entries.find((e) => e.name === 'a -> b')).toMatchObject({
      isLink: true,
      linkTarget: 'real.txt',
    })
  })

  it('真机 name -> arrow -> /tmp/x -> y：名字是 name -> arrow，目标是 /tmp/x -> y', () => {
    const stats = parseLsLongWithStats(REAL_SPECIAL)
    expect(stats.entries.find((e) => e.name === 'name -> arrow')).toMatchObject({
      isLink: true,
      linkTarget: '/tmp/x -> y',
    })
  })

  it('目标含箭头、名字不含箭头（同一行两种歧义都要对）', () => {
    const [row] = parseLsLong('lrwxrwxrwx 1 a b 7 2026-11-18 16:55 x -> /a -> b\n')
    expect(row.name).toBe('x')
    expect(row.linkTarget).toBe('/a -> b')
  })

  it('splitLinkLine 用 st_size（目标字节数）消歧', () => {
    // 'real.txt' 8 字节；'b -> real.txt' 13 字节（1 + 4 + 8）
    expect(splitLinkLine('a -> b -> real.txt', 8)).toEqual({ name: 'a -> b', target: 'real.txt' })
    expect(splitLinkLine('a -> b -> real.txt', 13)).toEqual({ name: 'a', target: 'b -> real.txt' })
  })

  it('splitLinkLine 在 size 与任何切分都不匹配时退回最右切分', () => {
    expect(splitLinkLine('x -> y -> z', 999)).toEqual({ name: 'x -> y', target: 'z' })
  })

  it('没有 " -> " 时整体当名字', () => {
    expect(splitLinkLine('plain-link', 5)).toEqual({ name: 'plain-link' })
  })

  it('普通文件名里出现 " -> " 不会被当成链接', () => {
    const [row] = parseLsLong('-rw-r--r-- 1 a b 17 2026-11-18 16:55 arrow -> target.txt\n')
    expect(row.isLink).toBe(false)
    expect(row.name).toBe('arrow -> target.txt')
    expect(row.linkTarget).toBeUndefined()
  })
})

describe('parseLsLong 链接语义（裁决 4）', () => {
  it('链接的 isDir 恒为 false，即使目标指向目录', () => {
    const [row] = parseLsLong('lrwxrwxrwx 1 root root 12 2026-11-18 16:55 absdir -> /sdcard/DCIM\n')
    expect(row.isLink).toBe(true)
    expect(row.isDir).toBe(false)
    expect(row.linkTarget).toBe('/sdcard/DCIM')
  })

  it('相对链接目标在给了 dir 时解析成绝对路径，原样目标仍保留', () => {
    const [row] = parseLsLong('lrwxrwxrwx 1 shell shell 8 2026-11-18 16:55 rel.txt -> real.txt\n', {
      dir: '/data/local/tmp',
    })
    expect(row.linkTarget).toBe('real.txt')
    expect(row.linkTargetResolved).toBe('/data/local/tmp/real.txt')
  })

  it('相对链接目标以 .. 开头时按父目录归一化', () => {
    const [row] = parseLsLong('lrwxrwxrwx 1 shell shell 9 2026-11-18 16:55 relup.txt -> ../up.txt\n', {
      dir: '/data/local/tmp/sub',
    })
    expect(row.linkTargetResolved).toBe('/data/local/tmp/up.txt')
  })

  it('没给 dir 时相对目标无法解析：原样保留且不标记 resolved', () => {
    const [row] = parseLsLong('lrwxrwxrwx 1 shell shell 8 2026-11-18 16:55 rel.txt -> real.txt\n')
    expect(row.linkTarget).toBe('real.txt')
    expect(row.linkTargetResolved).toBeUndefined()
  })

  it('绝对目标在没给 dir 时也是可解析的', () => {
    const [row] = parseLsLong('lrwxrwxrwx 1 root root 21 2026-11-18 16:55 sdcard -> /storage/self/primary\n')
    expect(row.linkTargetResolved).toBe('/storage/self/primary')
  })

  it('断链（目标不存在）与普通链接解析结果一致', () => {
    const [row] = parseLsLong('lrwxrwxrwx 1 shell shell 11 2026-11-18 16:55 broken -> missing.txt\n', {
      dir: '/data/local/tmp',
    })
    expect(row.isLink).toBe(true)
    expect(row.linkTargetResolved).toBe('/data/local/tmp/missing.txt')
  })
})

describe('parseStatWithFormat（降级补齐的字段来源）', () => {
  it('解析真机 stat -c %A|%U|%G|%s|%Y|%n 输出', () => {
    const rows = parseStatWithFormat(REAL_STAT)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ name: '/sdcard/Download', isDir: true, owner: 'u0_a104' })
    expect(rows[1]).toMatchObject({ name: '/sdcard/Download/测试音频.opus', isDir: false, size: 16800 })
    // %Y 是秒；真机抓包里这一行是 1794534116（换算过来对得上 ls 显示的 2026-11-13 09:41）
    expect(rows[1].mtime).toBe(1794534116 * 1000)
  })

  it('stat 结果的 metaKnown 为 true', () => {
    expect(parseStatWithFormat(REAL_STAT).every((e) => e.metaKnown === true)).toBe(true)
  })

  it('名字里含竖线也不截断', () => {
    const [row] = parseStatWithFormat('-rw-r--r--|u0_a104|u0_a104|7|1794553956|/sdcard/a|b.txt\n')
    expect(row.name).toBe('/sdcard/a|b.txt')
    expect(row.size).toBe(7)
  })

  it('符号链接行 isLink 为 true、isDir 为 false、名字是完整路径', () => {
    const [row] = parseStatWithFormat('lrwxrwxrwx|shell|shell|8|1794992106|/data/local/tmp/rel.txt\n')
    expect(row.isLink).toBe(true)
    expect(row.isDir).toBe(false)
  })

  it('无法识别的行被跳过而不是抛错', () => {
    expect(parseStatWithFormat("stat: '/x': No such file or directory\n")).toEqual([])
  })
})

describe('unknownEntry（I5：元数据未知的占位条目）', () => {
  it('名字保留，其余字段为 0/空，且 metaKnown = false', () => {
    expect(unknownEntry('x.bin')).toEqual({
      name: 'x.bin',
      isDir: false,
      isLink: false,
      size: 0,
      mtime: 0,
      mode: '',
      owner: '',
      group: '',
      metaKnown: false,
    })
  })

  it('真 0（1970-01-01 08:00 +08:00）与「未知」在 metaKnown 上可区分', () => {
    const real = parseLsLongWithStats(REAL_ROOT, { tzOffsetMinutes: TZ_CST }).entries.find((e) => e.name === 'acct')
    const unknown = unknownEntry('acct')
    expect(real?.mtime).toBe(unknown.mtime) // 数值相同
    expect(real?.metaKnown).toBe(true)
    expect(unknown.metaKnown).toBe(false)
  })
})
