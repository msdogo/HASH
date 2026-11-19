import { describe, it, expect, vi } from 'vitest'
import { TransferManager } from '../electron/transfer/manager'
import type { TransferRun } from '../electron/transfer/runner'
import type { TransferTask } from '../src/shared/transfer'
import { E_ABORTED, E_DEVICE_OFFLINE } from '../src/shared/errors'

/*
 * 调度器（裁决 4 / 6 / 7）。
 *
 * 这里的执行器全部是【可注入的假执行器】：靠真 adb 计时做并发断言是不稳定的，
 * 而且无法精确构造「三个设备同时在跑」这种瞬时状态。
 */

interface FakeRun {
  task: TransferRun
  /** 让假执行器完成（或失败）。 */
  done: (result: { ok: true; bytes?: number } | { ok: false; code: string }) => void
  /** 让假执行器上报进度。 */
  progress: (doneBytes: number) => void
}

function createHarness(over: Partial<{ maxGlobal: number; maxPerDevice: number; now: () => number }> = {}) {
  const runs: FakeRun[] = []
  const events: Array<{ type: string; id: string }> = []
  let concurrent = 0
  let peakGlobal = 0
  const perDevicePeak = new Map<string, number>()
  const perDeviceNow = new Map<string, number>()

  const manager = new TransferManager({
    maxGlobal: over.maxGlobal,
    maxPerDevice: over.maxPerDevice,
    now: over.now,
    // 假执行器：记录并发峰值，并把控制权交给测试
    execute: (task, ctx) => {
      concurrent += 1
      peakGlobal = Math.max(peakGlobal, concurrent)
      const deviceNow = (perDeviceNow.get(task.serial) ?? 0) + 1
      perDeviceNow.set(task.serial, deviceNow)
      perDevicePeak.set(task.serial, Math.max(perDevicePeak.get(task.serial) ?? 0, deviceNow))
      return new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          concurrent -= 1
          perDeviceNow.set(task.serial, (perDeviceNow.get(task.serial) ?? 1) - 1)
          resolve({ ok: false, code: E_ABORTED })
        })
        runs.push({
          task,
          done: (result) => {
            concurrent -= 1
            perDeviceNow.set(task.serial, (perDeviceNow.get(task.serial) ?? 1) - 1)
            resolve(result)
          },
          progress: (doneBytes) => { ctx.onProgress(doneBytes, task.totalBytes) },
        })
      })
    },
    emit: (event) => { events.push({ type: event.type, id: event.task.id }) },
  })

  return { manager, runs, events, getPeak: () => peakGlobal, perDevicePeak }
}

const flush = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 0)) }

describe('裁决 4：调度器不变量', () => {
  it('同一 serial 同时最多 1 个在跑', async () => {
    const h = createHarness()
    for (let i = 0; i < 4; i++) {
      h.manager.enqueue({ serial: 'A', direction: 'push', src: 'f' + i, dst: '/sdcard/f' + i })
    }
    h.manager.pump()
    await flush()
    expect(h.runs.length).toBe(1)
    expect(h.manager.runningCount('A')).toBe(1)
    expect(h.perDevicePeak.get('A')).toBe(1)
  })

  it('全局最多 3 个在跑（默认）', async () => {
    const h = createHarness()
    for (const serial of ['A', 'B', 'C', 'D', 'E']) {
      h.manager.enqueue({ serial, direction: 'pull', src: '/sdcard/x', dst: 'x' })
    }
    h.manager.pump()
    await flush()
    expect(h.runs.length).toBe(3)
    expect(h.getPeak()).toBe(3)
  })

  it('完成一个后自动补下一个（不漏任务）', async () => {
    const h = createHarness()
    for (const serial of ['A', 'B', 'C', 'D']) {
      h.manager.enqueue({ serial, direction: 'pull', src: '/sdcard/x', dst: 'x' })
    }
    h.manager.pump()
    await flush()
    expect(h.runs.length).toBe(3)
    h.runs[0].done({ ok: true })
    await flush()
    expect(h.runs.length).toBe(4)
    expect(h.getPeak()).toBe(3)
  })

  it('maxGlobal 可配到 6 且真的生效', async () => {
    const h = createHarness({ maxGlobal: 6 })
    for (const serial of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      h.manager.enqueue({ serial, direction: 'pull', src: '/sdcard/x', dst: 'x' })
    }
    h.manager.pump()
    await flush()
    expect(h.runs.length).toBe(6)
    expect(h.getPeak()).toBe(6)
    // 并发上限不能被配置冲破
    expect(h.manager.runningCount()).toBeLessThanOrEqual(6)
  })
})

describe('裁决 4：设备掉线', () => {
  it('掉线时该设备队列暂停，任务保留可重试，其它设备继续跑', async () => {
    const h = createHarness()
    /*
     * 顺序有讲究：必须【先】标掉线再入队。
     * 反过来的话 enqueue 内部的自动 pump 会立刻把 A 的第一个任务跑起来，
     * 那测的就不是「掉线设备的排队任务不出队」，而是「在跑的任务遇掉线」
     * —— 后者由下一条用例专门覆盖。这里刻意保持两个场景分开。
     */
    h.manager.setDeviceOnline('A', false)
    const a1 = h.manager.enqueue({ serial: 'A', direction: 'push', src: 'f1', dst: '/sdcard/f1' })
    const a2 = h.manager.enqueue({ serial: 'A', direction: 'push', src: 'f2', dst: '/sdcard/f2' })
    const b1 = h.manager.enqueue({ serial: 'B', direction: 'push', src: 'f3', dst: '/sdcard/f3' })
    h.manager.pump()
    await flush()

    // A 的任务不会出队；B 照跑
    expect(h.runs.map((r) => r.task.id)).toEqual([b1.id])
    expect(h.manager.get(a1.id)?.status).toBe('queued')
    expect(h.manager.get(a2.id)?.status).toBe('queued')
  })

  it('在跑的任务遇到掉线：被取消并标为失败（可重试），不是静默成功', async () => {
    const h = createHarness()
    const t = h.manager.enqueue({ serial: 'A', direction: 'push', src: 'f1', dst: '/sdcard/f1' })
    h.manager.pump()
    await flush()
    expect(h.runs.length).toBe(1)

    h.manager.setDeviceOnline('A', false)
    await flush()

    const after = h.manager.get(t.id)
    expect(after?.status).toBe('failed')
    expect(after?.error).toBe(E_DEVICE_OFFLINE)
    // 保留在列表里，可重试
    expect(h.manager.retry(t.id)).toBe(true)
    h.manager.setDeviceOnline('A', true)
    h.manager.pump()
    await flush()
    expect(h.runs.length).toBe(2)
  })
})

describe('裁决 6：进度事件节流', () => {
  it('密集进度输入下推进次数被限制在合理范围', async () => {
    let clock = 0
    const h = createHarness({ now: () => clock })
    const t = h.manager.enqueue({
      serial: 'A', direction: 'push', src: 'f1', dst: '/sdcard/f1', totalBytes: 1000,
    })
    // 注意：假执行器从 TransferRun 里读 totalBytes（调度层下发的快照）
    h.manager.pump()
    await flush()

    // 1ms 一次、每次 +1% → 1000 次输入
    for (let i = 1; i <= 1000; i++) {
      clock = i
      h.runs[0].progress(i)
    }
    await flush()

    const progressEvents = h.events.filter((e) => e.type === 'progress' && e.id === t.id)
    // 1000ms / 100ms 窗口 → 上限约 11 次
    expect(progressEvents.length).toBeLessThanOrEqual(12)
    expect(progressEvents.length).toBeGreaterThan(0)
  })

  it('进度信息仍然会到终态 100%（节流不能把完成态也吞掉）', async () => {
    let clock = 0
    const h = createHarness({ now: () => clock })
    const t = h.manager.enqueue({
      serial: 'A', direction: 'push', src: 'f1', dst: '/sdcard/f1', totalBytes: 100,
    })
    h.manager.pump()
    await flush()
    for (let i = 1; i <= 100; i++) { clock = i; h.runs[0].progress(i) }
    await flush()
    expect(h.manager.get(t.id)?.doneBytes).toBe(100)
  })
})

describe('裁决 7：失败保留与重试', () => {
  it('失败任务留在列表里并可一键重试', async () => {
    const h = createHarness()
    const t = h.manager.enqueue({ serial: 'A', direction: 'push', src: 'f1', dst: '/sdcard/f1' })
    h.manager.pump()
    await flush()
    h.runs[0].done({ ok: false, code: 'E_SYNC_FAILED' })
    await flush()

    expect(h.manager.get(t.id)?.status).toBe('failed')
    expect(h.manager.get(t.id)?.error).toBe('E_SYNC_FAILED')
    expect(h.manager.list().length).toBe(1)

    expect(h.manager.retry(t.id)).toBe(true)
    h.manager.pump()
    await flush()
    expect(h.runs.length).toBe(2)
    expect(h.manager.get(t.id)?.attempt).toBe(1)
  })

  it('取消后的任务也可以重试', async () => {
    const h = createHarness()
    const t = h.manager.enqueue({ serial: 'A', direction: 'push', src: 'f1', dst: '/sdcard/f1' })
    h.manager.pump()
    await flush()
    expect(h.manager.cancel(t.id)).toBe(true)
    await flush()
    expect(h.manager.get(t.id)?.status).toBe('canceled')
    expect(h.manager.retry(t.id)).toBe(true)
  })
})

describe('覆盖提示（裁决 7：默认覆盖，界面要提示）', () => {
  it('上传时目标已存在 → 任务带 overwrote 标记', async () => {
    const manager = new TransferManager({
      execute: async () => ({ ok: true, overwrote: true }),
      emit: () => {},
    })
    const t = manager.enqueue({ serial: 'A', direction: 'push', src: 'f1', dst: '/sdcard/f1' })
    manager.pump()
    await flush()
    expect(manager.get(t.id)?.overwrote).toBe(true)
  })
})
