import { describe, it, expect } from 'vitest'
import { parseLsLong, parseLsLongWithStats, parseStatWithFormat } from '../electron/adb/list-parser'
import {
  REAL_DOWNLOAD,
  REAL_DEV,
  REAL_ROOT,
  REAL_SDCARD,
  REAL_SDCARD_SELF,
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
})

describe('parseLsLong 时间列变体（裁决 1）', () => {
  it('真机格式：单空格分隔日期与时间', () => {
    const [row] = parseLsLong('-rw------- 1 u0_a104 u0_a104 16800 2026-11-06 11:10 a.opus\n')
    expect(new Date(row.mtime).getFullYear()).toBe(2026)
    expect(new Date(row.mtime).getMonth()).toBe(10) // 11 月
    expect(new Date(row.mtime).getDate()).toBe(6)
    expect(new Date(row.mtime).getHours()).toBe(11)
    expect(new Date(row.mtime).getMinutes()).toBe(10)
  })

  it('有的 ls 在日期与时间之间插两个空格', () => {
    const [row] = parseLsLong('-rw-r--r-- 1 a b 1 2026-11-06  11:10 x\n')
    expect(new Date(row.mtime).getMonth()).toBe(10)
    expect(new Date(row.mtime).getDate()).toBe(6)
  })

  it('时间可以带秒', () => {
    const [row] = parseLsLong('-rw-r--r-- 1 a b 1 2026-11-06 11:10:33 x\n')
    expect(new Date(row.mtime).getSeconds()).toBe(33)
  })

  it('只有日期没有时间（老 ls 对旧文件只给年）也能解析', () => {
    const stats = parseLsLongWithStats('-rw-r--r-- 1 a b 1 2023-01-15 x\n')
    expect(stats.unparsed).toBe(0)
    expect(new Date(stats.entries[0].mtime).getFullYear()).toBe(2023)
    expect(new Date(stats.entries[0].mtime).getMonth()).toBe(0)
    expect(new Date(stats.entries[0].mtime).getDate()).toBe(15)
  })

  it('英文月名格式（busybox/BSD 风格）可解析', () => {
    const stats = parseLsLongWithStats('-rw-r--r-- 1 a b 1 Jan  5  2023 x\n')
    expect(stats.unparsed).toBe(0)
    expect(new Date(stats.entries[0].mtime).getFullYear()).toBe(2023)
    expect(new Date(stats.entries[0].mtime).getMonth()).toBe(0)
  })

  it('时间列完全缺失的行算未解析，不得凭空造时间', () => {
    const stats = parseLsLongWithStats('-rw-r--r-- 1 a b 1 x\n')
    expect(stats.unparsed).toBe(1)
  })
})

describe('parseLsLong 真机输出回归（裁决 1）', () => {
  it('/sdcard/Download 全量：中文、空格、加号、全角逗号名逐字还原，0 未解析', () => {
    const stats = parseLsLongWithStats(REAL_DOWNLOAD)
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

  it('真机 / ：1970 年的 mtime 解析结果与真机时间一致（08:01 就是 60000ms，不是 NaN）', () => {
    const stats = parseLsLongWithStats(REAL_ROOT)
    expect(stats.unparsed).toBe(0)
    const metadata = stats.entries.find((e) => e.name === 'metadata')
    // 设备时区 +08:00，1970-01-01 08:01 == epoch + 60000ms
    expect(metadata?.mtime).toBe(60_000)
    expect(new Date(metadata?.mtime as number).getFullYear()).toBe(1970)
    // 08:00 正好是 epoch 本身：mtime === 0 与「解析失败」在 FileEntry 里同值，
    // 这是已知的语义重叠，已记录在 task-5-report.md 的疑虑里。
    expect(stats.entries.find((e) => e.name === 'acct')?.mtime).toBe(0)
  })

  it('名字里的首尾空格原样保留（真机允许 trailingspace␠ 这种名字）', () => {
    const [row] = parseLsLong('-rw------- 1 u0_a104 u0_a104 2 2026-11-18 16:54 trailingspace \n')
    expect(row.name).toBe('trailingspace ')
  })

  it('以 - 或 . 开头的名字不被误判成表头/选项', () => {
    const stats = parseLsLongWithStats(
      'total 20\r\n' +
        '-rw------- 1 u0_a104 u0_a104 2 2026-11-18 16:54 -dashfile\r\n' +
        '-rw------- 1 u0_a104 u0_a104 2 2026-11-18 16:54 .hidden\r\n',
    )
    expect(stats.unparsed).toBe(0)
    expect(stats.entries.map((e) => e.name)).toEqual(['-dashfile', '.hidden'])
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

  it('普通文件名里出现 " -> " 不会被当成链接', () => {
    const [row] = parseLsLong('-rw-r--r-- 1 a b 1 2026-11-18 16:55 arrow -> target.txt\n')
    expect(row.isLink).toBe(false)
    expect(row.name).toBe('arrow -> target.txt')
    expect(row.linkTarget).toBeUndefined()
  })

  it('链接目标本身含 " -> " 时只按第一个切分', () => {
    const [row] = parseLsLong('lrwxrwxrwx 1 a b 1 2026-11-18 16:55 x -> /a -> b\n')
    expect(row.name).toBe('x')
    expect(row.linkTarget).toBe('/a -> b')
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
