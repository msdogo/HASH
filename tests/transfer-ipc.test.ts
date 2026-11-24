import { describe, it, expect } from 'vitest'
import { CH } from '../electron/ipc/channels'
import { registerHandlers, type HandlerDeps, type IpcMainLike } from '../electron/ipc/handlers'
import { DeviceManager } from '../electron/devices/manager'
import type { TransferSnapshot, TransferTask } from '../src/shared/transfer'
import { E_BAD_ARGS, E_NO_SERIAL } from '../src/shared/errors'
import { fakeBatch } from './fake-batch'
import { fakeCapture } from './fake-capture'
import { fakeDrag } from './fake-drag'
import { fakeLocalController } from './fake-local'
import { fakeSettings } from './fake-settings'

/*
 * 传输 IPC 层（任务 8）。
 *
 * 只测「IPC 层该负责的事」：zod 校验、会话检查、错误码收敛。
 * 真实调度与并发在 tests/transfer-manager.test.ts；真实 adb 在 tests/transfer-real.test.ts。
 */

type Handler = (event: unknown, payload?: unknown) => unknown

function fakeIpc(): { ipc: IpcMainLike; channels: string[]; invoke: (ch: string, payload?: unknown) => Promise<unknown> } {
  const handlers = new Map<string, Handler>()
  const channels: string[] = []
  return {
    channels,
    ipc: {
      handle: (channel, fn) => {
        if (handlers.has(channel)) throw new Error('duplicate handler: ' + channel)
        handlers.set(channel, fn)
        channels.push(channel)
      },
    },
    invoke: async (channel, payload) => {
      const fn = handlers.get(channel)
      if (fn === undefined) throw new Error('no handler: ' + channel)
      return await fn({}, payload)
    },
  }
}

function task(over: Partial<TransferTask> = {}): TransferTask {
  return {
    id: 'x1', serial: 'S1', direction: 'push', src: 'a', dst: '/sdcard/a',
    totalBytes: 10, doneBytes: 0, status: 'queued', attempt: 0, createdAt: 0, ...over,
  }
}

interface Harness { channels: string[]; invoke: (ch: string, payload?: unknown) => Promise<unknown>; enqueued: unknown[] }

function harness(over: Partial<HandlerDeps> = {}, hasDevice = true): Harness {
  const mgr = new DeviceManager()
  if (hasDevice) mgr.applySnapshot([{ serial: 'S1', status: 'device', transport: 'usb' }])
  const enqueued: unknown[] = []
  const tasks = new Map<string, TransferTask>()
  const snapshot = (): TransferSnapshot => ({ tasks: [...tasks.values()], running: 0, queued: 0 })
  const deps: HandlerDeps = {
    devices: mgr,
    adbPath: () => 'C:/adb.exe',
    adbState: () => ({ state: 'ok', path: 'C:/adb.exe', version: '1.0.41', source: 'path' }),
    clientFactory: (serial) => ({ serial }) as never,
    fs: { list: async () => ({ entries: [], degraded: false, unparsed: 0, usedFallback: false, exitCode: 0, tzOffsetMinutes: 0 }) },
    pickFiles: async () => ['C:/picked/a.bin'],
    // 本文件只测传输：文件操作与本地栏给最小空壳，只为满足 HandlerDeps
    ops: {
      mkdir: async () => ({ ok: true }),
      rename: async () => ({ ok: true }),
      removeFacts: async () => ({ count: 0, names: [], truncated: false, hasNonEmptyDir: false, blocked: [] }),
      remove: async () => ({ results: [] }),
      copy: async () => ({ results: [] }),
      move: async () => ({ results: [] }),
    },
    local: fakeLocalController('C:/Users/me'),
    pickRoot: async () => '',
    // R2-2：设置给空壳，只为满足 HandlerDeps（设置有专门的 tests/settings-*.test.ts）
    settings: fakeSettings(),
    pickDownloadDir: async () => '',
    // 本文件只测传输：批量给空壳，只为满足 HandlerDeps（批量有 tests/batch-*.test.ts）
    batch: fakeBatch(),
    capture: fakeCapture(),
    drag: fakeDrag(),
    transfer: {
      enqueue: async (input) => {
        enqueued.push(input)
        const created = task({ direction: input.direction, src: input.src })
        tasks.set(created.id, created)
        return created
      },
      cancel: (id) => { const found = tasks.get(id); if (found === undefined) return false; found.status = 'canceled'; return true },
      retry: (id) => { const found = tasks.get(id); if (found === undefined || found.status !== 'failed') return false; found.status = 'queued'; return true },
      get: (id) => tasks.get(id),
      snapshot,
      clearFinished: () => 0,
    },
    ...over,
  }
  const ipc = fakeIpc()
  registerHandlers(deps, ipc.ipc)
  return { channels: ipc.channels, invoke: ipc.invoke, enqueued }
}

describe('传输 IPC：入参校验', () => {
  it('合法入参被转成调度器调用', async () => {
    const h = harness()
    const result = await h.invoke(CH.TRANSFER_ENQUEUE, {
      serial: 'S1', direction: 'push', src: 'C:/local/a.bin', dstDir: '/sdcard/Download',
    }) as { ok: boolean; data: TransferTask }
    expect(result.ok).toBe(true)
    expect(h.enqueued).toEqual([{ serial: 'S1', direction: 'push', src: 'C:/local/a.bin', dstDir: '/sdcard/Download' }])
  })

  it('缺字段 / 空串 / 非法方向 / 非对象一律 E_BAD_ARGS', async () => {
    const h = harness()
    const bad = [
      undefined,
      null,
      'x',
      { serial: '', direction: 'push', src: 'a', dstDir: '/x' },
      { serial: 'S1', direction: 'move', src: 'a', dstDir: '/x' },
      { serial: 'S1', direction: 'push', src: '', dstDir: '/x' },
      { serial: 'S1', direction: 'push', src: 'a', dstDir: '' },
      { serial: 1, direction: 'push', src: 'a', dstDir: '/x' },
    ]
    for (const payload of bad) {
      const result = await h.invoke(CH.TRANSFER_ENQUEUE, payload) as { ok: boolean; error?: string }
      expect(result.ok, JSON.stringify(payload)).toBe(false)
      expect(result.error).toBe(E_BAD_ARGS)
    }
    expect(h.enqueued).toEqual([])
  })

  it('设备不在会话表里 → E_NO_SERIAL（渲染层不能凭字符串命令任意设备）', async () => {
    const h = harness({}, false)
    const result = await h.invoke(CH.TRANSFER_ENQUEUE, {
      serial: 'GHOST', direction: 'pull', src: '/sdcard/a', dstDir: 'C:/Downloads',
    }) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe(E_NO_SERIAL)
  })

  it('adb 还没定位到 → E_ADB_NOT_FOUND', async () => {
    const h = harness({ adbPath: () => '' })
    const result = await h.invoke(CH.TRANSFER_ENQUEUE, {
      serial: 'S1', direction: 'push', src: 'a', dstDir: '/x',
    }) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe('E_ADB_NOT_FOUND')
  })
})

describe('传输 IPC：取消 / 重试 / 快照 / 清除', () => {
  it('cancel 成功回任务，非法 id 回 E_BAD_ARGS，不存在回 E_NOT_FOUND', async () => {
    const h = harness()
    /* 【审查 M1】修前这里用了硬编码的 'task-x' 再断言 toBeDefined() ——
     * 那个断言对任何返回值都成立（包括 {ok:false}），等于没测。
     * 现在用 enqueue 真实返回的 id，并断言 canceled 状态。 */
    const enqueued = await h.invoke(CH.TRANSFER_ENQUEUE, {
      serial: 'S1', direction: 'push', src: 'C:/a.bin', dstDir: '/x',
    }) as { ok: boolean; data: TransferTask }
    expect(enqueued.ok).toBe(true)
    const ok = await h.invoke(CH.TRANSFER_CANCEL, { id: enqueued.data.id }) as {
      ok: boolean; data: TransferTask
    }
    expect(ok.ok).toBe(true)
    expect(ok.data.id).toBe(enqueued.data.id)
    expect(ok.data.status).toBe('canceled')
    expect((await h.invoke(CH.TRANSFER_CANCEL, {})) as { error: string }).toMatchObject({ ok: false, error: E_BAD_ARGS })
    expect((await h.invoke(CH.TRANSFER_CANCEL, { id: 'nope' })) as { error: string }).toMatchObject({ ok: false, error: 'E_NOT_FOUND' })
  })

  it('retry 在不可重试时回 E_BAD_ARGS，任务不存在回 E_NOT_FOUND', async () => {
    const h = harness()
    expect((await h.invoke(CH.TRANSFER_RETRY, { id: 'nope' })) as { error: string }).toMatchObject({ ok: false, error: 'E_BAD_ARGS' })
    expect((await h.invoke(CH.TRANSFER_RETRY, 'x')) as { error: string }).toMatchObject({ ok: false, error: E_BAD_ARGS })
  })

  it('list 返回快照；clear 忽略载荷并返回新快照', async () => {
    const h = harness()
    const list = await h.invoke(CH.TRANSFER_LIST) as { ok: boolean; data: TransferSnapshot }
    expect(list.ok).toBe(true)
    expect(list.data).toEqual({ tasks: [], running: 0, queued: 0 })
    const cleared = await h.invoke(CH.TRANSFER_CLEAR, { anything: 1 }) as { ok: boolean; data: TransferSnapshot }
    expect(cleared.ok).toBe(true)
  })

  it('pickFiles 把选择框结果原样返回（取消选择 = 空数组，不是错误）', async () => {
    const h = harness()
    expect(await h.invoke(CH.TRANSFER_PICK_FILES)).toEqual({ ok: true, data: ['C:/picked/a.bin'] })
    const cancelled = harness({ pickFiles: async () => [] })
    expect(await cancelled.invoke(CH.TRANSFER_PICK_FILES)).toEqual({ ok: true, data: [] })
  })
})
