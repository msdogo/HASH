import { describe, it, expect } from 'vitest'
import { DeviceTracker } from '../electron/adb/track'
import { createAdbProbe, createAdbTracking, sha256 } from '../electron/app/sessions'

/* ============ 可控假子进程：所有 spawn 都走注入，不产生真子进程 ============ */

/**
 * 「永远不吐数据」的假子进程：让跟踪器停在 track 模式，便于观察 stop() 的回收动作。
 * pid 故意留空 —— killTree 会走 child.kill()（no-op），不会 spawn taskkill。
 */
function silentChild(): { pid?: number; killed: boolean; stdout: { on: () => void; resume: () => void }; stderr: { resume: () => void }; on: () => void; kill: () => void } {
  const child = {
    pid: undefined as number | undefined,
    killed: false,
    stdout: { on: () => {}, resume: () => {} },
    stderr: { resume: () => {} },
    on: () => {},
    kill: () => { child.killed = true },
  }
  return child
}

describe('DeviceTracker 生产接线（裁决 1：启动即实例化）', () => {
  it('start 之后 tracker 是真实实例、处于 track 模式、manager 的 gc 也起来了', () => {
    const spawned: unknown[] = []
    const t = createAdbTracking({
      adbPath: 'C:/platform-tools/adb.exe',
      spawnTrack: () => { const c = silentChild(); spawned.push(c); return c as never },
    })
    t.tracker.start()
    expect(t.tracker).toBeInstanceOf(DeviceTracker)
    expect(spawned).toHaveLength(1)
    expect(t.tracker.mode).toBe('track')
    expect(t.mgr.gcRunning).toBe(true)
    t.stop()
  })

  it('stop 之后 tracker 停跑、gc 停、子进程被回收（退出清理真的执行了）', () => {
    const spawned: Array<ReturnType<typeof silentChild>> = []
    const t = createAdbTracking({
      adbPath: 'C:/platform-tools/adb.exe',
      spawnTrack: () => { const c = silentChild(); spawned.push(c); return c as never },
    })
    t.tracker.start()
    expect(t.mgr.gcRunning).toBe(true)
    expect(spawned[0].killed).toBe(false)
    t.stop()
    expect(t.tracker.mode).toBe('idle')
    expect(t.mgr.gcRunning).toBe(false)
    expect(spawned[0].killed).toBe(true)
    t.stop() // 幂等：重复 stop 不抛错
  })

  it('重复 start 不会叠加第二个 tracker（单例语义）', () => {
    let spawnCount = 0
    const t = createAdbTracking({
      adbPath: 'C:/platform-tools/adb.exe',
      spawnTrack: () => { spawnCount += 1; return silentChild() as never },
    })
    t.tracker.start()
    t.tracker.start()
    t.tracker.start()
    expect(spawnCount).toBe(1)
    t.stop()
  })

  it('stop 之后设备变化不再派发（退出后不得再往窗口推事件）', () => {
    const t = createAdbTracking({ adbPath: 'C:/adb.exe', spawnTrack: () => silentChild() as never })
    const seen: number[] = []
    t.onDevicesChanged((batch) => { seen.push(batch.changed.length) })
    t.tracker.start()
    t.mgr.upsert({ serial: 'A', status: 'device' })
    t.flushChanges()
    expect(seen).toEqual([1])
    t.stop()
    t.mgr.upsert({ serial: 'B', status: 'device' })
    t.flushChanges()
    expect(seen).toEqual([1])
  })

  it('onDevicesChanged 去重：同一状态重复 upsert 不再派发', () => {
    const t = createAdbTracking({ adbPath: 'C:/adb.exe', spawnTrack: () => silentChild() as never })
    const seen: string[][] = []
    t.onDevicesChanged((batch) => { seen.push(batch.changed.map((d) => d.serial)) })
    t.mgr.upsert({ serial: 'A', status: 'device' })
    t.mgr.upsert({ serial: 'A', status: 'device' })
    t.mgr.upsert({ serial: 'A', status: 'device' })
    t.flushChanges()
    expect(seen).toEqual([['A']])
    t.stop()
  })

  it('onDevicesChanged 的退订函数生效', () => {
    const t = createAdbTracking({ adbPath: 'C:/adb.exe', spawnTrack: () => silentChild() as never })
    let count = 0
    const off = t.onDevicesChanged(() => { count += 1 })
    t.mgr.upsert({ serial: 'A', status: 'device' })
    t.flushChanges()
    off()
    t.mgr.upsert({ serial: 'B', status: 'device' })
    t.flushChanges()
    expect(count).toBe(1)
    t.stop()
  })
})

describe('adb 自检（启动时不阻塞窗口）', () => {
  it('resolveAdb 成功时报 ok 并带上路径/版本/来源', async () => {
    const probe = createAdbProbe({
      resolve: async () => ({
        resolved: { path: 'C:/platform-tools/adb.exe', source: 'path', version: '1.0.41', build: '35.0.2' },
        attempts: [{ path: 'C:/platform-tools/adb.exe', source: 'path', ok: true }],
      }),
    })
    const state = await probe()
    expect(state).toMatchObject({
      state: 'ok',
      path: 'C:/platform-tools/adb.exe',
      version: '1.0.41',
      source: 'path',
    })
  })

  it('resolveAdb 失败时报 error + 错误码 + 候选尝试记录', async () => {
    const probe = createAdbProbe({
      resolve: async () => ({
        resolved: null,
        attempts: [
          { path: 'C:/a/adb.cmd', source: 'custom', ok: false, code: 'E_ADB_SHIM_UNSUPPORTED' },
          { path: 'adb', source: 'path', ok: false, code: 'E_ADB_NOT_FOUND' },
        ],
      }),
    })
    const state = await probe()
    expect(state.state).toBe('error')
    if (state.state !== 'error') throw new Error('unreachable')
    // 取「最后一个」失败原因：按 custom > env > bundled > path 探测，path 是最终兜底，
    // 它的结论最能解释「为什么一个都用不了」。
    expect(state.code).toBe('E_ADB_NOT_FOUND')
    expect(state.attempts).toHaveLength(2)
    expect(state.attempts[0].code).toBe('E_ADB_SHIM_UNSUPPORTED')
    expect(state.attempts[0].source).toBe('custom')
  })

  it('resolve 抛异常时也必须返回 error，不得把异常抛给 main', async () => {
    const probe = createAdbProbe({
      resolve: async () => { throw new Error('E_ADB_NOT_EXECUTABLE') },
    })
    const state = await probe()
    expect(state).toMatchObject({ state: 'error', code: 'E_ADB_NOT_EXECUTABLE', attempts: [] })
  })

  it('候选输入：custom/env/resourcePath 原样传给 resolveAdb', async () => {
    let seen: unknown
    const probe = createAdbProbe({
      resourcePath: 'C:/app/resources',
      custom: 'D:/my/adb.exe',
      env: 'E:/env/adb.exe',
      resolve: async (input) => { seen = input; return { resolved: null, attempts: [] } },
    })
    await probe()
    expect(seen).toMatchObject({
      custom: 'D:/my/adb.exe',
      env: 'E:/env/adb.exe',
      resourcesPath: 'C:/app/resources',
    })
  })

  it('没有 resolved 也没有 attempts 时给出 E_ADB_NOT_FOUND（不得返回空错误码）', async () => {
    const probe = createAdbProbe({
      resolve: async () => ({ resolved: null, attempts: [] }),
    })
    expect(await probe()).toMatchObject({ state: 'error', code: 'E_ADB_NOT_FOUND' })
  })
})

describe('会话装配', () => {
  it('clientFactory 造出的 client 带正确 serial（-s serial 的来源）', () => {
    const t = createAdbTracking({ adbPath: 'C:/adb.exe', spawnTrack: () => silentChild() as never })
    const client = t.clientFactory('9N9CN2G0012A6F')
    expect(client.serial).toBe('9N9CN2G0012A6F')
    expect(client.buildArgs(['shell', 'ls'])).toEqual(['-s', '9N9CN2G0012A6F', 'shell', 'ls'])
    expect(t.mgr.list()).toEqual([])
    t.stop()
  })

  it('sha256 用于 adb 路径变更判定（相同输入相同输出，不同输入不同）', () => {
    expect(sha256('C:/adb.exe')).toBe(sha256('C:/adb.exe'))
    expect(sha256('C:/adb.exe')).not.toBe(sha256('C:/adb2.exe'))
    expect(sha256('C:/adb.exe')).toMatch(/^[0-9a-f]{64}$/)
  })
})