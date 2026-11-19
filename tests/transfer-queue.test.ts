import { describe, it, expect } from 'vitest'
import { TransferQueue } from '../electron/transfer/queue'

/*
 * 裁决 4：并发策略按规格，但必须有【可测的不变量】。
 * 单设备并发 1（FIFO），全局默认 3。
 * 这里全部用可注入的假执行器/纯队列，绝不靠真 adb 计时。
 */

function makeQueue(over: Partial<{ maxPerDevice: number; maxGlobal: number }> = {}) {
  return new TransferQueue({ maxPerDevice: 1, maxGlobal: 3, now: () => 1000, ...over })
}

describe('TransferQueue：并发不变量', () => {
  it('默认配置：单设备 1、全局 3', () => {
    const q = new TransferQueue()
    expect(q.maxPerDevice).toBe(1)
    expect(q.maxGlobal).toBe(3)
  })

  it('同一设备串行：先入队先执行（FIFO）', () => {
    const q = makeQueue()
    const a = q.enqueue({ serial: 'A', direction: 'push', src: 'x', dst: 'y', totalBytes: 10 })
    const b = q.enqueue({ serial: 'A', direction: 'push', src: 'x2', dst: 'y2', totalBytes: 10 })
    expect(q.next()).toBe(a.id)
    // A 已满：不能再放 A 的第二个任务
    expect(q.next()).toBeNull()
    q.finish(a.id, 'done')
    expect(q.next()).toBe(b.id)
  })

  it('不同设备可并行，且全局不超过 3', () => {
    const q = makeQueue()
    const tasks = ['A', 'B', 'C', 'D'].map((serial) =>
      q.enqueue({ serial, direction: 'push', src: 'x', dst: 'y', totalBytes: 1 }))
    expect(q.next()).toBe(tasks[0].id)
    expect(q.next()).toBe(tasks[1].id)
    expect(q.next()).toBe(tasks[2].id)
    // 第 4 个设备必须等：全局并发已到 3
    expect(q.next()).toBeNull()
    q.finish(tasks[0].id, 'done')
    expect(q.next()).toBe(tasks[3].id)
  })

  it('maxGlobal 可配到 6（设置可调 1-6）', () => {
    const q = makeQueue({ maxGlobal: 6 })
    for (let i = 0; i < 6; i++) {
      q.enqueue({ serial: 'S' + i, direction: 'push', src: 'x', dst: 'y', totalBytes: 1 })
    }
    for (let i = 0; i < 6; i++) expect(q.next()).not.toBeNull()
    expect(q.next()).toBeNull()
  })

  it('runningCount 反映真实在跑数量，finish 后释放', () => {
    const q = makeQueue()
    const a = q.enqueue({ serial: 'A', direction: 'push', src: 'x', dst: 'y', totalBytes: 1 })
    expect(q.runningCount()).toBe(0)
    q.next()
    expect(q.runningCount()).toBe(1)
    expect(q.runningCount('A')).toBe(1)
    expect(q.runningCount('B')).toBe(0)
    q.finish(a.id, 'done')
    expect(q.runningCount()).toBe(0)
  })
})

describe('TransferQueue：掉线暂停（裁决 4）', () => {
  it('掉线设备的排队任务不再出队，但在线设备不受影响', () => {
    const q = makeQueue()
    const offlineTask = q.enqueue({ serial: 'A', direction: 'pull', src: 'x', dst: 'y', totalBytes: 1 })
    const onlineTask = q.enqueue({ serial: 'B', direction: 'pull', src: 'x', dst: 'y', totalBytes: 1 })
    q.setDeviceOnline('A', false)
    expect(q.next()).toBe(onlineTask.id)
    expect(q.next()).toBeNull()
    // 任务仍在队列里，未被丢弃 → 可重试
    expect(q.get(offlineTask.id)?.status).toBe('queued')
  })

  it('设备重新上线后该设备队列继续', () => {
    const q = makeQueue()
    const t = q.enqueue({ serial: 'A', direction: 'pull', src: 'x', dst: 'y', totalBytes: 1 })
    q.setDeviceOnline('A', false)
    expect(q.next()).toBeNull()
    q.setDeviceOnline('A', true)
    expect(q.next()).toBe(t.id)
  })

  it('设备不在线时不占用全局并发额度', () => {
    const q = makeQueue()
    q.setDeviceOnline('A', false)
    q.enqueue({ serial: 'A', direction: 'pull', src: 'x', dst: 'y', totalBytes: 1 })
    for (const serial of ['B', 'C', 'D']) {
      q.enqueue({ serial, direction: 'pull', src: 'x', dst: 'y', totalBytes: 1 })
    }
    // 3 个在线设备都能跑满全局额度
    expect(q.next()).not.toBeNull()
    expect(q.next()).not.toBeNull()
    expect(q.next()).not.toBeNull()
    expect(q.next()).toBeNull()
  })
})

describe('TransferQueue：失败保留与重试（裁决 7）', () => {
  it('失败任务留在列表里，状态为 failed 并带错误码', () => {
    const q = makeQueue()
    const t = q.enqueue({ serial: 'A', direction: 'push', src: 'x', dst: 'y', totalBytes: 10 })
    q.next()
    q.finish(t.id, 'failed', 'E_SYNC_FAILED')
    const after = q.get(t.id)
    expect(after?.status).toBe('failed')
    expect(after?.error).toBe('E_SYNC_FAILED')
    expect(q.list().length).toBe(1)
  })

  it('重试把失败任务放回队列，attempt 递增、进度归零', () => {
    const q = makeQueue()
    const t = q.enqueue({ serial: 'A', direction: 'push', src: 'x', dst: 'y', totalBytes: 10 })
    q.next()
    q.progress(t.id, 7)
    q.finish(t.id, 'failed', 'E_SYNC_FAILED')
    expect(q.retry(t.id)).toBe(true)
    const retried = q.get(t.id)
    expect(retried?.status).toBe('queued')
    expect(retried?.attempt).toBe(1)
    expect(retried?.doneBytes).toBe(0)
    expect(retried?.error).toBeUndefined()
    // 重试后能再次出队
    expect(q.next()).toBe(t.id)
  })

  it('只有 failed / canceled 可以重试（在跑/已完成的不行）', () => {
    const q = makeQueue()
    const t = q.enqueue({ serial: 'A', direction: 'push', src: 'x', dst: 'y', totalBytes: 1 })
    expect(q.retry(t.id)).toBe(false) // queued 不能重试
    q.next()
    expect(q.retry(t.id)).toBe(false) // running 不能重试
    q.finish(t.id, 'done')
    expect(q.retry(t.id)).toBe(false) // done 不能重试
  })

  it('取消排队中的任务：状态变 canceled、不占并发、可重试', () => {
    const q = makeQueue()
    const t = q.enqueue({ serial: 'A', direction: 'push', src: 'x', dst: 'y', totalBytes: 1 })
    expect(q.cancel(t.id)).toBe(true)
    expect(q.get(t.id)?.status).toBe('canceled')
    expect(q.next()).toBeNull()
    expect(q.retry(t.id)).toBe(true)
  })
})

describe('TransferQueue：进度与快照', () => {
  it('progress 不超过 totalBytes，也拒绝负数', () => {
    const q = makeQueue()
    const t = q.enqueue({ serial: 'A', direction: 'push', src: 'x', dst: 'y', totalBytes: 10 })
    q.next()
    q.progress(t.id, 99)
    expect(q.get(t.id)?.doneBytes).toBe(10)
    q.progress(t.id, -3)
    expect(q.get(t.id)?.doneBytes).toBe(0)
  })

  it('totalBytes 未知（null）时进度照收但不做上界夹取', () => {
    const q = makeQueue()
    const t = q.enqueue({ serial: 'A', direction: 'pull', src: 'x', dst: 'y', totalBytes: null })
    q.next()
    q.progress(t.id, 123456)
    expect(q.get(t.id)?.doneBytes).toBe(123456)
  })

  it('snapshot 给出排队/在跑计数', () => {
    const q = makeQueue()
    q.enqueue({ serial: 'A', direction: 'push', src: 'x', dst: 'y', totalBytes: 1 })
    q.enqueue({ serial: 'B', direction: 'push', src: 'x', dst: 'y', totalBytes: 1 })
    q.next()
    const snap = q.snapshot()
    expect(snap.running).toBe(1)
    expect(snap.queued).toBe(1)
    expect(snap.tasks.length).toBe(2)
  })

  /*
   * 判断谁错（写测试时先按「清掉所有终态」写的，实现时发现与裁决 7 冲突）：
   *
   * 裁决 7 要求「失败的传输保留在列表里并可一键重试」。若 clearFinished 把 failed 一并删掉，
   * 用户点完「清除已完成」就再也没有那个任务可重试了 —— 与裁决 7 直接冲突。
   * canceled 同理（取消后也可能想重来）。所以清除范围收窄为【只有 done 的】，
   * 这是控制者裁决优先于我自己先写下的断言，不是为了让测试变绿而放宽。
   */
  it('clearFinished 只清掉已完成的任务（失败/取消的保留以便重试，裁决 7）', () => {
    const q = makeQueue()
    const a = q.enqueue({ serial: 'A', direction: 'push', src: 'x', dst: 'y', totalBytes: 1 })
    const b = q.enqueue({ serial: 'B', direction: 'push', src: 'x', dst: 'y', totalBytes: 1 })
    const c = q.enqueue({ serial: 'C', direction: 'push', src: 'x', dst: 'y', totalBytes: 1 })
    q.finish(a.id, 'done')
    q.finish(b.id, 'failed', 'E_SYNC_FAILED')
    expect(q.clearFinished()).toBe(1)
    expect(q.list().map((t) => t.id)).toEqual([b.id, c.id])
    // 失败的任务确实还能重试（清除不该把它变成孤儿）
    expect(q.retry(b.id)).toBe(true)
  })
})
