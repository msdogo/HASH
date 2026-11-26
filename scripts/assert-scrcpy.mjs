#!/usr/bin/env node
/**
 * 打包前的 scrcpy 断言（与 assert-platform-tools.mjs 同一职责）。
 *
 * 为什么单独一个脚本而不是塞进 beforePack：npm run dist 的脚本链里要能**先**跑它，
 * 让人在开始打包（几十秒）之前就知道缺依赖；beforePack 只是覆盖
 * 「有人直接跑 npx electron-builder」那条旁路。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, statSync, readdirSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const DEST = path.join(ROOT, 'resources', 'scrcpy')
const EXE_PATH = path.join(DEST, process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy')

export function assertScrcpy() {
  if (!existsSync(EXE_PATH)) {
    throw new Error(
      '缺少内置 scrcpy：' + EXE_PATH + '\n' +
      '请先运行：npm run fetch-scrcpy（或把 scrcpy-win64 的文件拷到 resources/scrcpy/）',
    )
  }
  const r = spawnSync(EXE_PATH, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  if (r.error !== undefined && r.error !== null) throw new Error('scrcpy 无法执行：' + r.error.message)
  if (r.status !== 0) throw new Error('scrcpy --version 退出码 ' + String(r.status))
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const m = /scrcpy\s+(\d+\.\d+(?:\.\d+)?)/i.exec(out)
  if (m === null) throw new Error('scrcpy --version 输出认不出：' + out.trim().slice(0, 200))
  // adb.exe 必须**不在** scrcpy 目录里：我们用 ADB 环境变量指向内置 platform-tools 那份，
  // 两处各带一份 adb 迟早版本打架（scrcpy 自带的是随它自己发布的旧版）。
  const entries = readdirSync(DEST)
  if (entries.includes('adb.exe') || entries.includes('adb')) {
    throw new Error('resources/scrcpy 里不应包含 adb（应使用 platform-tools 里的那份）')
  }
  const size = readdirSync(DEST).reduce((sum, name) => {
    const p = path.join(DEST, name)
    const st = statSync(p)
    return sum + (st.isFile() ? st.size : 0)
  }, 0)
  return { path: EXE_PATH, version: m[1], files: entries.length, bytes: size }
}

// 直接运行时（node scripts/assert-scrcpy.mjs）
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    const result = assertScrcpy()
    console.log('[assert-scrcpy] 通过：' + result.path + '（scrcpy ' + result.version + '，' + String(Math.round(result.bytes / 1024 / 1024)) + ' MB）')
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
