import { describe, it, expect, vi, afterEach } from 'vitest'
import { DEFAULT_COALESCE_MS, Throttle, createDeviceChangeHub } from '../electron/ipc/throttle'

afterEach(() => { vi.useRealTimers() })

describe('事件合并（规格 8：≥50ms 合并一次）', () => {
  it('默认窗口是 50ms', () => {
    expect(DEFAULT_COALESCE_MS).toBe(50)
    expect(new Throttle<number>().waitMs).toBe(50)
  })

  it('窗口内的多次 push 合并成一次，payload 取最后一次', () => {
    vi.useFakeTimers()
    const seen: number[] = []
    const th = new Throttle<number>(50, (b) => { seen.push(b) })
    th.push(1)
    th.push(2)
    th.push(3)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(49)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual([3])
  })

  it('窗口从「首次 push」起算，不是每次都重置（避免持续变化永不派发）', () => {
    vi.useFakeTimers()
    const seen: number[] = []
    const th = new Throttle<number>(50, (b) => { seen.push(b) })
    th.push(1)
    vi.advanceTimersByTime(40)
    th.push(2)
    vi.advanceTimersByTime(10)
    expect(seen).toEqual([2])
  })

  it('间隔超过窗口的变更各自成批', () => {
    vi.useFakeTimers()
    const seen: number[] = []
    const th = new Throttle<number>(50, (b) => { seen.push(b) })
    th.push(1)
    vi.advanceTimersByTime(50)
    th.push(2)
    vi.advanceTimersByTime(50)
    expect(seen).toEqual([1, 2])
  })

  it('flush 立即派发挂起批次，并取消定时器', () => {
    vi.useFakeTimers()
    const seen: number[] = []
    const th = new Throttle<number>(50, (b) => { seen.push(b) })
    th.push(7)
    th.flush()
    expect(seen).toEqual([7])
    vi.advanceTimersByTime(100)
    expect(seen).toEqual([7])
  })

  it('flush 无挂起批次时什么都不做', () => {
    vi.useFakeTimers()
    let count = 0
    const th = new Throttle<number>(50, () => { count += 1 })
    th.flush()
    expect(count).toBe(0)
  })

  it('cancel 丢弃挂起批次，退出时不得再推', () => {
    vi.useFakeTimers()
    let count = 0
    const th = new Throttle<number>(50, () => { count += 1 })
    th.push(1)
    th.cancel()
    vi.advanceTimersByTime(100)
    expect(count).toBe(0)
  })

  it('pending 反映是否有未派发批次', () => {
    vi.useFakeTimers()
    const th = new Throttle<number>(50, () => {})
    expect(th.pending).toBe(false)
    th.push(1)
    expect(th.pending).toBe(true)
    th.flush()
    expect(th.pending).toBe(false)
  })
})

describe('设备变更合并器（裁决 5 的推送侧）', () => {
  it('单条变化在窗口后成批派发；removed 与 changed 合并进同一个批次', () => {
    vi.useFakeTimers()
    const hub = createDeviceChangeHub(50)
    const batches: Array<{ changed: string[]; removed: string[] }> = []
    hub.onPush((batch) => {
      batches.push({ changed: batch.changed.map((d) => d.serial), removed: batch.removed })
    })
    hub.push({ changed: [{ serial: 'A', status: 'device', transport: 'usb', lastSeenAt: 1 }], removed: [] })
    hub.push({ changed: [{ serial: 'B', status: 'device', transport: 'usb', lastSeenAt: 1 }], removed: ['C'] })
    expect(batches).toEqual([])
    vi.advanceTimersByTime(50)
    expect(batches).toEqual([{ changed: ['A', 'B'], removed: ['C'] }])
  })

  it('同一 serial 在窗口内多次变化只保留最后一条', () => {
    vi.useFakeTimers()
    const hub = createDeviceChangeHub(50)
    const batches: string[][] = []
    hub.onPush((b) => { batches.push(b.changed.map((d) => d.serial + ':' + d.status)) })
    hub.push({ changed: [{ serial: 'A', status: 'device', transport: 'usb', lastSeenAt: 1 }], removed: [] })
    hub.push({ changed: [{ serial: 'A', status: 'offline', transport: 'usb', lastSeenAt: 2 }], removed: [] })
    vi.advanceTimersByTime(50)
    expect(batches).toEqual([['A:offline']])
  })

  it('空变化不派发', () => {
    vi.useFakeTimers()
    const hub = createDeviceChangeHub(50)
    let count = 0
    hub.onPush(() => { count += 1 })
    hub.push({ changed: [], removed: [] })
    vi.advanceTimersByTime(50)
    expect(count).toBe(0)
  })

  it('dispose 后挂起批次被丢弃', () => {
    vi.useFakeTimers()
    const hub = createDeviceChangeHub(50)
    let count = 0
    hub.onPush(() => { count += 1 })
    hub.push({ changed: [{ serial: 'A', status: 'device', transport: 'usb', lastSeenAt: 1 }], removed: [] })
    hub.dispose()
    vi.advanceTimersByTime(100)
    expect(count).toBe(0)
  })
})
