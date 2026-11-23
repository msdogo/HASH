#!/usr/bin/env node
/**
 * 构建前闸门：版本号必须比上次打出来的新。
 *
 * 为什么需要它（这是整套机制的关键）：
 * 「每次修改都要加版本号」如果只写在文档里，就必然会被忘掉 —— 这次就是
 * 连续 7 轮改动版本号一直是 0.1.0，直到用户自己发现。口头约定挡不住遗忘，
 * 只有让构建直接失败才挡得住。
 *
 * 失败信息要说清三件事：现在是多少、上次打的是多少、下一步该敲什么。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSemVer, shouldRefuseBuild } from './version-util.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = path.join(ROOT, 'package.json')
const INFO = path.join(ROOT, 'build-info.json')

function readInfo() {
  if (!existsSync(INFO)) return {}
  try {
    const raw = JSON.parse(readFileSync(INFO, 'utf8'))
    return typeof raw === 'object' && raw !== null ? raw : {}
  } catch {
    return {}
  }
}

const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
const version = String(pkg.version)
if (parseSemVer(version) === null) {
  console.error('[assert-version] package.json 的 version 不合法：' + version)
  process.exit(1)
}

const info = readInfo()
const lastBuilt = typeof info.lastBuiltVersion === 'string' ? info.lastBuiltVersion : ''

if (shouldRefuseBuild(version, lastBuilt)) {
  console.error('')
  console.error('================================================================')
  console.error('[构建中止] 版本号没变：仍然是 ' + version)
  console.error('================================================================')
  console.error('')
  console.error('上次打出来的包也是这个版本号。两个内容不同、版本号相同的包')
  console.error('会让用户无法区分自己装的是哪一份。')
  console.error('')
  console.error('下一步：')
  console.error('  npm run bump          # 按上一条 commit 的前缀自动升（feat→minor，fix→patch）')
  console.error('  npm run bump -- 0.3.0 # 或手动指定')
  console.error('')
  process.exit(1)
}

writeFileSync(
  path.join(ROOT, 'build-info.json'),
  JSON.stringify({ ...info, lastBuiltVersion: version, lastBuiltAt: new Date().toISOString() }, null, 2) + '\n',
  'utf8',
)
console.log('[assert-version] 版本号 ' + version + ' 通过（上次打包：' + (lastBuilt === '' ? '无记录' : lastBuilt) + '）')
