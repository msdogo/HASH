import { describe, it, expect, vi, afterEach } from 'vitest'
import { DeviceTracker } from '../electron/adb/track'
import { DeviceManager } from '../electron/devices/manager'

/*
 * 裁决 9：设备栏必须显示型号。
 *
 * 真机现场发现（2026-11-18，CDP 抓渲染层 DOM）：
 *   track-devices 的负载是 "serial	state"，【不含 model】；
 *   model 只出现在 adb devices -l 里。
 * 而生产路径优先走 track-devices —— 于是设备栏显示的是 fallback 的 serial 后 4 位（"2A6F"），
 * 型号永远出不来。必须在新设备出现时补一次 devices -l 拿型号。
 */

/** 不吐数据的假子进程（让跟踪器停在 track 模式）。 */
function silentChild(): unknown {
  return {
    pid: undefined,
    stdout: { on: () => {}, resume: () => {} },
    stderr: { resume: () => {} },
    on: () => {},
    kill: () => {},
  }
}

const DEVICES_L = [
  'List of devices attached',
  '9N9CN2G0012A6F         device product:rc701 model:DJI_RC_PLUS_2 device:rc701 transport_id:1',
  '',
].join('\r\n')

afterEach(() => { vi.useRealTimers() })

describe('track 模式下补型号（裁决 9 的生产路径）', () => {
  it('track-devices 报到新设备后，补一次 adb devices -l 拿到 model', async () => {
    const mgr = new DeviceManager()
    const pollDevices = vi.fn(async () => DEVICES_L)
    const tracker = new DeviceTracker({
      adbPath: 'C:/adb.exe',
      manager: mgr,
      spawnTrack: () => silentChild() as never,
      pollDevices,
    })
    tracker.start()
    expect(tracker.mode).toBe('track')

    // 模拟真实 track-devices 帧：只有 serial + state，没有 model
    const child = (tracker as unknown as { child: { stdout: { on: (e: string, f: (c: Buffer) => void) => void } } }).child
    void child
    // 直接走解码入口（等价于收到一帧）
    const apply = (tracker as unknown as { applyPayload: (p: string) => void }).applyPayload.bind(tracker)
    apply('9N9CN2G0012A6F\tdevice\n')

    // 设备先被记下来（型号暂时缺失）
    expect(mgr.get('9N9CN2G0012A6F')?.status).toBe('device')

    // 补型号是异步的：等它跑完
    await vi.waitFor(() => {
      expect(mgr.get('9N9CN2G0012A6F')?.model).toBe('DJI RC PLUS 2')
    })
    expect(pollDevices).toHaveBeenCalledTimes(1)
    tracker.stop()
  })

  it('已知设备重复上报不会反复补型号（否则每帧都多跑一条 adb 命令）', async () => {
    const mgr = new DeviceManager()
    const pollDevices = vi.fn(async () => DEVICES_L)
    const tracker = new DeviceTracker({
      adbPath: 'C:/adb.exe',
      manager: mgr,
      spawnTrack: () => silentChild() as never,
      pollDevices,
    })
    tracker.start()
    const apply = (tracker as unknown as { applyPayload: (p: string) => void }).applyPayload.bind(tracker)
    apply('9N9CN2G0012A6F\tdevice\n')
    await vi.waitFor(() => { expect(mgr.get('9N9CN2G0012A6F')?.model).toBe('DJI RC PLUS 2') })
    apply('9N9CN2G0012A6F\tdevice\n')
    apply('9N9CN2G0012A6F\tdevice\n')
    await new Promise((r) => setTimeout(r, 30))
    expect(pollDevices).toHaveBeenCalledTimes(1)
    tracker.stop()
  })

  it('补型号失败不影响设备发现（track 流仍然可用）', async () => {
    const mgr = new DeviceManager()
    const tracker = new DeviceTracker({
      adbPath: 'C:/adb.exe',
      manager: mgr,
      spawnTrack: () => silentChild() as never,
      pollDevices: async () => { throw new Error('boom') },
    })
    tracker.start()
    const apply = (tracker as unknown as { applyPayload: (p: string) => void }).applyPayload.bind(tracker)
    apply('9N9CN2G0012A6F\tdevice\n')
    await new Promise((r) => setTimeout(r, 30))
    expect(mgr.get('9N9CN2G0012A6F')?.status).toBe('device')
    expect(mgr.get('9N9CN2G0012A6F')?.model).toBeUndefined()
    expect(tracker.mode).toBe('track')
    tracker.stop()
  })

  it('拔出再插回：会话里已有的型号不丢，也不再重复补（型号只在设备首次出现时拉一次）', async () => {
    const mgr = new DeviceManager()
    const pollDevices = vi.fn(async () => DEVICES_L)
    const tracker = new DeviceTracker({
      adbPath: 'C:/adb.exe',
      manager: mgr,
      spawnTrack: () => silentChild() as never,
      pollDevices,
    })
    tracker.start()
    const apply = (tracker as unknown as { applyPayload: (p: string) => void }).applyPayload.bind(tracker)
    apply('9N9CN2G0012A6F\tdevice\n')
    await vi.waitFor(() => { expect(mgr.get('9N9CN2G0012A6F')?.model).toBe('DJI RC PLUS 2') })

    apply('')  // 空帧 = 设备全没了（会话保留 30 分钟，型号也在）
    apply('9N9CN2G0012A6F\tdevice\n')  // 同一台重插回来
    expect(mgr.get('9N9CN2G0012A6F')?.model).toBe('DJI RC PLUS 2')
    await new Promise((r) => setTimeout(r, 30))
    // 已经有型号了，不需要再跑一次 adb devices
    expect(pollDevices).toHaveBeenCalledTimes(1)
    tracker.stop()
  })

  it('会话被 gc 清掉后同一 serial 再出现，会重新补型号', async () => {
    const mgr = new DeviceManager()
    const pollDevices = vi.fn(async () => DEVICES_L)
    const tracker = new DeviceTracker({
      adbPath: 'C:/adb.exe',
      manager: mgr,
      spawnTrack: () => silentChild() as never,
      pollDevices,
    })
    tracker.start()
    const apply = (tracker as unknown as { applyPayload: (p: string) => void }).applyPayload.bind(tracker)
    apply('9N9CN2G0012A6F\tdevice\n')
    await vi.waitFor(() => { expect(pollDevices).toHaveBeenCalledTimes(1) })

    apply('')  // 设备消失 → offline
    mgr.gc(Date.now() + 31 * 60 * 1000)  // 超 30 分钟被清理
    expect(mgr.get('9N9CN2G0012A6F')).toBeUndefined()

    apply('9N9CN2G0012A6F\tdevice\n')  // 同一台重新出现
    await vi.waitFor(() => { expect(pollDevices).toHaveBeenCalledTimes(2) })
    expect(mgr.get('9N9CN2G0012A6F')?.model).toBe('DJI RC PLUS 2')
    tracker.stop()
  })
})
