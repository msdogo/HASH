import { describe, it, expect } from 'vitest'
import {
  deleteConfirmSummary,
  opLabel,
  runSequential,
  summarizeResults,
  type OpItemResult,
} from '../src/shared/fs-ops'

/*
 * 裁决 4：批量操作必须逐项容错，且结果可追溯。
 *
 * 规格要求「失败项单独标注，不影响其他」。这里的判据是三条：
 *   1. 返回值是**逐项结果数组**，不是单个布尔；
 *   2. 一项失败**不中断**其余（用假 runner 精确制造「第 2 项失败」）；
 *   3. 界面要能显示「N 成功 / M 失败」，失败项带错误码。
 *
 * 裁决 1：删除确认框必须列出「将删除 N 项」与前 3 个名称，
 * 递归删除目录时必须显示「该目录非空」这一事实。
 */

describe('裁决 4：逐项结果', () => {
  it('3 项里第 2 项失败：1、3 成功，第 2 项带错误码', async () => {
    const calls: string[] = []
    const results = await runSequential(['a.txt', 'b.txt', 'c.txt'], async (name) => {
      calls.push(name)
      if (name === 'b.txt') return { name, ok: false, code: 'E_NO_PERMISSION' }
      return { name, ok: true }
    })

    // 一项失败不中断其余：三项都被调用过，且顺序稳定（FIFO，便于用户对号入座）
    expect(calls).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(results).toEqual([
      { name: 'a.txt', ok: true },
      { name: 'b.txt', ok: false, code: 'E_NO_PERMISSION' },
      { name: 'c.txt', ok: true },
    ])
  })

  it('runner 抛异常也折算成该项失败，不会让整批 reject', async () => {
    const results = await runSequential(['a', 'b'], async (name) => {
      if (name === 'a') throw new Error('E_TIMEOUT')
      return { name, ok: true }
    })
    expect(results).toHaveLength(2)
    expect(results[0].ok).toBe(false)
    expect(results[0].code).toBe('E_TIMEOUT')
    expect(results[1]).toEqual({ name: 'b', ok: true })
  })

  it('抛出的值不是 Error（字符串/未知）也折算成 E_UNKNOWN', async () => {
    const results = await runSequential(['a'], async () => {
      throw 'boom'
    })
    expect(results[0]).toEqual({ name: 'a', ok: false, code: 'E_UNKNOWN' })
  })

  it('summarizeResults 给出「N 成功 / M 失败」与失败项清单', () => {
    const results: OpItemResult[] = [
      { name: 'a', ok: true },
      { name: 'b', ok: false, code: 'E_NO_PERMISSION' },
      { name: 'c', ok: false, code: 'E_NOT_FOUND' },
      { name: 'd', ok: true },
    ]
    const summary = summarizeResults(results)
    expect(summary).toEqual({ ok: 2, failed: 2, total: 4, failures: [
      { name: 'b', ok: false, code: 'E_NO_PERMISSION' },
      { name: 'c', ok: false, code: 'E_NOT_FOUND' },
    ] })
  })

  it('全成功时失败清单为空；空批次也不炸', () => {
    expect(summarizeResults([{ name: 'a', ok: true }]).failures).toEqual([])
    expect(summarizeResults([])).toEqual({ ok: 0, failed: 0, total: 0, failures: [] })
  })

  it('opLabel 取路径最后一段（成功/失败提示里要显示文件名而不是整条路径）', () => {
    expect(opLabel('/sdcard/Download/测试 目录')).toBe('测试 目录')
    expect(opLabel('/sdcard/a.txt')).toBe('a.txt')
    expect(opLabel('/')).toBe('/')
  })
})

describe('裁决 1：删除确认框的事实', () => {
  it('列出数量与前 3 个名称，多出的标记为已截断', () => {
    const summary = deleteConfirmSummary([
      { name: '照片1.jpg', isDir: false, nonEmpty: false },
      { name: '照片2.jpg', isDir: false, nonEmpty: false },
      { name: '照片3.jpg', isDir: false, nonEmpty: false },
      { name: '照片4.jpg', isDir: false, nonEmpty: false },
      { name: '照片5.jpg', isDir: false, nonEmpty: false },
    ])
    expect(summary.count).toBe(5)
    expect(summary.names).toEqual(['照片1.jpg', '照片2.jpg', '照片3.jpg'])
    expect(summary.truncated).toBe(true)
    expect(summary.hasNonEmptyDir).toBe(false)
  })

  it('少于 3 项时不截断', () => {
    const summary = deleteConfirmSummary([{ name: 'a', isDir: false, nonEmpty: false }])
    expect(summary.names).toEqual(['a'])
    expect(summary.truncated).toBe(false)
  })

  it('其中任一目录非空 → hasNonEmptyDir 为真（递归删除必须提示这一点）', () => {
    const summary = deleteConfirmSummary([
      { name: '空目录', isDir: true, nonEmpty: false },
      { name: 'DCIM', isDir: true, nonEmpty: true },
    ])
    expect(summary.hasNonEmptyDir).toBe(true)
  })

  it('文件的 nonEmpty 不影响判定（文件没有「非空」概念）', () => {
    const summary = deleteConfirmSummary([{ name: 'a.txt', isDir: false, nonEmpty: true }])
    expect(summary.hasNonEmptyDir).toBe(false)
  })
})
