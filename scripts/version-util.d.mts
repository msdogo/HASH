/**
 * scripts/version-util.mjs 的类型声明。
 *
 * 为什么必须有：这个文件是 .mjs（Node 直接跑），没有类型声明时 tsc 会报
 * TS7016（隐式 any），而本项目的门禁是 tsc 零错误。声明只描述形状，
 * 真实实现仍在 .mjs 里；两边的行为一致性由 tests/version-util.test.ts 兜住。
 */
export interface SemVer {
  major: number
  minor: number
  patch: number
}
export type ReleaseKind = 'major' | 'minor' | 'patch'
export function parseSemVer(text: string): SemVer | null
export function formatSemVer(v: SemVer): string
export function bumpSemVer(v: SemVer, kind: ReleaseKind): SemVer
export function releaseFromSubject(subject: string): ReleaseKind
export function shouldRefuseBump(lastBumpCommit: string, headCommit: string): boolean
export function shouldRefuseBuild(currentVersion: string, lastBuiltVersion: string): boolean
