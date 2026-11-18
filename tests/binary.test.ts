import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  buildCandidates,
  parseVersion,
  probe,
  resolveAdb,
  resolveOnPath,
  isShimPath,
  E_ADB_BAD_OUTPUT,
  E_ADB_NOT_EXECUTABLE,
  E_ADB_NOT_FOUND,
  E_ADB_SHIM_UNSUPPORTED,
  E_ADB_TIMEOUT,
} from '../electron/adb/binary'
import { adbChildCount, killAllAdbChildren } from '../electron/adb/children'

const isWin = process.platform === 'win32'

// 本机 PATH 里是否有真 adb：有才跑真实探测，没有就 skip。
// 夹具探测用 spawnSync + try/catch：探测本身失败不得让测试文件加载失败。
function adbOnPath(): boolean {
  try {
    const r = spawnSync(isWin ? 'adb.exe' : 'adb', ['version'], {
      windowsHide: true,
      timeout: 15_000,
    })
    return r.status === 0
  } catch {
    return false
  }
}

const HAS_ADB = adbOnPath()

// 慢速「假 adb」：findstr.exe 收到未知参数后转去读 stdin，会一直阻塞。
// 用它才能真实验证「probe 超时后子进程被回收」，不必依赖测试自己的 sleep。
// （先试过 waitfor.exe，但它被 taskkill 之后的下一次调用会立刻以退出码 1 结束，
//   导致后续用例偶发失败 —— 夹具本身不稳定，已弃用。）
const SLOW_EXE = isWin ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'findstr.exe') : ''

const dirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'task3-adb-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  killAllAdbChildren()
  // taskkill 是异步的：被杀进程的可执行文件在句柄释放前会锁住目录，
  // 直接 rmSync 会 EPERM。重试几轮，超时后放弃并把目录留给系统清理。
  for (let d = dirs.pop(); d !== undefined; d = dirs.pop()) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(d, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
  }
})

function writeFake(dir: string, name: string, content: string): string {
  const p = path.join(dir, name)
  writeFileSync(p, content)
  return p
}

// 一个「只要真被启动就必然留下痕迹」的 .cmd shim：
// 若实现把它交给 spawn，Node 22 会执行它并写标记，Node 24 会同步抛 EINVAL。
const SHIM_BODY = (marker: string): string => [
  '@echo off',
  'echo ran> "' + marker + '"',
  'echo Android Debug Bridge version 1.0.41',
  'echo Version 34.0.4-10411341',
].join('\r\n')

describe('binary', () => {
  // ---------- 纯函数 ----------
  it('候选顺序为 custom > env > bundled > path', () => {
    const list = buildCandidates({ custom: 'C:/x/adb.exe', env: 'D:/adb.exe', resourcesPath: 'R' })
    expect(list.map((c) => c.source)).toEqual(['custom', 'env', 'bundled', 'path'])
  })

  it('解析 adb version 输出', () => {
    const out = 'Android Debug Bridge version 1.0.41\nVersion 34.0.4-10411341'
    expect(parseVersion(out)).toEqual({ version: '1.0.41', build: '34.0.4-10411341' })
  })

  it('只有老版 Android Debug Bridge version 行时 build 为空串，不抛错', () => {
    expect(parseVersion('Android Debug Bridge version 1.0.31')).toEqual({
      version: '1.0.31',
      build: '',
    })
  })

  it('只有新版单独 Version 行时 version 为空串，不抛错', () => {
    expect(parseVersion('Version 35.0.2-12147458')).toEqual({
      version: '',
      build: '35.0.2-12147458',
    })
  })

  it('输出完全无法识别时返回双空串而不是抛错', () => {
    expect(parseVersion('adb: not found')).toEqual({ version: '', build: '' })
    expect(parseVersion('')).toEqual({ version: '', build: '' })
  })

  it('isShimPath 只认 .cmd/.bat，且大小写无关', () => {
    expect(isShimPath('C:/scoop/shims/adb.cmd')).toBe(true)
    expect(isShimPath('C:/x/adb.BAT')).toBe(true)
    expect(isShimPath('C:/x/adb.CmD')).toBe(true)
    expect(isShimPath('C:/x/adb.exe')).toBe(false)
    expect(isShimPath('adb')).toBe(false)
    expect(isShimPath('/usr/bin/adb.cmdx')).toBe(false)
  })

  // ---------- C2：resolveOnPath 的两类假阴性 ----------
  it.skipIf(!isWin)('resolveOnPath 优先 PATHEXT，同目录无扩展名 adb 不压过 adb.exe', () => {
    const dir = tmpDir()
    // 两个文件都真实存在：无扩展名的 'adb' 与 'adb.exe'
    writeFake(dir, 'adb', 'no-extension')
    const exe = writeFake(dir, 'adb.exe', 'MZ')
    const r = resolveOnPath('adb', dir, '.EXE;.CMD')
    // 大小写不敏感：Windows 上按 PATHEXT 拼出的是 adb.EXE，磁盘上是 adb.exe
    expect(r.kind).toBe('found')
    if (r.kind !== 'found') throw new Error('unreachable')
    expect(r.path.toLowerCase()).toBe(exe.toLowerCase())
  })

  it.skipIf(!isWin)('resolveOnPath 跳过前段 shim 继续扫描后段目录（scoop 场景）', () => {
    const shimDir = tmpDir()
    const realDir = tmpDir()
    const shim = writeFake(shimDir, 'adb.cmd', '@echo off\r\n')
    const real = writeFake(realDir, 'adb.exe', 'MZ')
    const env = shimDir + path.delimiter + realDir

    const r = resolveOnPath('adb', env, '.EXE;.CMD')

    expect(r.kind).toBe('found')
    if (r.kind !== 'found') throw new Error('unreachable')
    expect(r.path.toLowerCase()).toBe(real.toLowerCase())
    expect(r.path.toLowerCase()).not.toBe(shim.toLowerCase())
  })

  it.skipIf(!isWin)(
    'resolveOnPath 在同一目录内也要越过 shim 继续找真 exe（PATHEXT 把 .CMD 排前面时）',
    () => {
      const dir = tmpDir()
      writeFake(dir, 'adb.cmd', '@echo off\r\n')
      const real = writeFake(dir, 'adb.exe', 'MZ')

      // PATHEXT 顺序刻意把 .CMD 放前面：实现必须在同一目录内继续试下一个扩展名，
      // 不能一碰到 shim 就跳到下一个目录（那样会漏掉同目录的 adb.exe）。
      const r = resolveOnPath('adb', dir, '.CMD;.EXE')

      expect(r.kind).toBe('found')
      if (r.kind !== 'found') throw new Error('unreachable')
      expect(r.path.toLowerCase()).toBe(real.toLowerCase())
    },
  )

  it.skipIf(!isWin)('resolveOnPath 只有 shim 时返回 shimOnly 并带诊断，而不是 found', () => {
    const shimDir = tmpDir()
    const shim = writeFake(shimDir, 'adb.cmd', '@echo off\r\n')
    const r = resolveOnPath('adb', shimDir, '.EXE;.CMD')
    expect(r).toMatchObject({ kind: 'shimOnly' })
    if (r.kind !== 'shimOnly') throw new Error('unreachable')
    expect(r.skipped.map((s) => s.toLowerCase())).toContain(shim.toLowerCase())
  })

  it('resolveOnPath 空 PATH 返回 none', () => {
    expect(resolveOnPath('adb', '', '.EXE')).toEqual({ kind: 'none' })
  })

  it.skipIf(!isWin)('resolveOnPath 对已带扩展名的 name 不再追加扩展名', () => {
    const dir = tmpDir()
    const exe = writeFake(dir, 'adb.exe', 'MZ')
    expect(resolveOnPath('adb.exe', dir, '.EXE;.CMD')).toEqual({ kind: 'found', path: exe })
  })

  // ---------- 错误码 ----------
  it('probe 对 .cmd shim 返回 E_ADB_SHIM_UNSUPPORTED，且绝不把它交给 spawn', async () => {
    const dir = tmpDir()
    const marker = path.join(dir, 'shim-ran.txt')
    const shim = writeFake(dir, 'adb.cmd', SHIM_BODY(marker))

    const result = await probe(shim)

    expect(result).toMatchObject({ ok: false, code: E_ADB_SHIM_UNSUPPORTED })
    expect(existsSync(marker)).toBe(false)
  })

  it('probe 对 .BAT shim 同样返回 E_ADB_SHIM_UNSUPPORTED', async () => {
    const dir = tmpDir()
    const marker = path.join(dir, 'shim-ran.txt')
    const shim = writeFake(dir, 'ADB.BAT', SHIM_BODY(marker))

    const result = await probe(shim)

    expect(result).toMatchObject({ ok: false, code: E_ADB_SHIM_UNSUPPORTED })
    expect(existsSync(marker)).toBe(false)
  })

  it('probe 对不存在的文件返回 E_ADB_NOT_FOUND', async () => {
    const dir = tmpDir()
    const result = await probe(path.join(dir, 'no-such-adb.exe'))
    expect(result).toMatchObject({ ok: false, code: E_ADB_NOT_FOUND })
  })

  it('probe 对存在但无法执行的文件返回 E_ADB_NOT_EXECUTABLE', async () => {
    const dir = tmpDir()
    const fake = isWin
      ? writeFake(dir, 'fake-adb.exe', 'this is not a portable executable')
      : writeFake(dir, 'fake-adb', '#!/bin/sh\necho hi\n')
    const result = await probe(fake)
    expect(result).toMatchObject({ ok: false, code: E_ADB_NOT_EXECUTABLE })
  })

  it('probe 对能执行但输出不是 adb 版本的程序返回 E_ADB_BAD_OUTPUT', async () => {
    const result = await probe(process.execPath)
    expect(result).toMatchObject({ ok: false, code: E_ADB_BAD_OUTPUT })
  })

  // ---------- I2：裸名是唯一能绕过 shim 判定的通道 ----------
  it('probe 默认拒绝裸名，返回 E_ADB_NOT_FOUND 且不 spawn', async () => {
    // 若真的 spawn 裸名 'adb'，本机 PATH 里有真 adb，会返回 ok: true
    const result = await probe('adb')
    expect(result).toMatchObject({ ok: false, code: E_ADB_NOT_FOUND })
  })

  it('probe 显式 allowBareName 才放行裸名（仅测试注入场景）', async () => {
    const result = await probe('adb', { allowBareName: true })
    if (HAS_ADB) {
      expect(result).toMatchObject({ ok: true })
    } else {
      expect(result).toMatchObject({ ok: false, code: E_ADB_NOT_FOUND })
    }
  })

  // ---------- C1：probe 必须登记进全局子进程表并走 killTree ----------
  it.skipIf(!isWin)(
    'probe 超时后子进程被回收：adbChildCount 归零且返回 E_ADB_TIMEOUT',
    async () => {
      // waitfor.exe 传未知参数会一直阻塞，是稳定的「不响应」进程
      const startedAt = Date.now()
      const result = await probe(SLOW_EXE, { timeoutMs: 300 })
      const elapsed = Date.now() - startedAt

      expect(result).toMatchObject({ ok: false, code: E_ADB_TIMEOUT })
      expect(adbChildCount()).toBe(0)
      // 超时必须真的按时触发，不能被 4s 默认值吃掉
      expect(elapsed).toBeLessThan(2_000)
    },
    20_000,
  )

  it.skipIf(!isWin)(
    'probe 进行中关窗：killAllAdbChildren 能枚举到 probe 的子进程',
    async () => {
      const pending = probe(SLOW_EXE, { timeoutMs: 10_000 })
      // 子进程已 spawn、尚未退出 —— 此刻登记表里必须看得到它，
      // 否则 before-quit 的 killAllAdbChildren() 根本回收不到。
      await new Promise((r) => setTimeout(r, 500))
      expect(adbChildCount()).toBe(1)

      killAllAdbChildren()
      expect(adbChildCount()).toBe(0)
      await expect(pending).resolves.toBeDefined()
    },
    20_000,
  )

  // ---------- I3：总预算 ----------
  it.skipIf(!isWin)('resolveAdb 总预算耗尽后不再探测剩余候选，直接记 E_ADB_TIMEOUT', async () => {
    const dir = tmpDir()
    const slow = path.join(dir, 'slow-adb.exe')
    // 复制一份「慢 adb」到临时目录，作为 custom / env 两个候选
    const { copyFileSync } = await import('node:fs')
    copyFileSync(SLOW_EXE, slow)

    const startedAt = Date.now()
    const result = await resolveAdb(
      // 刻意传一个远超预算的 timeoutMs：单次探测也必须被总预算夹住
      { custom: slow, env: slow, resourcesPath: dir },
      { totalBudgetMs: 400, timeoutMs: 10_000 },
    )
    const elapsed = Date.now() - startedAt

    expect(result.resolved).toBeNull()
    // 总预算 400ms：不能退化成 4 个候选各 10s
    expect(elapsed).toBeLessThan(3_000)
    // 第一个候选被预算夹到 ~400ms 超时，其余候选预算已耗尽，一律记 TIMEOUT
    expect(result.attempts.map((a) => a.code)).toEqual([
      E_ADB_TIMEOUT,
      E_ADB_TIMEOUT,
      E_ADB_TIMEOUT,
      E_ADB_TIMEOUT,
    ])
  }, 30_000)

  // ---------- resolveAdb 组合 ----------
  it('resolveAdb 逐个校验候选：shim 被标为不可用并继续试下一个，永不执行它', async () => {
    const dir = tmpDir()
    const marker = path.join(dir, 'shim-ran.txt')
    const shim = writeFake(dir, 'adb.cmd', SHIM_BODY(marker))

    const result = await resolveAdb({
      custom: shim,
      env: path.join(dir, 'no-such-adb.exe'),
      resourcesPath: dir,
      // 显式清空 PATH，避免本机真 adb 让断言依赖环境
      pathEnv: '',
    })

    expect(existsSync(marker)).toBe(false)
    expect(result.attempts.map((a) => a.code)).toEqual([
      E_ADB_SHIM_UNSUPPORTED,
      E_ADB_NOT_FOUND,
      E_ADB_NOT_FOUND,
      E_ADB_NOT_FOUND,
    ])
    expect(result.resolved).toBeNull()
  })

  it.skipIf(!isWin)(
    'C2 回归：PATH 前段是 shim、后段有真 adb 时，resolveAdb 必须定位到后段的真 adb',
    async () => {
      const shimDir = tmpDir()
      const realDir = tmpDir()
      const marker = path.join(shimDir, 'shim-ran.txt')
      writeFake(shimDir, 'adb.cmd', SHIM_BODY(marker))
      // 后段放一份真 adb 的副本：复制本机 PATH 上的 adb.exe
      const realAdb = resolveOnPath('adb.exe', process.env.PATH ?? '', '.EXE')
      if (realAdb.kind !== 'found') throw new Error('fixture: 本机应有 adb.exe')
      const { copyFileSync } = await import('node:fs')
      const tail = path.join(realDir, 'adb.exe')
      copyFileSync(realAdb.path, tail)

      const result = await resolveAdb({
        custom: path.join(shimDir, 'nope.exe'),
        env: path.join(shimDir, 'nope2.exe'),
        resourcesPath: shimDir,
        pathEnv: shimDir + path.delimiter + realDir,
        pathext: '.EXE;.CMD',
      })

      // 关键：不能因为前段 shim 就报「未找到」，必须扫到后段的真 adb
      expect(result.resolved?.source).toBe('path')
      expect(result.resolved?.path.toLowerCase()).toBe(tail.toLowerCase())
      expect(result.resolved?.version).not.toBe('')
      // shim 从未被执行
      expect(existsSync(marker)).toBe(false)
    },
    30_000,
  )

  it.skipIf(!isWin)(
    'C2 回归：PATH 里只有 shim 时返回 null，且 attempts 带被跳过的诊断',
    async () => {
      const shimDir = tmpDir()
      writeFake(shimDir, 'adb.cmd', '@echo off\r\n')
      const result = await resolveAdb({
        custom: path.join(shimDir, 'nope.exe'),
        env: path.join(shimDir, 'nope2.exe'),
        resourcesPath: shimDir,
        pathEnv: shimDir,
        pathext: '.EXE;.CMD',
      })

      expect(result.resolved).toBeNull()
      const pathAttempt = result.attempts.find((a) => a.source === 'path')
      expect(pathAttempt).toMatchObject({ ok: false, code: E_ADB_SHIM_UNSUPPORTED })
      expect(pathAttempt?.skippedShims?.length).toBe(1)
    },
    30_000,
  )

  // ---------- 真实 adb 集成 ----------
  it.skipIf(!HAS_ADB)('probe 真实 adb：解析出版本与 build', async () => {
    const real = resolveOnPath(isWin ? 'adb.exe' : 'adb', process.env.PATH ?? '', '.EXE;.CMD')
    if (real.kind !== 'found') throw new Error('fixture: 应能在 PATH 上解析到 adb')
    const result = await probe(real.path)
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('unreachable')
    expect(result.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(result.build.length).toBeGreaterThan(0)
  })

  it.skipIf(!HAS_ADB)('resolveAdb 在真实环境定位到 PATH 中的 adb', async () => {
    const dir = tmpDir()
    const result = await resolveAdb({
      custom: path.join(dir, 'no-custom-adb.exe'),
      env: path.join(dir, 'no-env-adb.exe'),
      resourcesPath: dir,
    })
    expect(result.resolved).toMatchObject({ source: 'path' })
    // 必须解析成绝对路径：否则 shim 检查拿不到扩展名，等于没检查
    expect(path.isAbsolute(result.resolved?.path ?? '')).toBe(true)
    expect(result.resolved?.build.length).toBeGreaterThan(0)
    // custom / env / bundled 三个失败 + path 命中 = 4 条探测记录
    expect(result.attempts.length).toBe(4)
    expect(result.attempts.slice(0, 3).every((a) => !a.ok)).toBe(true)
  })

  it.skipIf(HAS_ADB)('全部候选都不可用时 resolveAdb 返回 null（仅无 adb 的机器执行）', async () => {
    const dir = tmpDir()
    const result = await resolveAdb({
      custom: path.join(dir, 'no-custom-adb.exe'),
      env: path.join(dir, 'no-env-adb.exe'),
      resourcesPath: dir,
    })
    expect(result.resolved).toBeNull()
    expect(result.attempts.length).toBe(4)
  })

  // 反证：守卫确实承重 —— 不拦的话 spawn 在本机 Node 上会以 EINVAL 同步抛错，
  // 正是 CVE-2024-27980 修复后的行为，也是「为什么要提前拦 shim」的证据。
  it.skipIf(!isWin)('绕过守卫直接 spawn .cmd 会 EINVAL（证明 shim 拦截不是多余）', () => {
    const dir = tmpDir()
    const shim = writeFake(dir, 'adb.cmd', SHIM_BODY(path.join(dir, 'shim-ran.txt')))
    const r = spawnSync(shim, ['version'], { windowsHide: true })
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code
    expect(code).toBe('EINVAL')
    expect(r.status).toBeNull()
  })
})
