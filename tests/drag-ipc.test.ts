import { describe, it, expect, vi } from 'vitest'
import { CH } from '../electron/ipc/channels'
import { registerHandlers, type HandlerDeps, type IpcMainLike } from '../electron/ipc/handlers'
import { DeviceManager } from '../electron/devices/manager'
import { E_ADB_NOT_FOUND, E_BAD_ARGS, E_DEVICE_OFFLINE, E_NO_SERIAL } from '../src/shared/errors'
import { DRAG_OUT_INPUT } from '../src/shared/api-contract'
import type { TransferSnapshot, TransferTask } from '../src/shared/transfer'
import { fakeBatch } from './fake-batch'
import { fakeDrag } from './fake-drag'
import { fakeLocalController } from './fake-local'
import { fakeSettings } from './fake-settings'

/*
 * 拖拽的 IPC 层（简报 C）。
 *
 * 只测 IPC 层该负责的东西：zod 校验、会话检查、adb 就绪检查、错误码收敛。
 * 真正的「下载到临时目录 → startDrag」在 tests/drag-out.test.ts（注入依赖）；
 * 渲染层流程在 tests/drag-flow.test.ts。
 *
 * 判据一律是**调用记录**（dragOut 被调用几次、收到什么），不是源码文本。
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

function task(): TransferTask {
  return {
    id: 'x', serial: 'S1', direction: 'pull', src: '/sdcard/a', dst: '/tmp/a',
    totalBytes: 1, doneBytes: 0, status: 'queued', attempt: 0, createdAt: 0,
  }
}

interface Harness {
  invoke: (ch: string, payload?: unknown) => Promise<unknown>
  drag: ReturnType<typeof fakeDrag>
}

function harness(over: Partial<HandlerDeps> = {}, options: { hasDevice?: boolean; adbPath?: string } = {}): Harness {
  const mgr = new DeviceManager()
  if (options.hasDevice !== false) mgr.applySnapshot([{ serial: 'S1', status: 'device', transport: 'usb' }])
  const drag = fakeDrag()
  const deps: HandlerDeps = {
    devices: mgr,
    adbPath: () => options.adbPath ?? 'C:/adb.exe',
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
    local: fakeLocalController('C:/Users/me'),
    pickRoot: async () => '',
    // R2-2：设置给空壳，只为满足 HandlerDeps（设置有专门的 tests/settings-*.test.ts）
    settings: fakeSettings(),
    pickDownloadDir: async () => '',
    batch: fakeBatch(),
    transfer: {
      enqueue: async () => task(),
      cancel: () => false,
      retry: () => false,
      get: () => undefined,
      snapshot: (): TransferSnapshot => ({ tasks: [], running: 0, queued: 0 }),
      clearFinished: () => 0,
    },
    drag,
    ...over,
  }
  const ipc = fakeIpc()
  registerHandlers(deps, ipc.ipc)
  return { invoke: ipc.invoke, drag }
}

describe('transfer:begin-drag-out 的入参校验', () => {
  it('合法入参被转成 dragOut 调用，入参逐字段一致', async () => {
    const h = harness()
    const result = await h.invoke(CH.TRANSFER_BEGIN_DRAG_OUT, {
      serial: 'S1', paths: ['/sdcard/a.txt', '/sdcard/b.txt'],
    })
    expect(result).toEqual({ ok: true, data: undefined })
    expect(h.drag.calls).toEqual([{ serial: 'S1', paths: ['/sdcard/a.txt', '/sdcard/b.txt'] }])
  })

  it('缺字段 / 空串 / 空数组 / 超上限 / 非数组一律 E_BAD_ARGS 且 dragOut 零调用', async () => {
    const h = harness()
    const bad = [
      undefined,
      null,
      'x',
      {},
      { serial: '', paths: ['/sdcard/a'] },
      { serial: 'S1', paths: [] },
      { serial: 'S1', paths: [''] },
      { serial: 'S1', paths: '/sdcard/a' },
      { serial: 1, paths: ['/sdcard/a'] },
      { serial: 'S1', paths: Array.from({ length: 101 }, (_, i) => '/sdcard/' + i) },
    ]
    for (const payload of bad) {
      const result = await h.invoke(CH.TRANSFER_BEGIN_DRAG_OUT, payload) as { ok: boolean; error?: string }
      expect(result.ok, String(JSON.stringify(payload)).slice(0, 60)).toBe(false)
      expect(result.error).toBe(E_BAD_ARGS)
    }
    expect(h.drag.calls).toHaveLength(0)
  })

  it('上限 100 条是允许的（边界值必须能过）', async () => {
    const h = harness()
    const paths = Array.from({ length: 100 }, (_, i) => '/sdcard/' + i)
    const result = await h.invoke(CH.TRANSFER_BEGIN_DRAG_OUT, { serial: 'S1', paths }) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(h.drag.calls).toHaveLength(1)
    expect(h.drag.calls[0].paths).toHaveLength(100)
  })

  it('schema 本身认得这个形状（单一事实源）', () => {
    expect(DRAG_OUT_INPUT.safeParse({ serial: 'S', paths: ['/a'] }).success).toBe(true)
    expect(DRAG_OUT_INPUT.safeParse({ serial: 'S', paths: [] }).success).toBe(false)
    expect(DRAG_OUT_INPUT.safeParse({ serial: 'S' }).success).toBe(false)
  })
})

describe('transfer:begin-drag-out 的前置检查', () => {
  it('未连接的 serial → E_NO_SERIAL，dragOut 零调用（不信渲染层给的 serial）', async () => {
    const h = harness()
    const result = await h.invoke(CH.TRANSFER_BEGIN_DRAG_OUT, { serial: 'GHOST', paths: ['/sdcard/a'] })
    expect(result).toEqual({ ok: false, error: E_NO_SERIAL })
    expect(h.drag.calls).toHaveLength(0)
  })

  it('adb 未就绪 → E_ADB_NOT_FOUND，dragOut 零调用', async () => {
    const h = harness({}, { adbPath: '' })
    const result = await h.invoke(CH.TRANSFER_BEGIN_DRAG_OUT, { serial: 'S1', paths: ['/sdcard/a'] })
    expect(result).toEqual({ ok: false, error: E_ADB_NOT_FOUND })
    expect(h.drag.calls).toHaveLength(0)
  })

  it('dragOut 返回失败码 → 原样透传成 { ok:false, error }', async () => {
    const h = harness({ drag: fakeDrag({ ok: false, code: E_DEVICE_OFFLINE }) })
    const result = await h.invoke(CH.TRANSFER_BEGIN_DRAG_OUT, { serial: 'S1', paths: ['/sdcard/a'] })
    expect(result).toEqual({ ok: false, error: E_DEVICE_OFFLINE })
  })

  it('dragOut 抛异常 → 收敛成错误码，不穿过 ipcMain.handle', async () => {
    const h = harness({
      drag: { dragOut: async () => { throw new Error(E_DEVICE_OFFLINE) } },
    })
    await expect(h.invoke(CH.TRANSFER_BEGIN_DRAG_OUT, { serial: 'S1', paths: ['/sdcard/a'] }))
      .resolves.toEqual({ ok: false, error: E_DEVICE_OFFLINE })
  })

  it('事件通道不得注册成 handle（推送只能走 webContents.send）', async () => {
    const registered = new Map<string, Handler>()
    const mgr = new DeviceManager()
    mgr.applySnapshot([{ serial: 'S1', status: 'device', transport: 'usb' }])
    registerHandlers(
      {
        devices: mgr,
        adbPath: () => 'C:/adb.exe',
        adbState: () => ({ state: 'ok', path: 'C:/adb.exe', version: '1', source: 'path' }),
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
        local: fakeLocalController('C:/'),
        pickRoot: async () => '',
        // R2-2：设置给空壳，只为满足 HandlerDeps（设置有专门的 tests/settings-*.test.ts）
        settings: fakeSettings(),
        pickDownloadDir: async () => '',
        batch: fakeBatch(),
        transfer: {
          enqueue: async () => task(), cancel: () => false, retry: () => false, get: () => undefined,
          snapshot: () => ({ tasks: [], running: 0, queued: 0 }), clearFinished: () => 0,
        },
        drag: fakeDrag(),
      },
      { handle: (ch, fn) => { registered.set(ch, fn) } },
    )
    expect(registered.has(CH.TRANSFER_DRAG_OUT_PROGRESS)).toBe(false)
    expect(registered.has(CH.TRANSFER_DRAG_OUT_FAILED)).toBe(false)
    expect(registered.has(CH.TRANSFER_BEGIN_DRAG_OUT)).toBe(true)
  })
})

/*
 * preload 那一层：getPathForFile 必须真的转发给注入的实现（而不是自己造一个空串）。
 * 判据是「调用记录」：假实现被调用一次、收到那个 File、返回值原样透出。
 * electron 在 node 测试环境下是 undefined，所以这里 mock 掉（与 ipc-handlers.test.ts 同一手法）。
 */
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: () => undefined },
  ipcRenderer: { invoke: async () => undefined, on: () => undefined, off: () => undefined },
  webUtils: { getPathForFile: () => '' },
}))

describe('preload：拖拽相关的 API 面真的转发下去', () => {
  it('getPathForFile 把 File 交给注入实现并原样返回路径', async () => {
    const { buildApi } = await import('../electron/preload')
    const seen: unknown[] = []
    const api = buildApi({
      invoke: async () => ({ ok: true, data: undefined }),
      on: () => undefined,
      off: () => undefined,
      getPathForFile: (file) => { seen.push(file); return 'C:/real/path.txt' },
    })
    const file = { name: 'fake.txt' }
    expect(api.transfer.getPathForFile(file)).toBe('C:/real/path.txt')
    expect(seen).toEqual([file])
  })

  it('getPathForFile 原样透出空串（不是磁盘文件时的约定）', async () => {
    const { buildApi } = await import('../electron/preload')
    const api = buildApi({
      invoke: async () => ({ ok: true, data: undefined }),
      on: () => undefined,
      off: () => undefined,
      getPathForFile: () => '',
    })
    expect(api.transfer.getPathForFile({ name: 'x' })).toBe('')
  })

  it('beginDragOut 用 TRANSFER_BEGIN_DRAG_OUT 通道并把载荷原样传下去', async () => {
    const { buildApi } = await import('../electron/preload')
    const calls: Array<{ channel: string; args: unknown[] }> = []
    const api = buildApi({
      invoke: async (channel, ...args) => {
        calls.push({ channel, args })
        return { ok: true, data: undefined }
      },
      on: () => undefined,
      off: () => undefined,
      getPathForFile: () => '',
    })
    const payload = { serial: 'S1', paths: ['/sdcard/a.txt'] }
    await api.transfer.beginDragOut(payload)
    expect(calls).toEqual([{ channel: 'transfer:begin-drag-out', args: [payload] }])
  })

  it('onDragOutProgress / onDragOutFailed 订阅的是各自的通道，退订调用 off', async () => {
    const { buildApi } = await import('../electron/preload')
    const onCalls: string[] = []
    const offCalls: string[] = []
    const api = buildApi({
      invoke: async () => ({ ok: true, data: undefined }),
      on: (channel) => { onCalls.push(channel) },
      off: (channel) => { offCalls.push(channel) },
      getPathForFile: () => '',
    })
    const unsubProgress = api.transfer.onDragOutProgress(() => undefined)
    const unsubFailed = api.transfer.onDragOutFailed(() => undefined)
    expect(onCalls).toEqual(['transfer:drag-out-progress', 'transfer:drag-out-failed'])
    unsubProgress()
    unsubFailed()
    expect(offCalls).toEqual(['transfer:drag-out-progress', 'transfer:drag-out-failed'])
  })
})
