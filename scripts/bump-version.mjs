#!/usr/bin/env node
/**
 * 版本号自增 CLI（用户裁决 C：语义化 + 自动）。
 *
 * 用法：
 *   npm run bump              # 读 HEAD 的 commit subject，自动判 minor/patch/major
 *   npm run bump -- 0.3.0     # 手动指定，跳过判定
 *   npm run bump -- --force   # 忽略「同一 commit 已 bump」的幂等保护
 *
 * 为什么不放在 dist 里自动跑：版本号是对用户的承诺，应该由人确认这次改动
 * 属于 feat 还是 fix；放进构建链会变成「不管改了什么，每次都自动升」，
 * 版本号就退化成计数器，失去语义。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bumpSemVer, formatSemVer, parseSemVer, releaseFromSubject, shouldRefuseBump,
} from './version-util.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = path.join(ROOT, 'package.json')
const INFO = path.join(ROOT, 'build-info.json')

function readInfo() {
  if (!existsSync(INFO)) return { lastBumpCommit: '', lastBuiltVersion: '' }
  try {
    const raw = JSON.parse(readFileSync(INFO, 'utf8'))
    return {
      lastBumpCommit: typeof raw.lastBumpCommit === 'string' ? raw.lastBumpCommit : '',
      lastBuiltVersion: typeof raw.lastBuiltVersion === 'string' ? raw.lastBuiltVersion : '',
    }
  } catch {
    return { lastBumpCommit: '', lastBuiltVersion: '' }
  }
}

function writeInfo(next) {
  writeFileSync(INFO, JSON.stringify(next, null, 2) + '\n', 'utf8')
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function die(msg) {
  console.error('[bump-version] ' + msg)
  process.exit(1)
}

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const explicit = argv.find((a) => !a.startsWith('--'))

const pkgRaw = readFileSync(PKG, 'utf8')
const pkg = JSON.parse(pkgRaw)
const current = parseSemVer(pkg.version)
if (current === null) {
  die('package.json 的 version 不是合法的 major.minor.patch：' + String(pkg.version))
}

const head = git(['rev-parse', 'HEAD'])
const subject = git(['log', '-1', '--pretty=%s'])
const info = readInfo()

// 手动指定版本号时不受「同一 commit 已 bump」保护限制 —— 幂等保护是为了防止
// 自动判定被重跑连升两次，而手动指定是人的明确意图（比如这次要从 0.1.1 定到 0.2.0）。
if (!force && explicit === undefined && shouldRefuseBump(info.lastBumpCommit, head)) {
  die(
    '当前 commit (' + head.slice(0, 7) + ') 已经 bump 过版本号了。\n' +
    '  如果确实要再升一次，加 --force：npm run bump -- --force',
  )
}

let next
let kindLabel
if (explicit !== undefined) {
  const parsed = parseSemVer(explicit)
  if (parsed === null) die('手动指定的版本号不合法：' + explicit)
  next = parsed
  kindLabel = '手动指定'
} else {
  const kind = releaseFromSubject(subject)
  next = bumpSemVer(current, kind)
  kindLabel = kind
}

const nextText = formatSemVer(next)
if (formatSemVer(next) === pkg.version && !force) {
  die('新版本号与当前相同：' + nextText)
}

// 先记下旧值再赋值 —— 写成 pkg.version + ' → ' + nextText 会打印
// "0.1.1 → 0.1.1"（pkg.version 已被覆盖），让人以为版本没变。
const previousText = pkg.version
pkg.version = nextText
writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
writeInfo({ ...info, lastBumpCommit: head, lastBumpVersion: nextText })

console.log('[bump-version] ' + previousText + ' → ' + nextText + '  (' + kindLabel + ')')
console.log('[bump-version] 依据 commit: ' + (subject === '' ? '(无)' : subject))
console.log('[bump-version] 记得把 package.json 一起提交。')
