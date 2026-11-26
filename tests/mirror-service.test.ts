import { describe, it, expect } from 'vitest'
import { createMirrorService, type SpawnScrcpy } from '../electron/mirror/service'
import type { ScrcpyHandle } from '../electron/mirror/runner'
import {
  E_ADB_NOT_FOUND,
  E_NO_SERIAL,
  E_SCRCPY_NOT_FOUND,
} from '../src/shared/errors'
import { SCRCPY_WINDOW_PREFIX } from '../src/shared/mirror'

/** 假 spawn：记录入参，能手动触发退出。 */
function fakeSpawn() {
  const calls: { scrcpyPath: string; adbPath: string; args: readonly string[] }[] = []
  const exits: Array<(code: number | null) => void> = []
  const killed: number[] = []
  let stderr = ''
  const spawn: SpawnScrcpy = (input) => {
    calls.push(input)
    const index = calls.length
    const handle: ScrcpyHandle = {
      pid: 1000 + index,
      onExit(cb) { exits.push(cb) },
      kill: async () => { killed.push(index) },
      stderrSoFar: () => stderr,
    }
    return handle
  }
  return {
    calls,
    killed,
    spawn,
    setStderr: (s: string) => { stderr = s },
    fireExit: (code: number | null) => { for (const cb of exits) cb(code) },
  }
}

const device = (serial: string, model?: string) => ({
  serial,
  status: 'device' as const,
  transport: 'usb' as const,
  lastSeenAt: 0,
  model,
})

function makeService(opts: {
  devices?: Record<string, ReturnType<typeof device> | undefined>
  adb?: string
  located?: { ok: true; path: string; version: string; source: 'bundled' | 'path' } | { ok: false; code: string }
  spawn?: SpawnScrcpy
  events?: unknown[]
  now?: number
}) {
  const sp = fakeSpawn()
  const events: unknown[] = opts.events ?? []
  const svc = createMirrorService({
    devices: { get: (s) => (opts.devices ?? { S1: device('S1') })[s] },
    adbPath: () => opts.adb ?? 'C:\\pt\\adb.exe',
    locate: async () => opts.located ?? { ok: true, path: 'C:\\scrcpy\\scrcpy.exe', version: '5.0.1', source: 'bundled' },
    spawn: opts.spawn ?? sp.spawn,
    emit: (e) => { events.push(e) },
    now: () => opts.now ?? 1_700_000_000_000,
  })
  return { svc, sp, events }
}

describe('mirror service', () => {
  it('启动时 env.ADB 用的就是传进去的 adb 绝对路径', async () => {
    const { svc, sp } = makeService({})
    await svc.start('S1')
    expect(sp.calls).toHaveLength(1)
    expect(sp.calls[0].adbPath).toBe('C:\\pt\\adb.exe')
  })

  it('scrcpy 参数里必须带 -s serial（红线）', async () => {
    const { svc, sp } = makeService({})
    await svc.start('S1')
    expect(sp.calls[0].args.slice(0, 2)).toEqual(['-s', 'S1'])
  })

  it('窗口标题带唯一 token 前缀（EnumWindows 靠它定位）', async () => {
    const { svc, sp } = makeService({})
    const session = await svc.start('S1')
    const titleArg = sp.calls[0].args.find((a) => a.startsWith('--window-title='))
    expect(titleArg).toBe('--window-title=' + SCRCPY_WINDOW_PREFIX + session.token)
  })

  it('同一台设备重复 start 不 spawn 第二个，返回同一会话', async () => {
    const { svc, sp } = makeService({})
    const a = await svc.start('S1')
    const b = await svc.start('S1')
    expect(sp.calls).toHaveLength(1)
    expect(a.token).toBe(b.token)
  })

  it('两台设备各自一个会话（多设备并行投屏）', async () => {
    const { svc, sp } = makeService({
      devices: { S1: device('S1'), S2: device('S2', 'Pixel') },
    })
    await svc.start('S1')
    await svc.start('S2')
    expect(sp.calls).toHaveLength(2)
    expect(svc.list()).toHaveLength(2)
    // 两个 token 必须不同，否则窗口互认
    const s = svc.list()
    expect(s[0].token).not.toBe(s[1].token)
  })

  it('stop 后会话消失且进程被 kill', async () => {
    const { svc, sp } = makeService({})
    await svc.start('S1')
    await svc.stop('S1')
    expect(svc.list()).toHaveLength(0)
    expect(sp.killed).toHaveLength(1)
  })

  it('stop 不存在的会话是安全空操作', async () => {
    const { svc } = makeService({})
    await expect(svc.stop('NOPE')).resolves.toBeUndefined()
  })

  it('adb 未定位 → E_ADB_NOT_FOUND，且不 spawn', async () => {
    const { svc, sp } = makeService({ adb: '' })
    await expect(svc.start('S1')).rejects.toThrow(E_ADB_NOT_FOUND)
    expect(sp.calls).toHaveLength(0)
  })

  it('设备不在会话表 → E_NO_SERIAL，且不 spawn', async () => {
    const { svc, sp } = makeService({ devices: {} })
    await expect(svc.start('S1')).rejects.toThrow(E_NO_SERIAL)
    expect(sp.calls).toHaveLength(0)
  })

  it('scrcpy 定位失败 → 抛该错误码，且不 spawn', async () => {
    const { svc, sp } = makeService({ located: { ok: false, code: E_SCRCPY_NOT_FOUND } })
    await expect(svc.start('S1')).rejects.toThrow(E_SCRCPY_NOT_FOUND)
    expect(sp.calls).toHaveLength(0)
  })

  it('started 事件带会话（界面据此开窗口）', async () => {
    const { svc, events } = makeService({})
    await svc.start('S1')
    expect(events).toHaveLength(1)
    expect((events[0] as { kind: string }).kind).toBe('started')
  })

  it('子进程正常退出（code 0）→ 清理会话 + exited 事件', async () => {
    const { svc, sp, events } = makeService({})
    await svc.start('S1')
    sp.fireExit(0)
    expect(svc.list()).toHaveLength(0)
    const kinds = events.map((e) => (e as { kind: string }).kind)
    expect(kinds).toContain('exited')
  })

  it('子进程异常退出（非 0）→ failed 事件并带分类后的错误码', async () => {
    const { svc, sp, events } = makeService({})
    await svc.start('S1')
    sp.setStderr('ERROR: Could not find any ADB device')
    sp.fireExit(1)
    expect(svc.list()).toHaveLength(0)
    const failed = events.find((e) => (e as { kind: string }).kind === 'failed') as { code: string } | undefined
    expect(failed?.code).toBe('E_DEVICE_OFFLINE')
  })

  it('主动 stop 之后子进程退出不再推事件（避免关窗口时闪一下错误）', async () => {
    const { svc, sp, events } = makeService({})
    await svc.start('S1')
    await svc.stop('S1')
    const before = events.length
    sp.fireExit(0)
    expect(events).toHaveLength(before)
  })

  it('设备被移除 → 自动结束会话', async () => {
    const { svc, sp } = makeService({})
    await svc.start('S1')
    await svc.onDeviceChanged({ removed: ['S1'] })
    expect(svc.list()).toHaveLength(0)
    expect(sp.killed).toHaveLength(1)
  })

  it('设备变离线（status 非 device）→ 自动结束会话', async () => {
    const { svc } = makeService({})
    await svc.start('S1')
    await svc.onDeviceChanged({ changed: [{ ...device('S1'), status: 'offline' as never }] })
    expect(svc.list()).toHaveLength(0)
  })

  it('设备仍在线 → 不动会话', async () => {
    const { svc } = makeService({})
    await svc.start('S1')
    await svc.onDeviceChanged({ changed: [device('S1')] })
    expect(svc.list()).toHaveLength(1)
  })

  it('没在投屏的设备掉线不推事件（避免噪声）', async () => {
    const { svc, events } = makeService({})
    await svc.onDeviceChanged({ removed: ['NOT_MIRRORING'] })
    expect(events).toHaveLength(0)
  })

  it('dispose 结束全部会话（before-quit 兜底）', async () => {
    const { svc, sp } = makeService({ devices: { S1: device('S1'), S2: device('S2') } })
    await svc.start('S1')
    await svc.start('S2')
    await svc.dispose()
    expect(svc.list()).toHaveLength(0)
    expect(sp.killed).toHaveLength(2)
  })

  it('list 按开始时间排序', async () => {
    let t = 1000
    const { svc } = makeService({ devices: { S2: device('S2'), S1: device('S1') } })
    const svc2 = createMirrorService({
      devices: { get: (s) => device(s) },
      adbPath: () => 'adb.exe',
      locate: async () => ({ ok: true, path: 's.exe', version: '5.0.1', source: 'bundled' }),
      spawn: fakeSpawn().spawn,
      emit: () => undefined,
      now: () => (t += 100),
    })
    await svc2.start('S2')
    await svc2.start('S1')
    expect(svc2.list().map((s) => s.serial)).toEqual(['S2', 'S1'])
  })

  it('会话里带型号标题（界面/窗口标题用）', async () => {
    const { svc } = makeService({ devices: { '9N9CN2G0012A3P': device('9N9CN2G0012A3P', 'DJI RC Plus 2') } })
    const s = await svc.start('9N9CN2G0012A3P')
    expect(s.title).toBe('DJI RC Plus 2 (2A3P)')
  })
})
