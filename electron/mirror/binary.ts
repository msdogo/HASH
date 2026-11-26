import path from 'node:path'
import { resolveOnPath, type PathResolution } from '../adb/binary'
import { E_SCRCPY_NOT_EXECUTABLE, E_SCRCPY_NOT_FOUND } from '../../src/shared/errors'

/**
 * scrcpy 可执行文件的定位与自检。
 *
 * ===== 为什么与 adb 的定位分开写 =====
 * adb 的二进制名固定、位置由 packager 保证；scrcpy 多一个「用户可能自己装了一份在 PATH 里」
 * 的来源，而且**它必须被我们自己的 adb 驱动**（见 runner.ts 的 ADB 环境变量）。
 * 两者失败时的文案与修法都不同，合在一个文件里迟早互相污染。
 */

/** 定位结果：要么给出可用路径，要么给出用户能采取行动的错误码。 */
export type ScrcpyLocation =
  | { ok: true; path: string; version: string; source: 'bundled' | 'path' }
  | { ok: false; code: string }

export interface LocateScrcpyDeps {
  /** 打包后的 resources 根（生产是 process.resourcesPath）。 */
  resourcesPath: string
  /**
   * PATH 解析器。
   *
   * 默认就是 electron/adb/binary 的 resolveOnPath（它已经处理了 PATHEXT 顺序、
   * shim 跳过、空段过滤这些坑，不重写一遍）。注入点存在的唯一理由是：
   * 那个函数直接读真实文件系统（statSync），无法在单测里给出「PATH 里有一个
   * scrcpy.exe」这种场景。生产必须用默认值。
   */
  resolveInPath?: (name: string) => PathResolution
  /** 文件存在判定（注入以便单测）。 */
  exists: (filePath: string) => boolean
  /** 跑 --version；返回版本号或失败。 */
  probe: (exePath: string) => Promise<{ ok: true; version: string } | { ok: false }>
}

/**
 * 内置 scrcpy 的路径。
 *
 * 与 electron-builder.json 的 extraResources 一一对应：`resources/scrcpy` → `<resourcesPath>/scrcpy`。
 * 改这里必须同时改那个配置，否则打包后永远找不到（这是任务 11 踩过的同款错位）。
 */
export function bundledScrcpyPath(resourcesPath: string): string {
  return path.join(resourcesPath, 'scrcpy', 'scrcpy.exe')
}

/** 生产用的 PATH 解析器（读真实文件系统）。 */
export function defaultPathResolver(name: string): PathResolution {
  return resolveOnPath(name, process.env.PATH ?? process.env.Path ?? '', process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
}

/**
 * 按「内置优先 → PATH」定位 scrcpy。
 *
 * 为什么内置优先：用户机器上很可能装过 scrcpy 且版本各异（有 1.x 的，命令行参数都不兼容），
 * 随包分发的这份是**我们测过的那一版**。只有内置缺失时才去 PATH 捞一个凑合用。
 */
export async function locateScrcpy(deps: LocateScrcpyDeps): Promise<ScrcpyLocation> {
  const bundled = bundledScrcpyPath(deps.resourcesPath)
  if (deps.exists(bundled)) {
    const probed = await deps.probe(bundled)
    if (probed.ok) return { ok: true, path: bundled, version: probed.version, source: 'bundled' }
    /*
     * 内置存在但跑不起来：**不再回落到 PATH**。
     *
     * 这是一个刻意的选择：内置坏了意味着安装包不完整（缺 DLL、被杀软隔离），
     * 此时静默换用 PATH 里的旧版，用户会得到「功能时好时坏」这种最难排查的状态。
     * 明确报错，让用户去修安装。
     */
    return { ok: false, code: E_SCRCPY_NOT_EXECUTABLE }
  }

  const resolve = deps.resolveInPath ?? defaultPathResolver
  const inPath = resolve('scrcpy.exe')
  /*
   * 只认 'found'。
   *
   * 'shimOnly' 与 'none' 都归为「没有 scrcpy」：scrcpy 没有 npm 包形态，
   * 不存在合法的 .cmd shim —— 扫到 shim 只会是别的东西重名，用不了。
   */
  if (inPath.kind === 'found') {
    const probed = await deps.probe(inPath.path)
    if (probed.ok) return { ok: true, path: inPath.path, version: probed.version, source: 'path' }
    return { ok: false, code: E_SCRCPY_NOT_EXECUTABLE }
  }

  return { ok: false, code: E_SCRCPY_NOT_FOUND }
}

/** 从 `scrcpy --version` 的输出里取版本号；认不出返回 null（不阻断启动）。 */
export function parseScrcpyVersion(output: string): string | null {
  const m = /scrcpy\s+(\d+\.\d+(?:\.\d+)?)/i.exec(output)
  return m === null ? null : m[1]
}
