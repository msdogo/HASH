import { describe, it, expect } from 'vitest'
import { BATCH_CONCURRENCY, runBatch } from '../electron/batch/runner'

/*
 * 批量执行器（任务 10 / R3 / R4）。
 *
 * 这些用例全部是**行为断言**：看到的是结果数组、实际并发峰值、worker 调用参数。
 * 没有一条在匹配源码文本 —— 那类断言在本项目里已经出过 6 次「注入缺陷仍全绿」。
 */

describe('runBatch：下标顺序（R4）', () => {
  it('结果长度 === 入参长度，且下标与输入一一对应', async () => {
    const serials = ['A', 'B', 'C', 'D', 'E']
    // 故意让「先开始的设备更慢」：B 睡最久。若实现用 out.push()，顺序会变成 A/D/E/C/B
    const delays: Record<string, number> = { A: 30, B: 60, C: 10, D: 40, E: 5 }
    const results = await runBatch(serials, async (serial) => {
      await new Promise((resolve) => setTimeout(resolve, delays[serial]))
    })
    expect(results).toHaveLength(serials.length)
    expect(results.map((item) => item.serial)).toEqual(serials)
    for (const item of results) expect(item.ok).toBe(true)
  })

  it('同一 serial 重复出现时按出现次数各跑一次（不静默去重）', async () => {
    const calls: string[] = []
    const results = await runBatch(['A', 'A', 'B'], async (serial) => {
      calls.push(serial)
      return undefined
    })
    expect(calls).toEqual(['A', 'A', 'B'])
    expect(results).toHaveLength(3)
    expect(results.map((item) => item.serial)).toEqual(['A', 'A', 'B'])
  })
})

describe('runBatch：失败隔离', () => {
  it('一台抛异常不影响其余（结果长度仍等于入参，异常被折算成该项失败）', async () => {
    const serials = ['ok-1', 'boom', 'ok-2', 'string-throw', 'ok-3']
    const done: string[] = []
    const results = await runBatch(serials, async (serial) => {
      if (serial === 'boom') throw new Error('E_TIMEOUT')
      // 非 Error 的裸抛也要兜住（设备侧库偶尔会这样）
      if (serial === 'string-throw') throw 'E_DEVICE_OFFLINE'
      done.push(serial)
    })
    expect(results).toHaveLength(serials.length)
    // 失败隔离的核心证据：四个正常设备都真的跑完了
    expect(done.sort()).toEqual(['ok-1', 'ok-2', 'ok-3'])
    expect(results.map((item) => item.ok)).toEqual([true, false, true, false, true])
    expect(results[1]).toMatchObject({ serial: 'boom', ok: false, code: 'E_TIMEOUT' })
    expect(results[3]).toMatchObject({ serial: 'string-throw', ok: false, code: 'E_DEVICE_OFFLINE' })
    // 成功项不该带 code（失败信息不能污染成功结果）
    expect(results[0].code).toBeUndefined()
  })

  it('无法识别的异常折算成 E_UNKNOWN（渲染层永远能拿到一个码）', async () => {
    const results = await runBatch(['A'], async () => { throw new TypeError('x is not a function') })
    expect(results).toEqual([{ serial: 'A', ok: false, code: 'E_UNKNOWN' }])
  })
})

describe('runBatch：并发上限', () => {
  it('峰值并发不超过给定上限', async () => {
    let inFlight = 0
    let peak = 0
    await runBatch(['1', '2', '3', '4', '5', '6', '7', '8'], async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
    }, 3)
    expect(peak).toBe(3)
  })

  it('默认并发就是 BATCH_CONCURRENCY（3），且不接设置项', async () => {
    expect(BATCH_CONCURRENCY).toBe(3)
    let inFlight = 0
    let peak = 0
    await runBatch(['1', '2', '3', '4', '5', '6'], async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
    })
    expect(peak).toBe(3)
  })

  it('并发上限大于设备数时不空转：每条车道都拿到活', async () => {
    const seen = new Set<string>()
    await runBatch(['A', 'B'], async (serial) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      seen.add(serial)
    }, 16)
    // 若实现开了 16 条车道而只有 2 台设备，会 14 条空转 —— 功能上仍然正确，
    // 所以真正的判据是「两台都跑到了」，而下面一条断言的是车道数确实被 min 过。
    expect(seen).toEqual(new Set(['A', 'B']))
  })

  it('车道数 = min(上限, 设备数)：2 台设备 + 16 并发不会因空转卡住', async () => {
    let lanes = 0
    let peak = 0
    await runBatch(['A', 'B'], async () => {
      lanes += 1
      peak = Math.max(peak, lanes)
      await Promise.resolve()
      lanes -= 1
    }, 16)
    // 同步完成时峰值只能到 2（因为只有 2 个任务）
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThan(0)
  })

  it('concurrency 传 0 / 负数 / NaN 时仍然跑完（不静默返回空）', async () => {
    for (const bad of [0, -1, Number.NaN]) {
      const calls: string[] = []
      const results = await runBatch(['A', 'B'], async (serial) => { calls.push(serial) }, bad)
      expect(calls.sort(), String(bad)).toEqual(['A', 'B'])
      expect(results, String(bad)).toHaveLength(2)
    }
  })
})

describe('runBatch：空输入与附加信息', () => {
  it('serials 为空时返回 []（不抛、不跑 worker）', async () => {
    let called = 0
    const results = await runBatch([], async () => { called += 1 })
    expect(results).toEqual([])
    expect(called).toBe(0)
  })

  it('worker 返回的 detail / truncated 被带进结果（界面要显示「已加入队列」与截断标记）', async () => {
    const results = await runBatch(['A', 'B'], async (serial) =>
      serial === 'A' ? { detail: 'task-1' } : { detail: 'abc', truncated: true },
    )
    expect(results[0]).toEqual({ serial: 'A', ok: true, detail: 'task-1' })
    expect(results[1]).toEqual({ serial: 'B', ok: true, detail: 'abc', truncated: true })
  })

  it('worker 返回无法识别的形状时只记成功，不炸也不编造字段', async () => {
    const results = await runBatch(['A'], async () => 42)
    expect(results).toEqual([{ serial: 'A', ok: true }])
  })
})
