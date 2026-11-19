#!/usr/bin/env node
/**
 * 内置 platform-tools 的硬闸门（审查 I1）。
 *
 * 为什么必须有它：electron-builder 在 extraResources 的源目录不存在时**不会失败**，
 * 只在日志里留一行 `file source doesn't exist`，然后 exit 0 打出一个没有 adb 的包。
 * 那是最糟的失败形态 —— 构建「成功」、产物「生成」、装到没有 Android SDK 的机器上才发现没 adb。
 * 而 resources/platform-tools/ 在 .gitignore 里，干净克隆的仓库必然是这个状态。
 *
 * 两种用法：
 * 1) 独立运行（dist 脚本链里）：npm run assert-platform-tools
 * 2) 被 electron-builder 的 beforePack 钩子调用（覆盖「有人直接跑 npx electron-builder」）
 *
 * 判定不是「文件存在」而是「能跑」：一个跑不起来的 adb.exe 与没有 adb 等价。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb'

/** 失败时的统一文案：说清楚缺什么、怎么补、为什么构建必须停。 */
function failMessage(reason) {
  return [
    '',
    '================================================================',
    '[构建中止] 内置 adb 不可用：' + reason,
    '================================================================',
    '',
    'resources/platform-tools/ 不在版本库里（.gitignore 第 5 行），',
    '所以干净克隆的仓库必须先把它准备好，否则打出的安装包没有 adb。',
    '',
    'electron-builder 自己不会为此报错（只打印一行 file source doesn\'t exist 然后 exit 0），',
    '这种包在没有 Android SDK 的机器上会直接退化成「无法使用 adb」。',
    '这里刻意把它变成构建失败。',
    '',
    '修复（任选其一）：',
    '  1) npm run fetch-platform-tools            # 从 dl.google.com 下载并解压',
    '  2) ADB_PLATFORM_TOOLS_ZIP=<本地zip> npm run fetch-platform-tools   # 离线',
    '  3) 手动把 Android SDK 的 platform-tools/ 内容拷到：',
    '     ' + path.join(ROOT, 'resources', 'platform-tools'),
    '',
    '补好后重新运行 npm run dist。',
    '================================================================',
    '',
  ].join('\n')
}

/** 跑一次 adb version 作为「能跑」的唯一证据。 */
function probeVersion(exePath) {
  const result = spawnSync(exePath, ['version'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
  if (result.error !== undefined && result.error !== null) {
    return { ok: false, detail: String(result.error.message ?? result.error) }
  }
  if (result.status !== 0) {
    return { ok: false, detail: 'exit ' + String(result.status) }
  }
  const out = (result.stdout ?? '') + (result.stderr ?? '')
  const match = /Android Debug Bridge version ([\d.]+)/.exec(out)
  if (match === null) {
    return { ok: false, detail: '输出里没有版本行：' + out.trim().slice(0, 200) }
  }
  return { ok: true, version: match[1] }
}

/**
 * 断言内置 adb 可用。失败时抛出带完整指引的 Error（供钩子与 CLI 共用）。
 *
 * `root` 注入给单测用（复审判定 Minor-4：构建关键路径必须有自动化测试）；
 * `probe` 注入让「跑不起来」与「能跑」两种分支**不必依赖任何真实二进制**就能测 ——
 * 否则测试要么得在临时目录造一个 .exe（Windows 上是不可移植的黑魔法），
 * 要么得拷 8 MB 的真 adb，两种都不该进单测。
 *
 * @param {{ root?: string, probe?: (exePath: string) => { ok: boolean, version?: string, detail?: string } }} [options]
 * @returns {{ ok: true, path: string, version: string }}
 */
export function assertPlatformTools(options = {}) {
  const root = options.root ?? ROOT
  const probe = options.probe ?? probeVersion
  const dir = path.join(root, 'resources', 'platform-tools')
  const exePath = path.join(dir, EXE)

  if (!existsSync(dir)) {
    throw new Error(failMessage('目录不存在：' + dir))
  }
  if (!existsSync(exePath)) {
    throw new Error(failMessage('文件不存在：' + exePath))
  }
  try {
    if (!statSync(exePath).isFile()) {
      throw new Error(failMessage('不是普通文件：' + exePath))
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('\n=')) throw err
    throw new Error(failMessage('无法读取 ' + exePath + '：' + String(err)))
  }

  const probed = probe(exePath)
  if (probed.ok !== true) {
    throw new Error(failMessage('adb.exe 存在但跑不起来（' + probed.detail + '）'))
  }
  return { ok: true, path: exePath, version: probed.version }
}

// 作为 CLI 直接运行时：打印结果或失败的指引，并以非零码退出。
const invokedDirectly = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  try {
    const result = assertPlatformTools()
    console.log('[内置 adb 校验] 通过：' + result.path + '（adb ' + result.version + '）')
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
