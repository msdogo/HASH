import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { E_OUTSIDE_ROOT } from '../src/shared/errors'
import { LocalFs, checkLocalAccess } from '../electron/fs/local'

/*
 * 裁决 5：本地双栏必须限制访问范围。
 *
 * 规格说「本地写入限制在用户选定根目录内」。三条逃逸路径都要拦：
 *   1. 直接给一个根目录之外的路径；
 *   2. 用 .. 跳出去；
 *   3. 根目录内有一个符号链接指向外部（词法检查看不出来，必须 realpath）。
 *
 * 这里用真实临时目录 + 真实符号链接，而不是 mock ——
 * 符号链接逃逸是否被拦住完全取决于「有没有真的调 realpath」，
 * mock 掉 realpath 就等于把要测的东西测掉了。
 */

let base = ''
let root = ''
let outside = ''

beforeAll(() => {
  // 用一个独立的临时目录当「用户主目录」，旁边放一个「外部」目录
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'adbfm-local-')))
  root = path.join(base, 'home')
  outside = path.join(base, 'outside')
  mkdirSync(path.join(root, 'docs'), { recursive: true })
  mkdirSync(path.join(root, '空目录'), { recursive: true })
  writeFileSync(path.join(root, 'a.txt'), 'hello')
  mkdirSync(outside, { recursive: true })
  writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  /*
   * 根目录内的符号链接，指向根外面的目录 —— 典型的逃逸手法。
   *
   * Windows 上创建目录符号链接需要管理员权限，所以先试 'dir'，失败退回 'junction'：
   * junction 只用于目录且不需要额外权限，realpath 行为与符号链接一致
   * （逃逸检测靠的是 realpath 的结果，不是链接的创建方式）。
   */
  const linkPath = path.join(root, '逃逸链接')
  try {
    symlinkSync(outside, linkPath, 'dir')
  } catch {
    symlinkSync(outside, linkPath, 'junction')
  }
  /*
   * 目录都建好之后，把 root / outside 换成 **realpath 规范形**。
   *
   * 为什么必须做：Windows 的临时目录是 8.3 短名（ADMINI~1），而 realpath 返回长名
   * （Administrator）。被测代码返回的是 realpath 之后的路径 —— 那是**正确**的
   * （判定路径与实际 IO 路径必须同一个）。测试若拿短名去比，红的是断言而不是实现。
   */
  // 用 native 版：普通 realpathSync 在部分 Windows 配置下会原样返回 8.3 短名
  root = realpathSync.native(root)
  outside = realpathSync.native(outside)
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

function fs(): LocalFs {
  return new LocalFs({ root: () => root })
}

describe('本地目录列举', () => {
  it('列出条目、区分目录与文件、带大小与时间', async () => {
    const result = await fs().list(root)
    expect(result.cwd).toBe(root)
    const names = result.items.map((item) => item.name).sort()
    expect(names).toEqual(['a.txt', 'docs', '空目录', '逃逸链接'].sort())
    const file = result.items.find((item) => item.name === 'a.txt')
    expect(file?.isDir).toBe(false)
    expect(file?.size).toBe(5)
    const dir = result.items.find((item) => item.name === 'docs')
    expect(dir?.isDir).toBe(true)
  })

  it('符号链接条目标 isLink 且不跟随到目录（isDir=false）', async () => {
    const result = await fs().list(root)
    const link = result.items.find((item) => item.name === '逃逸链接')
    expect(link?.isLink).toBe(true)
    expect(link?.isDir).toBe(false)
  })

  it('cwd 缺省时用根目录；parent 在根处为 null', async () => {
    const result = await fs().list(undefined)
    expect(result.cwd).toBe(root)
    expect(result.parent).toBe(null)
  })

  it('子目录的 parent 指向上一层', async () => {
    const result = await fs().list(path.join(root, 'docs'))
    expect(result.parent).toBe(root)
  })

  it('目录不存在 → 抛 E_NOT_FOUND（不是空列表）', async () => {
    await expect(fs().list(path.join(root, '不存在'))).rejects.toThrow('E_NOT_FOUND')
  })

  it('传的是文件而不是目录 → E_NOT_A_DIRECTORY', async () => {
    await expect(fs().list(path.join(root, 'a.txt'))).rejects.toThrow('E_NOT_A_DIRECTORY')
  })
})

describe('裁决 5：根目录限制', () => {
  it('根目录之外的路径直接拒（E_OUTSIDE_ROOT）', async () => {
    await expect(fs().list(outside)).rejects.toThrow(E_OUTSIDE_ROOT)
  })

  it('用 .. 逃出去也拒；词法归一后越界必须被抓住', async () => {
    const escaping = path.join(root, '..', 'outside')
    await expect(fs().list(escaping)).rejects.toThrow(E_OUTSIDE_ROOT)
  })

  it('多级 .. 同样拒（不是「只要还在 base 里就放行」）', async () => {
    await expect(fs().list(path.join(root, 'docs', '..', '..', 'outside'))).rejects.toThrow(E_OUTSIDE_ROOT)
  })

  it('符号链接逃逸被 realpath 拦住（词法检查看不出来的那条）', async () => {
    // 词法上它在根目录内，只有 realpath 才能看出指向外部
    await expect(fs().list(path.join(root, '逃逸链接'))).rejects.toThrow(E_OUTSIDE_ROOT)
  })

  it('根目录自身可访问（含相等）', async () => {
    expect((await fs().list(root)).cwd).toBe(root)
  })

  it('前缀相同的兄弟目录不会被误判为在根内', async () => {
    mkdirSync(root + '2', { recursive: true })
    try {
      await expect(fs().list(root + '2')).rejects.toThrow(E_OUTSIDE_ROOT)
    } finally {
      rmSync(root + '2', { recursive: true, force: true })
    }
  })
})

describe('checkLocalAccess（写入前的路径闸门）', () => {
  it('根内的新路径可以访问（即使文件还不存在 —— 新建文件要用它）', async () => {
    const verdict = await checkLocalAccess(root, path.join(root, 'docs', '新文件.txt'))
    expect(verdict).toEqual({ ok: true, path: path.join(root, 'docs', '新文件.txt') })
  })

  it('根外拒；错误码是 E_OUTSIDE_ROOT', async () => {
    const verdict = await checkLocalAccess(root, path.join(outside, 'x.txt'))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe(E_OUTSIDE_ROOT)
  })

  it('.. 逃逸拒', async () => {
    const verdict = await checkLocalAccess(root, path.join(root, '..', 'outside', 'x.txt'))
    expect(verdict.ok).toBe(false)
  })

  it('不存在的中间目录也会被 realpath 逐级解析后判对（不会因 ENOENT 放行）', async () => {
    const verdict = await checkLocalAccess(root, path.join(root, 'not-created-yet', 'deep', 'file.txt'))
    expect(verdict.ok).toBe(true)
  })

  it('符号链接逃逸拒（写入路径经由链接指向外部）', async () => {
    const verdict = await checkLocalAccess(root, path.join(root, '逃逸链接', 'x.txt'))
    expect(verdict.ok).toBe(false)
  })

  it('含控制字符的本地路径拒（E_INVALID_PATH）', async () => {
    const verdict = await checkLocalAccess(root, path.join(root, 'a\nb'))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('E_INVALID_PATH')
  })
})
