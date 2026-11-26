import { describe, it, expect } from 'vitest'
import path from 'node:path'
import type { PathResolution } from '../electron/adb/binary'
import { bundledScrcpyPath, locateScrcpy, parseScrcpyVersion } from '../electron/mirror/binary'
import { E_SCRCPY_NOT_EXECUTABLE, E_SCRCPY_NOT_FOUND } from '../src/shared/errors'

const bundled = bundledScrcpyPath('R')
const inPath = path.join('C:\\bin', 'scrcpy.exe')

/** PATH 解析器替身：给出确定的「有没有、在哪」。 */
const noneResolve = (): PathResolution => ({ kind: 'none' })
const foundResolve = (p: string) => (): PathResolution => ({ kind: 'found', path: p })

describe('bundledScrcpyPath', () => {
  it('拼成 <resources>/scrcpy/scrcpy.exe（与 electron-builder 的 extraResources 对应）', () => {
    expect(bundled).toBe(path.join('R', 'scrcpy', 'scrcpy.exe'))
  })
})

describe('locateScrcpy', () => {
  it('内置优先于 PATH', async () => {
    const r = await locateScrcpy({
      resourcesPath: 'R',
      resolveInPath: foundResolve(inPath),
      exists: (p) => p === bundled,
      probe: async () => ({ ok: true, version: '5.0.1' }),
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toBe('bundled')
      expect(r.path).toBe(bundled)
      expect(r.version).toBe('5.0.1')
    }
  })

  it('内置缺失时回落 PATH', async () => {
    const r = await locateScrcpy({
      resourcesPath: 'R',
      resolveInPath: foundResolve(inPath),
      exists: () => false,
      probe: async () => ({ ok: true, version: '5.0.1' }),
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toBe('path')
      expect(r.path).toBe(inPath)
    }
  })

  it('两处都没有 → E_SCRCPY_NOT_FOUND', async () => {
    const r = await locateScrcpy({
      resourcesPath: 'R',
      resolveInPath: noneResolve,
      exists: () => false,
      probe: async () => ({ ok: false }),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe(E_SCRCPY_NOT_FOUND)
  })

  it('PATH 里只有 shim → 视同没有（scrcpy 不存在 npm shim 形态）', async () => {
    const r = await locateScrcpy({
      resourcesPath: 'R',
      resolveInPath: () => ({ kind: 'shimOnly', skipped: ['C:\\bin\\scrcpy.cmd'] }),
      exists: () => false,
      probe: async () => ({ ok: false }),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe(E_SCRCPY_NOT_FOUND)
  })

  it('内置存在但跑不起来 → E_SCRCPY_NOT_EXECUTABLE（且不回落到 PATH）', async () => {
    const probed: string[] = []
    const r = await locateScrcpy({
      resourcesPath: 'R',
      resolveInPath: foundResolve(inPath),
      exists: () => true,
      probe: async (p) => {
        probed.push(p)
        return { ok: false }
      },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe(E_SCRCPY_NOT_EXECUTABLE)
    expect(probed).toEqual([bundled])
  })

  it('PATH 里存在但跑不起来 → E_SCRCPY_NOT_EXECUTABLE', async () => {
    const r = await locateScrcpy({
      resourcesPath: 'R',
      resolveInPath: foundResolve(inPath),
      exists: () => false,
      probe: async () => ({ ok: false }),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe(E_SCRCPY_NOT_EXECUTABLE)
  })
})

describe('parseScrcpyVersion', () => {
  it('标准输出', () => {
    expect(parseScrcpyVersion('scrcpy 5.0.1 <https://github.com/Genymobile/scrcpy>')).toBe('5.0.1')
  })

  it('两段版本号', () => {
    expect(parseScrcpyVersion('scrcpy 2.4 <url>')).toBe('2.4')
  })

  it('认不出返回 null（不阻断启动）', () => {
    expect(parseScrcpyVersion('garbage')).toBe(null)
    expect(parseScrcpyVersion('')).toBe(null)
  })
})
