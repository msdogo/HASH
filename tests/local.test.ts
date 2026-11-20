import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { E_INVALID_PATH, E_NOT_A_DIRECTORY, E_NOT_FOUND } from '../src/shared/errors'
import { LocalFs, resolveLocalPath } from '../electron/fs/local'
import { isInsideRoot } from '../src/shared/path-guard'
import { makeOutsideHomeDir, realHome } from './outside-home'

/*
 * 本地栏的目录列举与路径闸门。
 *
 * ===== R2-1：本地根目录沙箱已由用户裁决移除 =====
 * 修前这里是「裁决 5：本地双栏必须限制访问范围」—— 根外路径、.. 逃逸、
 * 符号链接逃逸一律 E_OUTSIDE_ROOT。用户实测「从资源管理器拖文件到设备」
 * 被这道闸门拒绝，明确要求彻底移除本地根目录限制。
 *
 * 所以本文件的断言重心变了：
 *   1. **根外现在必须能访问**（行为证据：真的列出来，不是「不抛 E_OUTSIDE_ROOT」这种空断言）；
 *   2. **不再有任何越界拦截**：.. 与符号链接都按解析后的真实位置正常工作；
 *   3. 仍然保留的部分必须继续成立：语法校验（空/控制字符/非绝对路径 → E_INVALID_PATH）、
 *      realpath 归一化、存在性与类型检查。
 *
 * 这里用真实临时目录 + 真实符号链接，而不是 mock ——
 * realpath 归一化是否生效完全取决于「有没有真的调 realpath」，
 * mock 掉 realpath 就等于把要测的东西测掉了。
 */

let base = ''
let home = ''
/**
 * 「根外」样本：**主目录之外**的真实目录。
 *
 * 不能图省事用临时目录 —— Windows 上 os.tmpdir() 就在主目录里
 * （C:\Users\X\AppData\Local\Temp），那样「根外必须可用」的用例
 * 在把根判定加回去时**也不会红**，等于没测。见 tests/outside-home.ts。
 */
let outside = ''

beforeAll(() => {
  // base 是「系统临时目录」这一层；home 原来的角色是「用户选定的根」，现在只是起始浏览目录
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'adbfm-local-')))
  home = path.join(base, 'home')
  const outsideDir = makeOutsideHomeDir()
  if (outsideDir === null) throw new Error('本机找不到主目录之外的可写目录，无法验证 R2-1')
  outside = outsideDir
  mkdirSync(path.join(home, 'docs'), { recursive: true })
  mkdirSync(path.join(home, '空目录'), { recursive: true })
  writeFileSync(path.join(home, 'a.txt'), 'hello')
  mkdirSync(outside, { recursive: true })
  writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  /*
   * home 内一个指向 home 之外的符号链接。
   *
   * R2-1 之前它是「逃逸手法」，现在只是**一个普通链接**：列表里按链接显示，
   * 双击进入时按它真正指向的位置工作（下面有用例证明它真的能用）。
   *
   * Windows 上创建目录符号链接需要管理员权限，所以先试 'dir'，失败退回 'junction'：
   * junction 只用于目录且不需要额外权限，realpath 行为与符号链接一致。
   */
  const linkPath = path.join(home, '外部链接')
  try {
    symlinkSync(outside, linkPath, 'dir')
  } catch {
    symlinkSync(outside, linkPath, 'junction')
  }
  /*
   * 目录都建好之后换成 **realpath 规范形**。
   *
   * 为什么必须做：Windows 的临时目录是 8.3 短名（ADMINI~1），而 realpath 返回长名。
   * 被测代码返回的是 realpath 之后的路径 —— 那是**正确**的
   * （判定路径与实际 IO 路径必须同一个）。测试若拿短名去比，红的是断言而不是实现。
   */
  home = realpathSync.native(home)
  outside = realpathSync.native(outside)
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
  if (outside !== '') rmSync(outside, { recursive: true, force: true })
})

function fs(): LocalFs {
  return new LocalFs({ startDir: () => home })
}

describe('本地目录列举', () => {
  it('列出条目、区分目录与文件、带大小与时间', async () => {
    const result = await fs().list(home)
    expect(result.cwd).toBe(home)
    const names = result.items.map((item) => item.name).sort()
    expect(names).toEqual(['a.txt', 'docs', '空目录', '外部链接'].sort())
    const file = result.items.find((item) => item.name === 'a.txt')
    expect(file?.isDir).toBe(false)
    expect(file?.size).toBe(5)
    const dir = result.items.find((item) => item.name === 'docs')
    expect(dir?.isDir).toBe(true)
  })

  it('符号链接条目标 isLink 且不跟随到目录（isDir=false）', async () => {
    const result = await fs().list(home)
    const link = result.items.find((item) => item.name === '外部链接')
    expect(link?.isLink).toBe(true)
    expect(link?.isDir).toBe(false)
  })

  it('dir 缺省时用起始浏览目录；startDir 字段如实回报它', async () => {
    const result = await fs().list(undefined)
    expect(result.cwd).toBe(home)
    // startDir 走 shared/path-guard 的 normalizeLocalPath，分隔符统一成正斜杠
    expect(result.startDir).toBe(home.replace(/\\/g, '/'))
  })

  it('子目录的 parent 指向上一层', async () => {
    const result = await fs().list(path.join(home, 'docs'))
    expect(result.parent).toBe(home)
  })

  it('目录不存在 → 抛 E_NOT_FOUND（不是空列表）', async () => {
    await expect(fs().list(path.join(home, '不存在'))).rejects.toThrow(E_NOT_FOUND)
  })

  it('传的是文件而不是目录 → E_NOT_A_DIRECTORY', async () => {
    await expect(fs().list(path.join(home, 'a.txt'))).rejects.toThrow(E_NOT_A_DIRECTORY)
  })
})

/*
 * 【R2-1 核心】原 describe('裁决 5：根目录限制') 的 6 条用例在这里改写。
 *
 * 修前它们断言「根外被拒（E_OUTSIDE_ROOT）」。沙箱移除后必须断言相反的
 * **行为事实**：根外目录能真的列出来、条目内容对得上。
 * 只写「不再报 E_OUTSIDE_ROOT」是空断言（那个码已经不存在，任何实现都不报），
 * 所以每一条都用**返回的 cwd/条目**作为证据。
 */
describe('R2-1：本地访问不再有根目录限制（主目录之外必须可用）', () => {
  it('前提：样本目录真的在主目录之外（否则这一组用例是空转）', () => {
    expect(isInsideRoot(realHome(), outside)).toBe(false)
    expect(isInsideRoot(home, outside)).toBe(false)
  })

  it('直接列举主目录之外的目录 → 成功，cwd 是那个真实路径，文件真的列出来了', async () => {
    const result = await fs().list(outside)
    expect(result.cwd).toBe(outside)
    expect(result.items.map((item) => item.name)).toContain('secret.txt')
  })

  it('用 .. 跳出起始目录 → 成功（归一化后就是那个真实目录）', async () => {
    const escaping = path.join(home, '..')
    const result = await fs().list(escaping)
    expect(result.cwd).toBe(realpathSync.native(base))
  })

  it('起始目录里的符号链接指向主目录之外 → 跟随到真实位置（realpath 归一化仍在，但不再拦）', async () => {
    const result = await fs().list(path.join(home, '外部链接'))
    // 返回的是链接**指向**的真实路径：同一个目录，只是名字换了
    expect(result.cwd).toBe(outside)
    expect(result.items.map((item) => item.name)).toContain('secret.txt')
  })

  it('前缀相同的兄弟目录（home2）正常可列，不会因为名字像 home 就被判成别的', async () => {
    mkdirSync(home + '2', { recursive: true })
    try {
      const result = await fs().list(home + '2')
      expect(result.cwd).toBe(realpathSync.native(home + '2'))
      expect(result.items).toEqual([])
    } finally {
      rmSync(home + '2', { recursive: true, force: true })
    }
  })

  it('向上导航能走出旧的「根」，一路到盘符：parent 只在盘符处为 null', async () => {
    // base 是 home 的上一级（在旧语义里已经在「根」之外）
    const up = await fs().list(path.dirname(home))
    expect(up.cwd).toBe(realpathSync.native(path.dirname(home)))
    expect(up.items.map((item) => item.name)).toContain('home')
    expect(up.parent).not.toBeNull()

    // 盘符本身：能列，且 parent 为 null（真的没有上一级了）
    const driveRoot = path.parse(base).root
    const top = await fs().list(driveRoot)
    expect(top.parent).toBeNull()
    expect(top.cwd).toBe(realpathSync.native(driveRoot))
  })
})

describe('resolveLocalPath（写入前的路径闸门；R2-1 后不再判根）', () => {
  it('起始目录内的新路径可以解析（即使文件还不存在 —— 新建文件要用它）', async () => {
    const verdict = await resolveLocalPath(path.join(home, 'docs', '新文件.txt'))
    expect(verdict).toEqual({ ok: true, path: path.join(home, 'docs', '新文件.txt') })
  })

  it('主目录之外的新路径同样可以解析（R2-1 的行为证据：返回的就是那个路径本身）', async () => {
    const target = path.join(outside, 'x.txt')
    expect(isInsideRoot(realHome(), target)).toBe(false)
    const verdict = await resolveLocalPath(target)
    expect(verdict).toEqual({ ok: true, path: target })
  })

  it('.. 不再被拒，而是被归一化成真实路径', async () => {
    const verdict = await resolveLocalPath(path.join(home, '..', 'x.txt'))
    expect(verdict).toEqual({ ok: true, path: path.join(realpathSync.native(base), 'x.txt') })
  })

  it('不存在的中间目录也会被逐级解析后判对（不会因 ENOENT 变成非法路径）', async () => {
    const verdict = await resolveLocalPath(path.join(home, 'not-created-yet', 'deep', 'file.txt'))
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.path).toBe(path.join(home, 'not-created-yet', 'deep', 'file.txt'))
  })

  it('经由符号链接的写入路径被解析成链接指向的真实位置（判定路径 = 执行路径）', async () => {
    const verdict = await resolveLocalPath(path.join(home, '外部链接', 'x.txt'))
    expect(verdict).toEqual({ ok: true, path: path.join(outside, 'x.txt') })
  })

  it('含控制字符的本地路径拒（E_INVALID_PATH）', async () => {
    const verdict = await resolveLocalPath(path.join(home, 'a\nb'))
    expect(verdict).toEqual({ ok: false, code: E_INVALID_PATH })
  })

  it('空串 / 纯空白 / 非绝对路径 → E_INVALID_PATH（这三条必须继续拦住）', async () => {
    expect(await resolveLocalPath('')).toEqual({ ok: false, code: E_INVALID_PATH })
    expect(await resolveLocalPath('   ')).toEqual({ ok: false, code: E_INVALID_PATH })
    expect(await resolveLocalPath('relative/path.txt')).toEqual({ ok: false, code: E_INVALID_PATH })
    expect(await resolveLocalPath('./a.txt')).toEqual({ ok: false, code: E_INVALID_PATH })
  })
})
