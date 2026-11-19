import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import afterPackModule from '../scripts/after-pack.cjs'

/**
 * afterPack 调用点的测试（复审 Minor-5）。
 *
 * 为什么必须测这个「只有 3 行」的钩子：它是四道闸门的**最后一道**。它唯一的实质
 * 接线就是 `assertPlatformTools({ root: appOutDir })` 里的那个 root。
 * 只要有人把它「简化」掉（改成 assertPlatformTools()），函数会回落到仓库根，
 * 于是它重新去校验**源目录** —— 与 beforePack 完全重复，第 4 道闸门形同不存在。
 * 而 assert-platform-tools.test.ts 测的是函数本体，对这种调用点退化**零反应**
 * （这是我第 2 轮的实际缺口：复审变异 C 删掉 root 后，全量 1161 条测试仍然全绿）。
 *
 * 所以第三条用例是核心：在仓库根**确实有** platform-tools 的前提下，
 * 传一个空的 appOutDir —— 如果 root 没传下去，函数会去仓库根找到 adb 并通过，
 * 用例就会红。这就是锁住 root 传参的变异检测。
 */

const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb'
const afterPack = (afterPackModule as unknown as {
  (context: { appOutDir: string }, options?: { probe?: (p: string) => { ok: boolean; version?: string; detail?: string } }): Promise<void>
})

let appOutDir: string

beforeEach(() => {
  appOutDir = mkdtempSync(path.join(tmpdir(), 'adb-fm-afterpack-test-'))
})

afterEach(() => {
  rmSync(appOutDir, { recursive: true, force: true })
})

/** 在 appOutDir 里造出 resources/platform-tools/adb.exe（内容无所谓，probe 是注入的）。 */
function makeBundledAdb(): string {
  const dir = path.join(appOutDir, 'resources', 'platform-tools')
  mkdirSync(dir, { recursive: true })
  const exePath = path.join(dir, EXE)
  writeFileSync(exePath, 'fake')
  return exePath
}

/** 假的「能跑」探测结果，避免单测依赖真实 adb 二进制。 */
const okProbe = (): { ok: true; version: string } => ({ ok: true, version: '1.0.41' })

describe('afterPack（第 4 道闸门：产物里必须真的带 adb）', () => {
  it('产物里有 resources/platform-tools/adb.exe -> 不抛错', async () => {
    makeBundledAdb()
    await expect(afterPack({ appOutDir }, { probe: okProbe })).resolves.toBeUndefined()
  })

  it('产物里没有 platform-tools -> 以「没有内置 adb」拒绝', async () => {
    // appOutDir 是空的：一个刚 mkdtemp 出来的目录
    await expect(afterPack({ appOutDir }, { probe: okProbe })).rejects.toThrowError(/没有内置 adb/)
  })

  it('【锁 root 传参】仓库根有 platform-tools，但 appOutDir 是空的 -> 仍必须拒绝', async () => {
    /*
     * 这条就是变异 C 的检测器。
     *
     * 前置条件必须成立：仓库根的资源目录里真的有 adb.exe。
     * 若它不存在（例如干净克隆还没跑 fetch），这条断言会变成「因为哪边都没有」而通过，
     * 就失去意义了 —— 所以先显式断言它存在，让前置条件不成立时**报出来**而不是静默弱化。
     */
    const repoSourceAdb = path.resolve(import.meta.dirname, '..', 'resources', 'platform-tools', EXE)
    expect(
      (await import('node:fs')).existsSync(repoSourceAdb),
      '前置条件：仓库根必须有 resources/platform-tools/' + EXE + '（先跑 npm run fetch-platform-tools）',
    ).toBe(true)

    // appOutDir 里什么都没有。若 afterPack 忘了传 root，assertPlatformTools 会回落到
    // 仓库根、找到上面那个 adb、返回成功 —— 本用例就会红。
    await expect(afterPack({ appOutDir }, { probe: okProbe })).rejects.toThrowError(/没有内置 adb/)
  })
})
