#!/usr/bin/env node
/**
 * 下载并内置 Android platform-tools（任务 11）。
 *
 * 产物：resources/platform-tools/adb.exe 及同目录必需 dll。
 * 该目录在 .gitignore 里（体积大，不入库），所以脚本必须能「从零重建」——
 * 克隆仓库后先跑 npm run fetch-platform-tools，再 npm run dist。
 *
 * 行为约定：
 * - adb.exe 已存在且能跑 -> 直接退出（幂等，npm run dist 每次跑也不浪费时间）；
 * - 下载失败 / 解压失败 / 校验失败 -> 打印明确的「手动放置」指引后 exit 1，
 *   而不是抛一个看不懂的 ENOTFOUND 堆栈；
 * - 支持离线：ADB_PLATFORM_TOOLS_ZIP=<本地 zip 路径> 时跳过下载；
 * - 支持手动放置：用户直接把 platform-tools 目录内容拷到 resources/platform-tools/ 即可。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const DEST = path.join(ROOT, 'resources', 'platform-tools')
const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb'
const EXE_PATH = path.join(DEST, EXE)
const ZIP_URL = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'
const LOCAL_ZIP = process.env.ADB_PLATFORM_TOOLS_ZIP ?? ''

/** 打印「怎么手动补」的指引；所有失败分支都走这里，保证错误可读。 */
function fail(reason) {
  console.error('')
  console.error('[错误] ' + reason)
  console.error('')
  console.error('可以手动补齐内置 adb，二选一：')
  console.error('  1) 从任意 Android SDK 复制：把 <SDK>/platform-tools/ 下所有文件拷到')
  console.error('     ' + DEST)
  console.error('  2) 手动下载 ' + ZIP_URL + '，解压后同样把 platform-tools/ 内容拷过去')
  console.error('')
  console.error('放好后重新运行：npm run fetch-platform-tools（会校验 adb version 后直接通过）')
  process.exit(1)
}

/** 跑 adb version，返回输出；失败返回 null。校验「文件存在」不等于「能跑」。 */
function probeAdbVersion(exePath) {
  const r = spawnSync(exePath, ['version'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
  if (r.error !== undefined && r.error !== null) return null
  if (r.status !== 0) return null
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  return /Android Debug Bridge version/.test(out) || /Version [\w.\-]+/.test(out) ? out.trim() : null
}

function listDir(dir) {
  return readdirSync(dir, { withFileTypes: true }).map((d) => d.name)
}

async function download(url, destFile) {
  console.log('[下载] ' + url)
  const res = await fetch(url)
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText)
  const total = Number(res.headers.get('content-length') ?? '0')
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(destFile, buf)
  const sha = createHash('sha256').update(buf).digest('hex')
  console.log('[下载] 完成 ' + (buf.length / 1048576).toFixed(2) + ' MB' +
    (total > 0 ? ' / 声明 ' + (total / 1048576).toFixed(2) + ' MB' : '') + '，sha256=' + sha)
}

/** 解压 zip：优先用 Windows 自带 bsdtar（Win10 1803+），失败再退到 PowerShell。 */
function extractZip(zipFile, outDir) {
  mkdirSync(outDir, { recursive: true })
  let r = spawnSync('tar', ['-xf', zipFile, '-C', outDir], { encoding: 'utf8', windowsHide: true })
  if (r.status === 0) return
  if (process.platform === 'win32') {
    r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath ' + JSON.stringify(zipFile) + ' -DestinationPath ' + JSON.stringify(outDir) + ' -Force'],
    { encoding: 'utf8', windowsHide: true })
    if (r.status === 0) return
  }
  throw new Error('解压失败：' + ((r.stderr ?? '') + (r.stdout ?? '')).trim().slice(0, 400))
}

async function main() {
  console.log('[内置 adb] 目标目录：' + DEST)

  // 1) 已就位且能跑 -> 幂等退出
  if (existsSync(EXE_PATH)) {
    const version = probeAdbVersion(EXE_PATH)
    if (version !== null) {
      console.log('[内置 adb] 已存在且可用，跳过。')
      console.log(version.split('\n').map((l) => '  ' + l).join('\n'))
      return
    }
    console.error('[内置 adb] 已存在但跑不起来（' + EXE_PATH + '），重新下载覆盖。')
    rmSync(DEST, { recursive: true, force: true })
  }

  // 2) 拿 zip：本地优先，其次下载
  const work = path.join(tmpdir(), 'adb-fm-platform-tools-' + process.pid)
  mkdirSync(work, { recursive: true })
  const zipFile = path.join(work, 'platform-tools.zip')

  try {
    if (LOCAL_ZIP !== '') {
      if (!existsSync(LOCAL_ZIP)) fail('ADB_PLATFORM_TOOLS_ZIP 指向的文件不存在：' + LOCAL_ZIP)
      copyFileSync(LOCAL_ZIP, zipFile)
      console.log('[内置 adb] 使用本地 zip：' + LOCAL_ZIP)
    } else {
      try {
        await download(ZIP_URL, zipFile)
      } catch (err) {
        fail('下载 platform-tools 失败：' + (err instanceof Error ? err.message : String(err)))
      }
    }

    // 3) 解压到临时目录，再把 <tmp>/platform-tools/* 搬进 resources/platform-tools
    const extractDir = path.join(work, 'extract')
    try {
      extractZip(zipFile, extractDir)
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }

    const srcDir = existsSync(path.join(extractDir, 'platform-tools'))
      ? path.join(extractDir, 'platform-tools')
      : extractDir
    mkdirSync(DEST, { recursive: true })
    for (const name of listDir(srcDir)) {
      const from = path.join(srcDir, name)
      if (statSync(from).isDirectory()) continue
      copyFileSync(from, path.join(DEST, name))
    }

    // 4) 校验：文件真的在，而且真的能跑（跑不起来的内置 adb 等于没有）
    if (!existsSync(EXE_PATH)) fail('解压后没有找到 ' + EXE_PATH + '，zip 结构不符合预期。')
    const version = probeAdbVersion(EXE_PATH)
    if (version === null) fail('内置 adb 存在但无法执行（' + EXE_PATH + '）。')
    console.log('[内置 adb] 就绪：' + EXE_PATH)
    console.log(version.split('\n').map((l) => '  ' + l).join('\n'))
    console.log('[内置 adb] 目录文件数：' + listDir(DEST).length)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

main().catch((err) => {
  fail('未预期的错误：' + (err instanceof Error ? (err.stack ?? err.message) : String(err)))
})
