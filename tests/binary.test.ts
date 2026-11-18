import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  buildCandidates,
  parseVersion,
  probe,
  resolveAdb,
  isShimPath,
  E_ADB_BAD_OUTPUT,
  E_ADB_NOT_EXECUTABLE,
  E_ADB_NOT_FOUND,
  E_ADB_SHIM_UNSUPPORTED,
} from '../electron/adb/binary'

// 本机 PATH 里是否有真 adb：有才跑真实探测，没有就 skip。
// 夹具探测用 spawnSync + try/catch：探测本身失败不得让测试文件加载失败。
function adbOnPath(): boolean {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'adb.exe' : 'adb', ['version'], {
      windowsHide: true,
      timeout: 15_000,
    })
    return r.status === 0
  } catch {
    return false
  }
}

const HAS_ADB = adbOnPath()

const dirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'task3-adb-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (let d = dirs.pop(); d !== undefined; d = dirs.pop()) {
    rmSync(d, { recursive: true, force: true })
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

  it('probe 对 .cmd shim 返回 E_ADB_SHIM_UNSUPPORTED，且绝不把它交给 spawn', async () => {
    const dir = tmpDir()
    const marker = path.join(dir, 'shim-ran.txt')
    const shim = writeFake(dir, 'adb.cmd', SHIM_BODY(marker))

    const result = await probe(shim)

    expect(result).toMatchObject({ ok: false, code: E_ADB_SHIM_UNSUPPORTED })
    // 真被 spawn 过就一定会写标记：Node 22 会执行它，Node 24 在 EINVAL 前也不留痕但会返回别的错误码
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
    // 伪造一个「存在但不是可执行镜像」的文件：Windows 上 spawn 同步抛错，POSIX 上异步 EACCES
    const fake = process.platform === 'win32'
      ? writeFake(dir, 'fake-adb.exe', 'this is not a portable executable')
      : writeFake(dir, 'fake-adb', '#!/bin/sh\necho hi\n')
    const result = await probe(fake)
    expect(result).toMatchObject({ ok: false, code: E_ADB_NOT_EXECUTABLE })
  })

  it('probe 对能执行但输出不是 adb 版本的程序返回 E_ADB_BAD_OUTPUT', async () => {
    // node 收到 "version" 当脚本路径，退出码非 0 且输出里没有版本行
    const result = await probe(process.execPath)
    expect(result).toMatchObject({ ok: false, code: E_ADB_BAD_OUTPUT })
  })

  it('resolveAdb 逐个校验候选：shim 被标为不可用并继续试下一个，永不执行它', async () => {
    const dir = tmpDir()
    const marker = path.join(dir, 'shim-ran.txt')
    const shim = writeFake(dir, 'adb.cmd', SHIM_BODY(marker))

    const result = await resolveAdb({
      custom: shim,
      env: path.join(dir, 'no-such-adb.exe'),
      resourcesPath: dir,
    })

    expect(existsSync(marker)).toBe(false)
    expect(result.attempts.map((a) => a.code)).toContain(E_ADB_SHIM_UNSUPPORTED)
    expect(result.resolved?.source).not.toBe('custom')
    if (HAS_ADB) {
      expect(result.resolved?.source).toBe('path')
      expect(result.resolved?.version).not.toBe('')
    } else {
      expect(result.resolved).toBeNull()
    }
  })

  // 反证：守卫确实承重 —— 不拦的话 spawn 在本机 Node 上会以 EINVAL 同步抛错，
  // 正是 CVE-2024-27980 修复后的行为，也是「为什么要提前拦 shim」的证据。
  it.skipIf(process.platform !== 'win32')(
    '绕过守卫直接 spawn .cmd 会 EINVAL（证明 shim 拦截不是多余）',
    () => {
      const dir = tmpDir()
      const shim = writeFake(dir, 'adb.cmd', SHIM_BODY(path.join(dir, 'shim-ran.txt')))
      const r = spawnSync(shim, ['version'], { windowsHide: true })
      const code = (r.error as NodeJS.ErrnoException | undefined)?.code
      expect(code).toBe('EINVAL')
      expect(r.status).toBeNull()
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'PATH 里解析到 .cmd shim 时同样标记 E_ADB_SHIM_UNSUPPORTED，绝不执行',
    async () => {
      const dir = tmpDir()
      const marker = path.join(dir, 'shim-ran.txt')
      writeFake(dir, 'adb.cmd', SHIM_BODY(marker))

      // 注入只含该目录的 PATH：候选 'path' 会在这里解析到 adb.cmd
      const result = await resolveAdb({
        custom: path.join(dir, 'no-custom-adb.exe'),
        env: path.join(dir, 'no-env-adb.exe'),
        resourcesPath: dir,
        pathEnv: dir,
        pathext: '.EXE;.CMD',
      })

      expect(existsSync(marker)).toBe(false)
      expect(result.resolved).toBeNull()
      const pathAttempt = result.attempts.find((a) => a.source === 'path')
      expect(pathAttempt).toMatchObject({ ok: false, code: E_ADB_SHIM_UNSUPPORTED })
      // 解析出来的必须是绝对路径（扩展名可见），而不是裸名 'adb'；
      // 大小写不敏感：Windows 上按 PATHEXT 拼出的是 adb.CMD，而磁盘上是 adb.cmd。
      expect(path.isAbsolute(pathAttempt?.path ?? '')).toBe(true)
      expect((pathAttempt?.path ?? '').toLowerCase()).toBe(path.join(dir, 'adb.cmd').toLowerCase())
    },
  )

  it.skipIf(!HAS_ADB)('probe 真实 adb：解析出版本与 build', async () => {
    const result = await probe(process.platform === 'win32' ? 'adb.exe' : 'adb')
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
})
