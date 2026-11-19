import { describe, it, expect } from 'vitest'
import {
  MAX_ROWS,
  baseNameOf,
  checkTargetDir,
  dockRows,
  hasActiveTransfer,
  hasFinishedTransfer,
  hasRetryableTransfer,
  sameSnapshot,
  serialTail,
} from '../src/shared/transfer-view'
import type { TransferSnapshot, TransferTask } from '../src/shared/transfer'

function task(over: Partial<TransferTask> = {}): TransferTask {
  return {
    id: 't1',
    serial: '9N9CN2G0012A3P',
    direction: 'push',
    src: '/home/u/中文 文件.bin',
    dst: '/sdcard/Download/中文 文件.bin',
    totalBytes: 100,
    doneBytes: 25,
    status: 'running',
    attempt: 0,
    createdAt: 0,
    ...over,
  }
}

function snap(tasks: TransferTask[]): TransferSnapshot {
  return {
    tasks,
    running: tasks.filter((t) => t.status === 'running').length,
    queued: tasks.filter((t) => t.status === 'queued').length,
  }
}

describe('底栏行构造', () => {
  it('baseNameOf 同时认 / 与 \\，且保留中文与空格', () => {
    expect(baseNameOf('/sdcard/Download/中文 文件.bin')).toBe('中文 文件.bin')
    expect(baseNameOf('C:\\Users\\u\\照片 1.jpg')).toBe('照片 1.jpg')
    expect(baseNameOf('plain.txt')).toBe('plain.txt')
  })

  it('serialTail 留后 4 位，短 serial 原样返回', () => {
    // 9N9CN2G0012A3P 的后 4 位是 2A3P（不是我最初写错的 3 位 A3P）
    expect(serialTail('9N9CN2G0012A3P')).toBe('2A3P')
    expect(serialTail('ABC')).toBe('ABC')
    expect(serialTail('ABCD')).toBe('ABCD')
  })

  it('正在跑的任务排在最前，终态在后', () => {
    const rows = dockRows(snap([
      task({ id: 'done1', status: 'done' }),
      task({ id: 'run1', status: 'running' }),
      task({ id: 'queue1', status: 'queued' }),
    ]))
    expect(rows.map((r) => r.id)).toEqual(['run1', 'queue1', 'done1'])
  })

  it('总量未知时进度是不确定态（裁决 5：不能显示 0% 或 100%）', () => {
    const rows = dockRows(snap([task({ totalBytes: null, doneBytes: 1234 })]))
    expect(rows[0].progress).toEqual({ kind: 'indeterminate' })
    expect(rows[0].progressText).toBe('1.2 KB')
  })

  it('已知总量时给出百分比与「已完成/总量」文案', () => {
    const rows = dockRows(snap([task()]))
    expect(rows[0].progress).toEqual({ kind: 'determinate', percent: 25 })
    expect(rows[0].progressText).toContain('/')
  })

  it('失败任务的 canRetry 为 true，在跑的 canCancel 为 true', () => {
    const rows = dockRows(snap([
      task({ id: 'a', status: 'failed', error: 'E_SYNC_FAILED' }),
      task({ id: 'b', status: 'running' }),
    ]))
    /*
     * 排序是「在跑 → 排队 → 终态」，所以 running 的 b 在 rows[0]、failed 的 a 在 rows[1]。
     * 这是 dockRows 的既定语义（用户最关心在跑的），不是取错下标。
     */
    expect(rows[0].id).toBe('b')
    expect(rows[0].canCancel).toBe(true)
    expect(rows[1].id).toBe('a')
    expect(rows[1].canRetry).toBe(true)
    expect(rows[1].error).toBe('E_SYNC_FAILED')
  })

  it('覆盖标记与离线暂停标记都透出来（裁决 7 / 4）', () => {
    const rows = dockRows(
      snap([task({ id: 'o', status: 'done', overwrote: true }), task({ id: 'p', status: 'queued' })]),
      ['9N9CN2G0012A3P'],
    )
    // 同上的排序语义：queued 在前，done 在后
    expect(rows[0].id).toBe('p')
    expect(rows[0].pausedOffline).toBe(true)
    expect(rows[1].id).toBe('o')
    expect(rows[1].overwrote).toBe(true)
  })

  it('行数上限 MAX_ROWS，避免终态任务把底栏撑爆', () => {
    const many = Array.from({ length: 20 }, (_, i) => task({ id: 'x' + i, status: 'done' }))
    expect(dockRows(snap(many))).toHaveLength(MAX_ROWS)
  })

  /*
   * 【审查 M6】修前是整个数组 slice(0, MAX_ROWS)：一次上传 8 个文件时，
   * 第 7、8 个任务即使正在跑也会从底栏消失，用户会以为没传。
   * 现在 MAX_ROWS 只截断终态行，活跃行永不截断。
   */
  it('活跃任务不受 MAX_ROWS 限制（一次传 8 个文件时必须全看得到）', () => {
    const many = [
      ...Array.from({ length: 8 }, (_, i) => task({ id: 'run' + i, status: 'running' as const })),
      ...Array.from({ length: 5 }, (_, i) => task({ id: 'done' + i, status: 'done' as const })),
    ]
    const rows = dockRows(snap(many))
    // 8 个在跑的全在，终态一条都放不下（预算 6-8 < 0）
    expect(rows.filter((r) => r.status === 'running')).toHaveLength(8)
    expect(rows.filter((r) => r.status === 'done')).toHaveLength(0)
  })
})

describe('快照派生判断', () => {
  it('hasActiveTransfer / hasFinishedTransfer / hasRetryableTransfer', () => {
    expect(hasActiveTransfer(snap([task()]))).toBe(true)
    expect(hasActiveTransfer(snap([task({ status: 'done' })]))).toBe(false)
    expect(hasFinishedTransfer(snap([task({ status: 'done' })]))).toBe(true)
    expect(hasFinishedTransfer(snap([task({ status: 'failed' })]))).toBe(false)
    expect(hasRetryableTransfer(snap([task({ status: 'failed' })]))).toBe(true)
    expect(hasRetryableTransfer(snap([task({ status: 'done' })]))).toBe(false)
  })

  it('sameSnapshot 能识别真正没变化的推送', () => {
    const a = snap([task()])
    const b = snap([task()])
    expect(sameSnapshot(a, b)).toBe(true)
    expect(sameSnapshot(a, snap([task({ doneBytes: 26 })]))).toBe(false)
    expect(sameSnapshot(a, snap([task({ status: 'done' })]))).toBe(false)
    expect(sameSnapshot(a, snap([]))).toBe(false)
  })
})

describe('目标目录校验', () => {
  it('空目录与含控制字符的目录被拒', () => {
    expect(checkTargetDir('/sdcard/Download')).toEqual({ ok: true })
    expect(checkTargetDir('   ')).toEqual({ ok: false, code: 'E_INVALID_PATH' })
    expect(checkTargetDir('/sdcard/a\nb')).toEqual({ ok: false, code: 'E_INVALID_PATH' })
  })
})
