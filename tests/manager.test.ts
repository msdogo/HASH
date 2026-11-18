import { describe, it, expect, vi } from 'vitest'
import { DeviceManager } from '../electron/devices/manager'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('DeviceManager', () => {
  it('同 serial 重现复用会话', () => {
    const m = new DeviceManager()
    m.upsert({ serial: 'A', status: 'device', model: 'Pixel 7' })
    m.markLost('A')
    m.upsert({ serial: 'A', status: 'device' })
    expect(m.list()[0].model).toBe('Pixel 7')
    expect(m.list()[0].status).toBe('device')
  })

  it('超 30 分钟清理', () => {
    const m = new DeviceManager()
    m.upsert({ serial: 'B', status: 'device' })
    m.markLost('B')
    m.gc(Date.now() + 31 * 60 * 1000)
    expect(m.list()).toHaveLength(0)
  })

  it('未满 30 分钟不清理', () => {
    const m = new DeviceManager()
    m.upsert({ serial: 'B', status: 'device' })
    m.markLost('B')
    m.gc(Date.now() + 29 * 60 * 1000)
    expect(m.list()).toHaveLength(1)
    expect(m.list()[0].status).toBe('offline')
  })

  it('清理时发 removed 事件', () => {
    const m = new DeviceManager()
    const removed: string[] = []
    m.on('removed', (serial: string) => { removed.push(serial) })
    m.upsert({ serial: 'B', status: 'device' })
    m.markLost('B')
    m.gc(Date.now() + 31 * 60 * 1000)
    expect(removed).toEqual(['B'])
  })

  it('applySnapshot：消失的设备转 offline，重新出现复用会话', () => {
    const m = new DeviceManager()
    m.upsert({ serial: 'A', status: 'device', model: 'Pixel 7' })
    m.applySnapshot([])
    expect(m.list()[0].status).toBe('offline')
    m.applySnapshot([{ serial: 'A', status: 'device' }])
    expect(m.list()[0].status).toBe('device')
    expect(m.list()[0].model).toBe('Pixel 7')
  })

  it('applySnapshot：同一批里新增/消失同时处理', () => {
    const m = new DeviceManager()
    m.applySnapshot([
      { serial: 'A', status: 'device', transport: 'usb' },
      { serial: 'B', status: 'device', transport: 'usb' },
    ])
    m.applySnapshot([{ serial: 'B', status: 'device', transport: 'usb' }])
    expect(m.list().map((s) => s.serial).sort()).toEqual(['A', 'B'])
    expect(m.list().find((s) => s.serial === 'A')?.status).toBe('offline')
    expect(m.list().find((s) => s.serial === 'B')?.status).toBe('device')
  })

  it('get() 按 serial 取会话，未知名返回 undefined', () => {
    const m = new DeviceManager()
    m.upsert({ serial: 'A', status: 'device' })
    expect(m.get('A')?.serial).toBe('A')
    expect(m.get('NOPE')).toBeUndefined()
  })

  it('upsert 未知 serial 时 transport 默认 usb 且 lastSeenAt 被刷新', () => {
    const m = new DeviceManager()
    m.upsert({ serial: 'A', status: 'device' })
    expect(m.list()[0].transport).toBe('usb')
    const first = m.list()[0].lastSeenAt
    m.upsert({ serial: 'A', status: 'device' })
    expect(m.list()[0].lastSeenAt).toBeGreaterThanOrEqual(first)
  })

  it('gc 定时器可停止：stopGc 之后不再触发（裁决 4）', async () => {
    const m = new DeviceManager()
    let calls = 0
    vi.spyOn(m, 'gc').mockImplementation(() => { calls += 1 })
    m.startGc(10)
    await wait(60)
    expect(calls).toBeGreaterThan(0)
    m.stopGc()
    const frozen = calls
    await wait(80)
    expect(calls).toBe(frozen)
    expect(m.gcRunning).toBe(false)
  }, 10_000)

  it('startGc 重复调用不叠加定时器', async () => {
    const m = new DeviceManager()
    let calls = 0
    vi.spyOn(m, 'gc').mockImplementation(() => { calls += 1 })
    m.startGc(10)
    m.startGc(10)
    await wait(100)
    m.stopGc()
    expect(calls).toBeGreaterThan(0)
    expect(calls).toBeLessThanOrEqual(15)
  }, 10_000)
})
