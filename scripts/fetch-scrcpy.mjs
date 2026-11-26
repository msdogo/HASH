#!/usr/bin/env node
/**
 * 下载并内置 scrcpy（投屏功能的运行时依赖）。
 *
 * 产物：resources/scrcpy/scrcpy.exe 及同目录 dll / adb.exe 之外的运行文件。
 * 该目录在 .gitignore 里（体积大，不入库），所以脚本必须能「从零重建」——
 * 克隆仓库后先跑 npm run fetch-scrcpy，再 npm run dist。
 *
 * 行为约定（与 fetch-platform-tools.mjs 完全一致，便于维护）：
 * - scrcpy.exe 已存在且能跑 -> 直接退出（幂等）；
 * - 支持离线：SCRCPY_ZIP=<本地 zip 路径> 时跳过下载；
 * - 支持手动放置：把 scrcpy-win64 目录内容拷到 resources/scrcpy/ 即可；
 * - 任何失败都打印「手动补齐」指引后 exit 1，而不是抛看不懂的堆栈。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const ROOT = path.resolve(import.meta.dirname, '..')
const DEST = path.join(ROOT, 'resources', 'scrcpy')
const EXE = process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy'
const EXE_PATH = path.join(DEST, EXE)

/**
 * 固定版本，不用 latest。
 *
 * 为什么钉死：scrcpy 的命令行参数在 1.x → 2.x → 3.x 之间改过多次
 * （--render-driver、--no-audio 的语义都变过）。随包分发的必须是**我们测过的那一版**，
 * 否则用户拿到一份能启动但参数不认的二进制，报错信息还指向我们的代码。
 */
const SCRCPY_VERSION = '5.0.1'
const ZIP_NAME = 'scrcpy-win64-v' + SCRCPY_VERSION + '.zip'
const ZIP_URL = 'https://github.com/Genymobile/scrcpy/releases/download/v' + SCRCPY_VERSION + '/' + ZIP_NAME
const LOCAL_ZIP = process.env.SCRCPY_ZIP ?? ''

class BuildFailure extends Error {}

function printFailure(reason) {
  console.error('')
  console.error('[错误] ' + reason)
  console.error('')
  console.error('可以手动补齐内置 scrcpy，二选一：')
  console.error('  1) 手动下载 ' + ZIP_URL)
  console.error('     解压后把 scrcpy-win64-v' + SCRCPY_VERSION + '/ 里的**全部文件**拷到')
  console.error('     ' + DEST)
  console.error('  2) 已经下载过 zip：SCRCPY_ZIP=<zip 路径> npm run fetch-scrcpy')
  console.error('')
  console.error('放好后重新运行：npm run fetch-scrcpy（会校验 scrcpy --version 后直接通过）')
}

function fail(reason) {
  printFailure(reason)
  throw new BuildFailure(reason)
}

/** 跑 scrcpy --version；返回版本号或 null。校验「文件存在」不等于「能跑」。 */
function probeScrcpyVersion(exePath) {
  const r = spawnSync(exePath, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  if (r.error !== undefined && r.error !== null) return null
  if (r.status !== 0) return null
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const m = /scrcpy\s+(\d+\.\d+(?:\.\d+)?)/i.exec(out)
  return m === null ? null : m[1]
}

function listDir(dir) {
  return readdirSync(dir, { withFileTypes: true }).map((d) => d.name)
}

async function download(url, destFile) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) fail('下载失败：HTTP ' + String(res.status) + ' ' + url)
  if (res.body === null) fail('下载失败：响应没有 body')
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destFile))
}

async function main() {
  // 幂等：已存在且能跑就直接通过（npm run dist 每次跑也不浪费时间）
  if (existsSync(EXE_PATH)) {
    const version = probeScrcpyVersion(EXE_PATH)
    if (version === SCRCPY_VERSION) {
      console.log('[fetch-scrcpy] 已有内置 scrcpy ' + version + '，跳过下载')
      return
    }
    if (version !== null) {
      console.log('[fetch-scrcpy] 已有内置 scrcpy ' + version + '，版本与期望的 ' + SCRCPY_VERSION + ' 不同，重新拉取')
    } else {
      console.log('[fetch-scrcpy] 已有的 scrcpy 无法运行，重新拉取')
    }
    rmSync(DEST, { recursive: true, force: true })
  }

  const tmp = path.join(tmpdir(), 'adbfm-scrcpy-' + String(process.pid))
  mkdirSync(tmp, { recursive: true })

  try {
    const zipPath = path.join(tmp, ZIP_NAME)
    if (LOCAL_ZIP !== '') {
      if (!existsSync(LOCAL_ZIP)) fail('SCRCPY_ZIP 指向的文件不存在：' + LOCAL_ZIP)
      console.log('[fetch-scrcpy] 使用本地 zip：' + LOCAL_ZIP)
      copyFileSync(LOCAL_ZIP, zipPath)
    } else {
      console.log('[fetch-scrcpy] 下载 ' + ZIP_URL)
      await download(ZIP_URL, zipPath)
    }
    console.log('[fetch-scrcpy] zip 大小 ' + String(Math.round(statSync(zipPath).size / 1024)) + ' KB')

    // 解压：用 PowerShell 的 Expand-Archive（Windows 自带，不引第三方依赖）
    const unzipDir = path.join(tmp, 'x')
    mkdirSync(unzipDir, { recursive: true })
    const ps = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath "' + zipPath + '" -DestinationPath "' + unzipDir + '" -Force'],
      { encoding: 'utf8', timeout: 120000, windowsHide: true },
    )
    if (ps.status !== 0) fail('解压失败：' + (ps.stderr ?? '').trim())

    const top = listDir(unzipDir)
    if (top.length === 0) fail('解压结果为空')
    // release zip 只有一个顶层目录 scrcpy-win64-vX.Y.Z/
    const srcRoot = top.length === 1 && statSync(path.join(unzipDir, top[0])).isDirectory()
      ? path.join(unzipDir, top[0])
      : unzipDir

    mkdirSync(DEST, { recursive: true })
    for (const name of listDir(srcRoot)) {
      const from = path.join(srcRoot, name)
      const to = path.join(DEST, name)
      if (statSync(from).isDirectory()) {
        // scrcpy 的 release 里没有子目录，出现就是包结构变了 —— 明确失败而不是静默丢文件
        fail('zip 结构与预期不符（出现了子目录 ' + name + '），请手动放置')
      }
      copyFileSync(from, to)
    }

    /*
     * 删掉 scrcpy 自带的那份 adb。
     *
     * 为什么必须删：scrcpy 的 Windows 包里带 adb.exe + 两个 AdbWin*.dll，
     * 而本项目**始终**通过 ADB 环境变量把内置 platform-tools 里那份交给它
     * （见 electron/mirror/runner.ts）。两份 adb 同时存在只有一个后果：
     * 某天环境变量没生效时，scrcpy 悄悄用上它自带的旧版，
     * 于是「设备列表里能看到，投屏却认不出设备」这种最难查的错就出现了。
     * 删掉之后，缺 adb 会明确报错，而不是行为悄悄分叉。
     */
    for (const name of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
      const p = path.join(DEST, name)
      if (existsSync(p)) rmSync(p, { force: true })
    }

    const version = probeScrcpyVersion(EXE_PATH)
    if (version === null) fail('复制完成但 scrcpy 跑不起来（可能缺 DLL）')
    console.log('[fetch-scrcpy] 完成：scrcpy ' + version + ' -> ' + DEST)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch((err) => {
  if (!(err instanceof BuildFailure)) {
    console.error('')
    console.error('[错误] ' + (err instanceof Error ? err.message : String(err)))
  }
  process.exit(1)
})
