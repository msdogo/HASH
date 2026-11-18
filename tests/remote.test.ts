import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { AdbClient } from '../electron/adb/client'
import { shellQuote } from '../electron/adb/shellsafe'
import {
  E_NO_PERMISSION,
  E_NOT_FOUND,
  E_PARSE_DEGRADED,
  joinPath,
  listDir,
  listDirDetailed,
  normalizeDir,
  type ShellRunner,
} from '../electron/fs/remote'
import { REAL_DOWNLOAD, REAL_TMP } from './fixtures/real-ls'

/* ============ 假 adb：只实现 AdbClient 的 run 契约，用于离线断言命令与降级路径 ============ */

interface FakeResponse {
  match: RegExp
  code?: number
  stdout?: string
  stderr?: string
}

interface FakeClient extends ShellRunner {
  commands: string[]
  opts: Array<{ adbPath: string; timeoutMs?: number }>
}

function fakeClient(responses: FakeResponse[]): FakeClient {
  const client: FakeClient = {
    commands: [],
    opts: [],
    run: async (args, opts) => {
      // 契约：args 必须是 ['shell', <命令串>]，不得把命令拆成多个 argv
      if (args[0] !== 'shell' || args.length !== 2) {
        throw new Error('unexpected argv: ' + JSON.stringify(args))
      }
      client.commands.push(args[1])
      client.opts.push({ adbPath: opts.adbPath, timeoutMs: opts.timeoutMs })
      const hit = responses.find((r) => r.match.test(args[1]))
      if (!hit) return { code: 127, stdout: '', stderr: 'fake adb: no matching response' }
      return { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' }
    },
  }
  return client
}

const LS_LONG = /^LC_ALL=C ls -lA -- /
const LS_NAMES = /^LC_ALL=C ls -1A -- /
const STAT = /^LC_ALL=C stat -c /

/* ============ 裁决 3：路径拼接 ============ */

describe('joinPath（裁决 3：防目录穿越与空段）', () => {
  it("joinPath('/', 'a') 得到 /a，不产生双斜杠", () => {
    expect(joinPath('/', 'a')).toBe('/a')
  })

  it("joinPath('/sdcard/', 'b') 去掉基目录尾斜杠", () => {
    expect(joinPath('/sdcard/', 'b')).toBe('/sdcard/b')
  })

  it("joinPath('/sdcard//', 'b') 折叠重复斜杠", () => {
    expect(joinPath('/sdcard//', 'b')).toBe('/sdcard/b')
  })

  it("joinPath('/a', '..') 回到根", () => {
    expect(joinPath('/a', '..')).toBe('/')
  })

  it("joinPath('/a/b', '..') 回到父目录", () => {
    expect(joinPath('/a/b', '..')).toBe('/a')
  })

  it("joinPath('/', '..') 被夹在根，不会跑到根外", () => {
    expect(joinPath('/', '..')).toBe('/')
  })

  it("joinPath('/a', '../..') 多层上跳也被夹在根", () => {
    expect(joinPath('/a', '../..')).toBe('/')
  })

  it("joinPath('/sdcard', '.') 与空串都返回基目录本身", () => {
    expect(joinPath('/sdcard', '.')).toBe('/sdcard')
    expect(joinPath('/sdcard', '')).toBe('/sdcard')
  })

  it("joinPath('/sdcard', 'a/b') 允许子路径并归一化", () => {
    expect(joinPath('/sdcard', 'a/b')).toBe('/sdcard/a/b')
    expect(joinPath('/sdcard', 'a//b')).toBe('/sdcard/a/b')
  })

  it("joinPath 对绝对 name 直接采用（浏览绝对路径的场景）", () => {
    expect(joinPath('/sdcard', '/data/local/tmp')).toBe('/data/local/tmp')
  })

  it('含 NUL 的名字直接抛 E_INVALID_PATH（无法表达成 shell 单词）', () => {
    expect(() => joinPath('/sdcard', 'a\u0000b')).toThrow('E_INVALID_PATH')
  })

  it('基目录含换行也抛 E_INVALID_PATH', () => {
    expect(() => joinPath('/sd\ncard', 'a')).toThrow('E_INVALID_PATH')
  })

  it('中文与空格原样保留', () => {
    expect(joinPath('/sdcard/Download', "测试 文件'1'.txt")).toBe("/sdcard/Download/测试 文件'1'.txt")
  })
})

describe('normalizeDir', () => {
  it('折叠重复斜杠、去掉尾斜杠、补前导斜杠', () => {
    expect(normalizeDir('/sdcard///Download/')).toBe('/sdcard/Download')
    expect(normalizeDir('sdcard/Download')).toBe('/sdcard/Download')
  })

  it('根的各种写法都归一成 /', () => {
    expect(normalizeDir('/')).toBe('/')
    expect(normalizeDir('//')).toBe('/')
    expect(normalizeDir('///')).toBe('/')
  })

  it('空串抛 E_INVALID_PATH', () => {
    expect(() => normalizeDir('')).toThrow('E_INVALID_PATH')
    expect(() => normalizeDir('   ')).toThrow('E_INVALID_PATH')
  })

  it('点段被归一化，不留在结果里', () => {
    expect(normalizeDir('/sdcard/./Download')).toBe('/sdcard/Download')
    expect(normalizeDir('/sdcard/x/../Download')).toBe('/sdcard/Download')
  })
})

/* ============ listDir 主路径 ============ */

describe('listDir', () => {
  it('真机 /sdcard/Download 原始输出：条目全部解析，命令带 LC_ALL=C 与 --', async () => {
    const client = fakeClient([{ match: LS_LONG, stdout: REAL_DOWNLOAD }])
    const entries = await listDir(client, 'adb', '/sdcard/Download')
    expect(entries.length).toBeGreaterThan(50)
    expect(entries.some((e) => e.name === 'DJI航点航线+喊话器，单曲循环.kmz')).toBe(true)
    // 尾斜杠是刻意补的：ls 的操作数若是符号链接本身（如 /sdcard），
    // 不带尾斜杠只会输出那一条链接，列不出目录内容。
    expect(client.commands).toEqual(["LC_ALL=C ls -lA -- '/sdcard/Download/'"])
  })

  it('目录经 shellQuote 转义后才进命令串（单引号/空格/中文）', async () => {
    const client = fakeClient([{ match: LS_LONG, stdout: 'total 0\r\n' }])
    const dir = "/sdcard/我的 文件'1'"
    await listDir(client, 'adb', dir)
    expect(client.commands[0]).toBe('LC_ALL=C ls -lA -- ' + shellQuote(dir + '/'))
  })

  it('路径含换行时在发命令前就失败，不产生任何 adb 调用', async () => {
    const client = fakeClient([{ match: LS_LONG }])
    await expect(listDir(client, 'adb', '/sdcard/a\nb')).rejects.toThrow('E_INVALID_PATH')
    expect(client.commands).toEqual([])
  })

  it('自动补尾斜杠：操作数是符号链接时也能列出目录内容', async () => {
    const client = fakeClient([
      { match: LS_LONG, stdout: REAL_TMP },
    ])
    await listDir(client, 'adb', '/sdcard')
    expect(client.commands[0]).toBe("LC_ALL=C ls -lA -- '/sdcard/'")
  })

  it('空目录（只有 total 行）返回空数组，不抛错', async () => {
    const client = fakeClient([{ match: LS_LONG, stdout: 'total 0\r\n' }])
    await expect(listDir(client, 'adb', '/sdcard/DCIM')).resolves.toEqual([])
  })

  it('Permission denied 映射为 E_NO_PERMISSION', async () => {
    const client = fakeClient([
      { match: LS_LONG, code: 1, stderr: "ls: /data/app: Permission denied\r\n" },
    ])
    await expect(listDir(client, 'adb', '/data/app')).rejects.toThrow(E_NO_PERMISSION)
  })

  it('No such file or directory 映射为 E_NOT_FOUND', async () => {
    const client = fakeClient([
      { match: LS_LONG, code: 1, stderr: "ls: /nope: No such file or directory\r\n" },
    ])
    await expect(listDir(client, 'adb', '/nope')).rejects.toThrow(E_NOT_FOUND)
  })

  it('Not a directory 也映射为 E_NOT_FOUND', async () => {
    const client = fakeClient([
      { match: LS_LONG, code: 1, stderr: 'ls: /sdcard/a.txt/: Not a directory\r\n' },
    ])
    await expect(listDir(client, 'adb', '/sdcard/a.txt')).rejects.toThrow(E_NOT_FOUND)
  })

  it('把 adbPath 与超时透传给 client.run', async () => {
    const client = fakeClient([{ match: LS_LONG, stdout: 'total 0\r\n' }])
    await listDir(client, 'C:/adb.exe', '/sdcard/DCIM')
    expect(client.opts[0]).toEqual({ adbPath: 'C:/adb.exe', timeoutMs: 60_000 })
  })

  it('链接条目的 isDir 恒为 false，相对目标被解析成绝对路径（裁决 4）', async () => {
    const client = fakeClient([
      {
        match: LS_LONG,
        stdout: [
          'total 7',
          'lrwxrwxrwx 1 shell shell   12 2026-11-18 16:55 absdir -> /sdcard/DCIM',
          'lrwxrwxrwx 1 shell shell    8 2026-11-18 16:55 rel.txt -> real.txt',
          'drwxrwxrwx 2 shell shell 3452 2026-11-18 16:55 sub',
          '',
        ].join('\r\n'),
      },
    ])
    const entries = await listDir(client, 'adb', '/data/local/tmp')
    const absdir = entries.find((e) => e.name === 'absdir')
    const rel = entries.find((e) => e.name === 'rel.txt')
    expect(absdir).toMatchObject({ isLink: true, isDir: false, linkTarget: '/sdcard/DCIM' })
    expect(absdir?.linkTargetResolved).toBe('/sdcard/DCIM')
    expect(rel?.linkTargetResolved).toBe('/data/local/tmp/real.txt')
    expect(entries.find((e) => e.name === 'sub')?.isDir).toBe(true)
  })
})

/* ============ 裁决 2：解析失败必须降级 ============ */

describe('listDir 解析降级（裁决 2）', () => {
  const GOOD = [
    '-rw------- 1 u0_a104 u0_a104 2 2026-11-18 16:54 a.txt',
    '-rw------- 1 u0_a104 u0_a104 2 2026-11-18 16:54 b.txt',
    'drwx------ 2 u0_a104 u0_a104 2 2026-11-18 16:54 sub',
  ]
  const GARBAGE = Array.from({ length: 7 }, (_, i) => '<<垃圾行 ' + i + '>>')
  const MIXED = ['total 12', ...GOOD, ...GARBAGE].join('\r\n')

  it('前 3 行正常 + 后 7 行乱码：返回前 3 条并带 degraded 标志（不抛错）', async () => {
    const client = fakeClient([
      { match: LS_LONG, stdout: MIXED },
      // 降级路径也拿不到数据：仍是降级返回，而不是把目录变成打不开
      { match: LS_NAMES, code: 1, stderr: 'ls: nope' },
      { match: STAT, code: 1, stderr: 'stat: nope' },
    ])
    const result = await listDirDetailed(client, 'adb', '/sdcard/Download')
    expect(result.entries.map((e) => e.name)).toEqual(['a.txt', 'b.txt', 'sub'])
    expect(result.degraded).toBe(true)
    expect(result.unparsed).toBe(7)
    expect(result.usedFallback).toBe(true)
  })

  it('降级时用 ls -1A + stat 补齐乱码那 7 条，总数 10 条', async () => {
    const names = ['a.txt', 'b.txt', 'sub', ...Array.from({ length: 7 }, (_, i) => 'x' + i + '.bin')]
    const statOut = names
      .map((n) => '-rw-------|u0_a104|u0_a104|2|1794992106|/sdcard/Download/' + n)
      .join('\r\n') + '\r\n'
    const client = fakeClient([
      { match: LS_LONG, stdout: MIXED },
      { match: LS_NAMES, stdout: names.join('\r\n') + '\r\n' },
      { match: STAT, stdout: statOut },
    ])
    const result = await listDirDetailed(client, 'adb', '/sdcard/Download')
    expect(result.entries).toHaveLength(10)
    expect(result.entries.map((e) => e.name)).toContain('x6.bin')
    expect(result.degraded).toBe(true)
    // 已解析的条目保留 ls 的完整字段，不因降级被 stat 版本覆盖
    expect(result.entries.find((e) => e.name === 'a.txt')?.mtime).toBe(Date.UTC(2026, 10, 18, 8, 54))
  })

  it('未解析比例不超过 20% 时不降级', async () => {
    const text = [
      'total 12',
      ...Array.from({ length: 9 }, (_, i) => '-rw------- 1 u0_a104 u0_a104 2 2026-11-18 16:54 f' + i),
      '<<一条乱码>>',
    ].join('\r\n')
    const client = fakeClient([{ match: LS_LONG, stdout: text }])
    const result = await listDirDetailed(client, 'adb', '/d')
    expect(result.entries).toHaveLength(9)
    expect(result.degraded).toBe(false)
    expect(result.unparsed).toBe(1)
    expect(client.commands.filter((c) => LS_NAMES.test(c))).toHaveLength(0)
  })

  it('完全解析不出任何条目、降级也补不齐时才抛 E_PARSE_DEGRADED', async () => {
    const client = fakeClient([
      { match: LS_LONG, stdout: 'total 5\r\n<<1>>\r\n<<2>>\r\n' },
      { match: LS_NAMES, code: 1, stderr: 'ls: fail' },
      { match: STAT, code: 1, stderr: 'stat: fail' },
    ])
    await expect(listDir(client, 'adb', '/d')).rejects.toThrow(E_PARSE_DEGRADED)
  })

  it('完全解析不出但降级能补齐时，返回补齐条目 + degraded', async () => {
    const client = fakeClient([
      { match: LS_LONG, stdout: 'total 5\r\n<<1>>\r\n<<2>>\r\n' },
      { match: LS_NAMES, stdout: 'p.bin\r\nq.bin\r\n' },
      {
        match: STAT,
        stdout: '-rw-------|u0_a104|u0_a104|9|1794992106|/d/p.bin\r\n' +
          '-rw-------|u0_a104|u0_a104|9|1794992106|/d/q.bin\r\n',
      },
    ])
    const result = await listDirDetailed(client, 'adb', '/d')
    expect(result.entries.map((e) => e.name).sort()).toEqual(['p.bin', 'q.bin'])
    expect(result.degraded).toBe(true)
    expect(result.usedFallback).toBe(true)
  })

  it('降级路径的名字里含空格/中文时 stat 命令仍逐项转义', async () => {
    const client = fakeClient([
      { match: LS_LONG, stdout: 'total 1\r\n<<乱码>>\r\n' },
      { match: LS_NAMES, stdout: "测试 文件'1'.txt\r\n" },
      {
        match: STAT,
        stdout: "-rw-------|u0_a104|u0_a104|2|1794992106|/d/测试 文件'1'.txt\r\n",
      },
    ])
    await listDirDetailed(client, 'adb', '/d')
    const statCommand = client.commands.find((c) => STAT.test(c)) as string
    expect(statCommand).toContain(shellQuote("/d/测试 文件'1'.txt"))
    expect(statCommand.startsWith('LC_ALL=C stat -c ')).toBe(true)
  })
})

/* ============ 真机集成（本机无 adb / 无设备时跳过） ============ */

const ADB = process.platform === 'win32' ? 'adb.exe' : 'adb'
const SERIAL = '9N9CN2G0012A6F'

function adbReady(): boolean {
  try {
    const version = spawnSync(ADB, ['version'], { windowsHide: true, timeout: 15_000 })
    if (version.status !== 0) return false
    const devices = spawnSync(ADB, ['-s', SERIAL, 'get-state'], { windowsHide: true, timeout: 15_000 })
    return devices.status === 0 && String(devices.stdout).trim() === 'device'
  } catch {
    return false
  }
}

const HAS_DEVICE = adbReady()

const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length > 0) {
    const path = cleanup.pop() as string
    try {
      await new AdbClient(SERIAL).run(['shell', 'rm -rf ' + shellQuote(path)], { adbPath: ADB, timeoutMs: 30_000 })
    } catch {
      // 清理失败不影响断言结论，但会在下面的用例里被再次发现
    }
  }
})

describe('真机集成（skipIf 无设备）', () => {
  it.skipIf(!HAS_DEVICE)(
    '条目数与 ls -1A 的真实条数一致（解析器不丢条目，也不凭空造条目）',
    async () => {
      const client = new AdbClient(SERIAL)
      for (const dir of ['/sdcard', '/data/local/tmp', '/dev']) {
        const result = await listDirDetailed(client, ADB, dir)
        const names = await client.run(['shell', 'LC_ALL=C ls -1A -- ' + shellQuote(dir + '/')], {
          adbPath: ADB,
          timeoutMs: 60_000,
        })
        const expected = names.stdout.split('\n').filter((line) => line !== '').length
        expect(result.entries.length, dir + ' 条目数').toBe(expected)
        expect(result.degraded, dir + ' 是否降级').toBe(false)
      }
    },
    60_000,
  )

  it.skipIf(!HAS_DEVICE)('列举 /sdcard/Download：中文名逐字还原，无降级', async () => {
    const result = await listDirDetailed(new AdbClient(SERIAL), ADB, '/sdcard/Download')
    expect(result.degraded).toBe(false)
    expect(result.entries.length).toBeGreaterThan(0)
    expect(result.entries.some((e) => /[\u4e00-\u9fa5]/.test(e.name))).toBe(true)
    expect(result.entries.every((e) => e.name !== '' && !e.name.includes('\uFFFD'))).toBe(true)
  })

  it.skipIf(!HAS_DEVICE)('列举 / ：1970 年 mtime 不为 0、符号链接 isDir 为 false', async () => {
    const entries = await listDir(new AdbClient(SERIAL), ADB, '/')
    // 1970-01-01 08:01（设备时区 +08:00）== epoch + 60000ms
    expect(entries.find((e) => e.name === 'metadata')?.mtime).toBe(60_000)
    const sdcardLink = entries.find((e) => e.name === 'sdcard')
    expect(sdcardLink).toMatchObject({ isLink: true, isDir: false })
    expect(sdcardLink?.linkTargetResolved?.startsWith('/')).toBe(true)
  })

  it.skipIf(!HAS_DEVICE)('/data/app 权限不足映射为 E_NO_PERMISSION', async () => {
    await expect(listDir(new AdbClient(SERIAL), ADB, '/data/app')).rejects.toThrow(E_NO_PERMISSION)
  })

  it.skipIf(!HAS_DEVICE)('不存在的目录映射为 E_NOT_FOUND', async () => {
    await expect(listDir(new AdbClient(SERIAL), ADB, '/nope-t5/nope')).rejects.toThrow(E_NOT_FOUND)
  })

  // 裁决 5：中文 + 空格 + 单引号文件名的完整往返
  it.skipIf(!HAS_DEVICE)(
    "中文+空格+单引号文件名：真机创建 → 列举还原原名 → 用原名经 shellQuote 读回内容",
    async () => {
      const client = new AdbClient(SERIAL)
      const dir = '/sdcard/Download/t5 中文目录'
      const name = "测试 文件'1'.txt"
      cleanup.push(dir)
      await client.run(['shell', 'mkdir -p ' + shellQuote(dir)], { adbPath: ADB, timeoutMs: 30_000 })
      await client.run(['shell', 'printf hi > ' + shellQuote(joinPath(dir, name))], {
        adbPath: ADB,
        timeoutMs: 30_000,
      })

      const entries = await listDir(client, ADB, dir)
      expect(entries.map((e) => e.name)).toContain(name)
      const entry = entries.find((e) => e.name === name)
      expect(entry?.size).toBe(2)
      expect(entry?.isDir).toBe(false)

      // 用解析出来的名字再拼命令，必须能真的读到内容
      const cat = await client.run(['shell', 'cat ' + shellQuote(joinPath(dir, name))], {
        adbPath: ADB,
        timeoutMs: 30_000,
      })
      expect(cat.code).toBe(0)
      expect(cat.stdout.trim()).toBe('hi')
    },
    60_000,
  )
})
