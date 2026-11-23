import { describe, it, expect } from 'vitest'
import {
  parseSemVer, formatSemVer, bumpSemVer, releaseFromSubject,
  shouldRefuseBump, shouldRefuseBuild,
} from '../scripts/version-util.mjs'

describe('parseSemVer', () => {
  it('合法版本号解析成三段数字', () => {
    const cases: Array<[string, { major: number; minor: number; patch: number }]> = [
      ['0.1.0', { major: 0, minor: 1, patch: 0 }],
      ['1.2.3', { major: 1, minor: 2, patch: 3 }],
      ['10.20.30', { major: 10, minor: 20, patch: 30 }],
      ['  0.2.0  ', { major: 0, minor: 2, patch: 0 }],
    ]
    for (const [input, expected] of cases) {
      expect(parseSemVer(input), input).toEqual(expected)
    }
  })

  it('非法输入一律返回 null，绝不静默当成 0.0.0', () => {
    // 静默回退成 0.0.0 会让一次手滑的 package.json 直接变成版本回退，
    // 而版本回退在覆盖安装时可能被 NSIS 拒绝 —— 必须显式失败。
    const bad = [
      '', '1', '1.2', '1.2.3.4', 'v1.2.3', '01.2.3', '1.2.3-beta',
      'a.b.c', '1.2.-3', '  ', '1..2',
    ]
    for (const input of bad) {
      expect(parseSemVer(input), JSON.stringify(input)).toBeNull()
    }
  })

  it('非字符串输入返回 null 而不是抛错', () => {
    expect(parseSemVer(undefined as unknown as string)).toBeNull()
    expect(parseSemVer(null as unknown as string)).toBeNull()
    expect(parseSemVer(123 as unknown as string)).toBeNull()
  })
})

describe('formatSemVer / bumpSemVer', () => {
  it('格式化与解析互逆', () => {
    for (const v of ['0.1.0', '0.2.0', '1.0.0', '3.14.15']) {
      expect(formatSemVer(parseSemVer(v)!)).toBe(v)
    }
  })

  it('三种升位都遵守 semver 归零规则', () => {
    const base = { major: 1, minor: 2, patch: 3 }
    expect(formatSemVer(bumpSemVer(base, 'patch'))).toBe('1.2.4')
    expect(formatSemVer(bumpSemVer(base, 'minor'))).toBe('1.3.0')
    expect(formatSemVer(bumpSemVer(base, 'major'))).toBe('2.0.0')
  })

  it('从 0.x 升 minor 得到 0.(x+1).0（本次要走的路径）', () => {
    expect(formatSemVer(bumpSemVer({ major: 0, minor: 1, patch: 0 }, 'minor'))).toBe('0.2.0')
    expect(formatSemVer(bumpSemVer({ major: 0, minor: 2, patch: 0 }, 'patch'))).toBe('0.2.1')
  })
})

describe('releaseFromSubject（前缀 → 升哪一位）', () => {
  it('feat 升 minor', () => {
    const cases = [
      'feat: 新增当前目录文件名搜索',
      'feat(ui): 支持多选下载',
      'feat: 设置页显示版本号',
    ]
    for (const s of cases) expect(releaseFromSubject(s), s).toBe('minor')
  })

  it('fix / 其他维护类型升 patch', () => {
    const cases = [
      'fix: 修复更换目录参数不合法',
      'perf: 列表滚动优化',
      'refactor: 应用更名为 HASH 并更新 appId',
      'style: 统一亮色主题',
      'test: 补齐版本号用例',
      'build: 升级 electron',
      'docs: 更新计划',
      'chore: 清理临时文件',
      'ci: 增加构建流水线',
      'revert: 回滚某次改动',
    ]
    for (const s of cases) expect(releaseFromSubject(s), s).toBe('patch')
  })

  it('breaking change 升 major，且优先于 feat 判定', () => {
    // feat! 必须先被 breaking 拦下，否则会被当成普通 feat 只升 minor，
    // 一次不兼容改动就悄悄混进小版本里。
    const cases = [
      'feat!: 移除本地面板',
      'fix!: 改写下载路径协议',
      'refactor(core)!: 重命名 IPC 通道',
      'feat: x BREAKING CHANGE: 接口变更',
    ]
    for (const s of cases) expect(releaseFromSubject(s), s).toBe('major')
  })

  it('认不出的前缀或无前缀一律 patch（保守）', () => {
    const cases = [
      '随手改了点东西',
      'update stuff',
      'WIP',
      'featx: 假的类型',
      ': 冒号开头',
    ]
    for (const s of cases) expect(releaseFromSubject(s), s).toBe('patch')
  })

  it('空输入按 patch 处理，不抛错', () => {
    expect(releaseFromSubject('')).toBe('patch')
    expect(releaseFromSubject('   ')).toBe('patch')
    expect(releaseFromSubject(undefined as unknown as string)).toBe('patch')
  })

  it('前缀大小写不敏感', () => {
    expect(releaseFromSubject('FEAT: 大写')).toBe('minor')
    expect(releaseFromSubject('Fix: 混合')).toBe('patch')
  })
})

describe('shouldRefuseBump（同一 commit 不重复 bump）', () => {
  it('同一 commit 拒绝', () => {
    expect(shouldRefuseBump('abc123', 'abc123')).toBe(true)
  })

  it('不同 commit 放行', () => {
    expect(shouldRefuseBump('abc123', 'def456')).toBe(false)
  })

  it('没有记录时放行（首次 bump）', () => {
    expect(shouldRefuseBump('', 'abc123')).toBe(false)
    expect(shouldRefuseBump('abc123', '')).toBe(false)
  })
})

describe('shouldRefuseBuild（版本号没变不许打包）', () => {
  it('与上次打包版本相同必须中止', () => {
    expect(shouldRefuseBuild('0.1.0', '0.1.0')).toBe(true)
  })

  it('版本号变了放行', () => {
    expect(shouldRefuseBuild('0.2.0', '0.1.0')).toBe(false)
  })

  it('首次打包放行', () => {
    expect(shouldRefuseBuild('0.1.0', '')).toBe(false)
  })

  it('比较的是完整字符串，不是数值', () => {
    // 0.1.0 与 0.1.0 是同一份；但 0.10.0 与 0.1.0 必须不同
    expect(shouldRefuseBuild('0.10.0', '0.1.0')).toBe(false)
    expect(shouldRefuseBuild('0.1.0', '0.10.0')).toBe(false)
  })
})
