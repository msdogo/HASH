import { describe, it, expect } from 'vitest'
import { CH } from '../electron/ipc/channels'
import { registerHandlers, type HandlerDeps, type IpcMainLike } from '../electron/ipc/handlers'
import { DeviceManager } from '../electron/devices/manager'
import { E_BAD_ARGS } from '../src/shared/errors'
import type { LocalFileStat } from '../src/shared/file-ops'
import { fakeBatch } from './fake-batch'
import { fakeCapture } from './fake-capture'
import { fakeDrag } from './fake-drag'
import { fakeLocalController } from './fake-local'
import { fakeSettings } from './fake-settings'

/*
 * R10：local:file-stat 的 IPC 层（zod 校验 + 参数透传 + 结果原样返回）。
 *
 * 本地实现的真读写（存在性 / 大小 / 非法名字 / 目录）在 tests/local-file-stat.test.ts。
 * 这里只回答一个问题：**渲染层传的两个字段有没有原样到达实现、结果有没有原样回来**。
 */

type Handler = (event: unknown, payload?: unknown) => unknown

function fakeIpc(): { ipc: IpcMainLike; invoke: (ch: string, payload?: unknown) => Promise<unknown> } {
  const handlers = new Map<string, Handler>()
  return {
    ipc: {
      handle: (channel, fn) => {
        if (handlers.has(channel)) throw new Error('duplicate handler: ' + channel)
        handlers.set(channel, fn)
      },
    },
    invoke: async (channel, payload) => {
      const fn = handlers.get(channel)
      if (fn === undefined) throw new Error('no handler: ' + channel)
      return await fn({}, payload)
    },
  }
}

interface Harness {
  invoke: (ch: string, payload?: unknown) => Promise<unknown>
  calls: Array<{ dir: string; name: string }>
}

function harness(answer: LocalFileStat = { exists: false }): Harness {
  const calls: Array<{ dir: string; name: string }> = []
  const mgr = new DeviceManager()
  mgr.applySnapshot([{ serial: 'S1', status: 'device', transport: 'usb' }])
  const deps: HandlerDeps = {
    devices: mgr,
    adbPath: () => 'C:/adb.exe',
    adbState: () => ({ state: 'ok', path: 'C:/adb.exe', version: '1.0.41', source: 'path' }),
    clientFactory: (serial) => ({ serial }) as never,
    fs: { list: async () => ({ entries: [], degraded: false, unparsed: 0, usedFallback: false, exitCode: 0, tzOffsetMinutes: 0 }) },
    pickFiles: async () => [],
    ops: {
      mkdir: async () => ({ ok: true }),
      rename: async () => ({ ok: true }),
      removeFacts: async () => ({ count: 0, names: [], truncated: false, hasNonEmptyDir: false, blocked: [] }),
      remove: async () => ({ results: [] }),
      copy: async () => ({ results: [] }),
      move: async () => ({ results: [] }),
    },
    local: fakeLocalController('C:/Users/me', {
      fileStat: async (dir, name) => {
        calls.push({ dir, name })
        return answer
      },
    }),
    pickRoot: async () => '',
    settings: fakeSettings(),
    pickDownloadDir: async () => '',
    batch: fakeBatch(),
    capture: fakeCapture(),
    drag: fakeDrag(),
    transfer: {
      enqueue: async () => { throw new Error('unused') },
      cancel: () => false,
      retry: () => false,
      get: () => undefined,
      snapshot: () => ({ tasks: [], running: 0, queued: 0 }),
      clearFinished: () => 0,
    },
  }
  const ipc = fakeIpc()
  registerHandlers(deps, ipc.ipc)
  return { invoke: ipc.invoke, calls }
}

describe('R10 local:file-stat 的 IPC 层', () => {
  it('通道已登记且拿得到结果（参数逐字透传到实现）', async () => {
    const h = harness({ exists: true, size: 4096 })
    const result = await h.invoke(CH.LOCAL_FILE_STAT, { dir: 'C:/Users/me/Downloads', name: 'a.jpg' }) as { ok: boolean; data?: LocalFileStat }
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ exists: true, size: 4096 })
    expect(h.calls).toEqual([{ dir: 'C:/Users/me/Downloads', name: 'a.jpg' }])
  })

  it('「不存在」原样返回（不是错误、不是 ok:false）', async () => {
    const h = harness({ exists: false })
    const result = await h.invoke(CH.LOCAL_FILE_STAT, { dir: 'C:/d', name: 'a.jpg' }) as { ok: boolean; data?: LocalFileStat }
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ exists: false })
  })

  it('入参不合法 → E_BAD_ARGS，且实现零调用', async () => {
    const h = harness()
    const bad = [
      undefined,
      null,
      'x',
      {},
      { dir: '', name: 'a.jpg' },
      { dir: 'C:/d', name: '' },
      { dir: 'C:/d' },
      { name: 'a.jpg' },
      { dir: 1, name: 'a.jpg' },
    ]
    for (const payload of bad) {
      const result = await h.invoke(CH.LOCAL_FILE_STAT, payload) as { ok: boolean; error?: string }
      expect(result.ok, JSON.stringify(payload)).toBe(false)
      expect(result.error).toBe(E_BAD_ARGS)
    }
    expect(h.calls).toEqual([])
  })

  it('实现抛错 → 收敛成错误码（绝不把异常穿过 ipcMain.handle）', async () => {
    const mgr = new DeviceManager()
    mgr.applySnapshot([{ serial: 'S1', status: 'device', transport: 'usb' }])
    const ipc = fakeIpc()
    const deps = {
      devices: mgr,
      adbPath: () => 'C:/adb.exe',
      adbState: () => ({ state: 'ok', path: 'C:/adb.exe', version: '1.0.41', source: 'path' }),
      clientFactory: (serial: string) => ({ serial }) as never,
      fs: { list: async () => ({ entries: [], degraded: false, unparsed: 0, usedFallback: false, exitCode: 0, tzOffsetMinutes: 0 }) },
      pickFiles: async () => [],
      ops: {
        mkdir: async () => ({ ok: true }),
        rename: async () => ({ ok: true }),
        removeFacts: async () => ({ count: 0, names: [], truncated: false, hasNonEmptyDir: false, blocked: [] }),
        remove: async () => ({ results: [] }),
        copy: async () => ({ results: [] }),
        move: async () => ({ results: [] }),
      },
      local: fakeLocalController('C:/Users/me', {
        fileStat: async () => { throw new Error('E_NO_PERMISSION') },
      }),
      pickRoot: async () => '',
      settings: fakeSettings(),
      pickDownloadDir: async () => '',
      batch: fakeBatch(),
    capture: fakeCapture(),
      drag: fakeDrag(),
      transfer: {
        enqueue: async () => { throw new Error('unused') },
        cancel: () => false,
        retry: () => false,
        get: () => undefined,
        snapshot: () => ({ tasks: [], running: 0, queued: 0 }),
        clearFinished: () => 0,
      },
    } as HandlerDeps
    registerHandlers(deps, ipc.ipc)
    const result = await ipc.invoke(CH.LOCAL_FILE_STAT, { dir: 'C:/d', name: 'a.jpg' }) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe('E_NO_PERMISSION')
  })
})
