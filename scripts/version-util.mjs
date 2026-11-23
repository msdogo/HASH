/**
 * 版本号机制（用户裁决 C：语义化自动递增）的纯函数层。
 *
 * 为什么把判定放在纯函数里：bump 与 assert 两个 CLI 都只是薄壳，
 * 真正的「升哪一位」「该不该拒绝」全部在这里，才能被表驱动用例钉死。
 *
 * 注意：本文件是 .mjs，必须是纯 JS —— 不能写 interface / 类型注解，
 * Node 直接跑不了。类型层面的约束由 tests/version-util.test.ts 的用例兜住。
 */

/**
 * 解析 "1.2.3"。解析不出来返回 null —— 调用方必须显式处理，
 * 不能静默当成 0.0.0（那会让一次手滑的 package.json 变成版本回退）。
 */
export function parseSemVer(text) {
  if (typeof text !== 'string') return null
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(text.trim())
  if (m === null) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

/** 拼回 "1.2.3"。 */
export function formatSemVer(v) {
  return v.major + '.' + v.minor + '.' + v.patch
}

/**
 * 升一位。升 major 时 minor/patch 归零，升 minor 时 patch 归零 ——
 * 这是 semver 的定义，不是风格选择。
 */
export function bumpSemVer(v, kind) {
  if (kind === 'major') return { major: v.major + 1, minor: 0, patch: 0 }
  if (kind === 'minor') return { major: v.major, minor: v.minor + 1, patch: 0 }
  return { major: v.major, minor: v.minor, patch: v.patch + 1 }
}

/** 认得的 conventional-commit 前缀。不认得的（含无前缀的裸句子）按 patch 处理。 */
const PATCH_TYPES = [
  'fix', 'perf', 'refactor', 'style', 'test', 'build', 'docs', 'chore', 'ci', 'revert',
]

/**
 * 从 commit subject 判定升哪一位。
 *
 * 判定顺序很重要：
 *   1. 先看 breaking —— feat! 、fix!: 、以及正文里的 BREAKING CHANGE。
 *      必须先判，否则 feat! 会被当成普通 feat 只升 minor。
 *   2. feat → minor
 *   3. 其余已知类型 → patch
 *   4. 完全认不出 → patch（保守：宁可小步前进，也不要因为一条不合规范的
 *      commit 就把 minor 抬上去，让版本号数字失去含义）
 */
export function releaseFromSubject(subject) {
  const line = (subject === undefined || subject === null ? '' : String(subject)).trim()
  if (line === '') return 'patch'
  // 要把 feat! 与 refactor(core)! 两种都认出来 —— 漏掉带 scope 的那种，
  // 一次不兼容改动就会被当成普通 patch 混进小版本里。
  const isBreaking =
    /^[a-zA-Z]+(\([^)]*\))?!\s*:/.test(line) || /BREAKING[ -]CHANGE/i.test(line)
  if (isBreaking) return 'major'
  const m = /^([a-zA-Z]+)\s*(\([^)]*\))?\s*:/.exec(line)
  const type = m === null ? '' : m[1].toLowerCase()
  if (type === 'feat') return 'minor'
  if (PATCH_TYPES.includes(type)) return 'patch'
  return 'patch'
}

/**
 * 同一 commit 是否已经 bump 过。
 *
 * 为什么需要：bump 会改工作区的 package.json。用户忘了自己跑过、
 * 或者脚本被重跑，就会连升两次（0.1.1 → 0.1.2），而代码其实只有一份改动。
 * 判据是「上次 bump 记下的 commit」与当前 HEAD 相同。
 */
export function shouldRefuseBump(lastBumpCommit, headCommit) {
  if (lastBumpCommit === '' || headCommit === '') return false
  return lastBumpCommit === headCommit
}

/**
 * 构建前闸门：这次要打的版本号是否与上次打出来的相同。
 *
 * 相同 → 必须中止。否则会出现两个内容不同、版本号相同的安装包，
 * 用户装完看到的版本号无法区分是哪一份 —— 那正是用户要「每次加版本号」的原因。
 */
export function shouldRefuseBuild(currentVersion, lastBuiltVersion) {
  if (lastBuiltVersion === '') return false
  return currentVersion === lastBuiltVersion
}
