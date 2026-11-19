import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertPlatformTools } from '../scripts/assert-platform-tools.mjs'

/**
 * 构建关键路径的单测（复审 Minor-4）。
 *
 * 为什么这些用例值得写：`assert-platform-tools.mjs` 是「缺 adb 就打包失败」这条
 * 防呆的唯一实现，但它的三道调用点（dist 脚本链 / beforePack / afterPack）全在
 * 构建期才跑。没有单测的话，将来有人重构它的判定逻辑，CI 不会有任何反应 ——
 * 而它的错误就是「静默打出没有 adb 的包」，发现成本极高。
 *
 * 两条注入点让这些用例既不依赖真实 adb 二进制、也不在临时目录里造 .exe
 * （Windows 上伪造可执行文件是不可移植的黑魔法）：
 * - `root`：把查找根指到临时目录，控制「目录/文件在不在」；
 * - `probe`：替换 `adb version` 的执行结果，控制「跑不跑得起来」。
 */

const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb'

let root: string

beforeEach(() => {
  // 每个用例一个干净的 root：它下面应该有 resources/platform-tools/
  root = mkdtempSync(path.join(tmpdir(), 'adb-fm-assert-test-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造出 <root>/resources/platform-tools/adb.exe 这个文件（内容无所谓，probe 是注入的）。 */
function makeExe(): string {
  const dir = path.join(root, 'resources', 'platform-tools')
  mkdirSync(dir, { recursive: true })
  const exePath = path.join(dir, EXE)
  writeFileSync(exePath, 'fake')
  return exePath
}

describe('assertPlatformTools（构建闸门的判定逻辑）', () => {
  it('目录不存在 -> 抛错，信息含「目录不存在」与可读的修复指引', () => {
    // root 下什么都不建
    expect(() => assertPlatformTools({ root })).toThrowError(/目录不存在/)
    // 指引必须真的可操作，而不只是「出错了」：要告诉用户怎么办
    expect(() => assertPlatformTools({ root })).toThrowError(/fetch-platform-tools/)
    expect(() => assertPlatformTools({ root })).toThrowError(/构建中止/)
  })

  it('目录在但 adb.exe 不存在 -> 抛错，信息含「文件不存在」', () => {
    mkdirSync(path.join(root, 'resources', 'platform-tools'), { recursive: true })
    expect(() => assertPlatformTools({ root })).toThrowError(/文件不存在/)
  })

  it('adb.exe 存在但跑不起来 -> 抛错，信息含「跑不起来」与底层原因', () => {
    makeExe()
    // 注入一个「执行失败」的探测结果：模拟 spawn 报错/非零退出/输出认不出
    expect(() =>
      assertPlatformTools({
        root,
        probe: () => ({ ok: false, detail: 'spawnSync adb.exe UNKNOWN' }),
      }),
    ).toThrowError(/跑不起来/)
    expect(() =>
      assertPlatformTools({ root, probe: () => ({ ok: false, detail: 'spawnSync adb.exe UNKNOWN' }) }),
    ).toThrowError(/UNKNOWN/)
  })

  it('正常 adb -> 返回 { path, version }，且 path 指向该 root 下的 adb.exe', () => {
    const exePath = makeExe()
    const result = assertPlatformTools({
      root,
      probe: () => ({ ok: true, version: '1.0.41' }),
    })
    expect(result.ok).toBe(true)
    expect(result.version).toBe('1.0.41')
    expect(result.path).toBe(exePath)
  })

  it('路径必须落在传入的 root 下（防止把「源目录」与「产物目录」混为一谈）', () => {
    const exePath = makeExe()
    const result = assertPlatformTools({ root, probe: () => ({ ok: true, version: '1.0.41' }) })
    // 这条是 afterPack 复用同一函数的前提：root 指到 appOutDir 时，
    // 校验的必须是 appOutDir/resources/platform-tools，而不是仓库里的源目录
    expect(result.path.startsWith(root)).toBe(true)
    expect(result.path).toBe(exePath)
    expect(result.path).not.toContain(path.join('adb-file-manager', 'resources'))
  })
})
