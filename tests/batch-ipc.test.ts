import { describe, it, expect } from 'vitest'
import { CH } from '../electron/ipc/channels'
import { registerHandlers, type BatchController, type HandlerDeps, type IpcMainLike } from '../electron/ipc/handlers'
import { DeviceManager } from '../electron/devices/manager'
import type { BatchRunData } from '../src/shared/batch'
import { E_ADB_NOT_FOUND, E_BAD_ARGS } from '../src/shared/errors'

/*
 * 批量 IPC 层（任务 10）。
 *
 * 只测「IPC 层该负责的事」：zod 校验、会话检查（R6）、错误码收敛、逐台结果透传。
 * 四个动作的业务行为在 tests/batch-service.test.ts；并发与顺序在 batch-runner.test.ts。
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

/** 记录调用的假批量控制器。 */
function fakeBatch(result: BatchRunData = { results: [] }): BatchController & {
  calls: Array<{ method: string; args: unknown[] }>
} {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const record = (method: string, args: unknown[]): void => { calls.push({ method, args }) }
  return {
    calls,
    screenshot: async (input, dstDir) => { record('screenshot', [input, dstDir]); return result },
    install: async (input, apkPath) => { record('install', [input, apkPath]); return result },
    push: async (input) => { record('push', [input]); return result },
    shell: async (input, command) => { record('shell', [input, command]); return result },
    pickScreenshotDir: async () => 'C:/shots',
    pickApk: async () => 'C:/pkg/app.apk',
  }
}

function harness(options: { adbPath?: string; hasDevices?: boolean; over?: Partial<HandlerDeps> } = {}): {
  invoke: (ch: string, payload?: unknown) => Promise<unknown>
  batch: ReturnType<typeof fakeBatch>
  calls: () => Array<{ method: string; args: unknown[] }>
} {
  const mgr = new DeviceManager()
  if (options.hasDevices !== false) {
    mgr.applySnapshot([
      { serial: 'S1', status: 'device', transport: 'usb' },
      { serial: 'S2', status: 'device', transport: 'usb' },
    ])
  }
  const batch = fakeBatch({ results: [{ serial: 'S1', ok: true }] })
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
    local: { list: async () => ({ cwd: 'C:/Users/me', parent: null, items: [], root: 'C:/Users/me' }) },
    pickRoot: async () => '',
    transfer: {
      enqueue: async () => { throw new Error('not used') },
      cancel: () => false,
      retry: () => false,
      get: () => undefined,
      snapshot: () => ({ tasks: [], running: 0, queued: 0 }),
      clearFinished: () => 0,
    },
    batch,
    ...options.over,
  }
  const ipc = fakeIpc()
  registerHandlers(deps, ipc.ipc)
  return { invoke: ipc.invoke, batch, calls: () => batch.calls }
}

describe('批量通道登记', () => {
  it('四个动作 + 两个选择框的通道值逐字一致', () => {
    expect(CH.BATCH_SCREENSHOT).toBe('batch:screenshot')
    expect(CH.BATCH_INSTALL).toBe('batch:install')
    expect(CH.BATCH_PUSH).toBe('batch:push')
    expect(CH.BATCH_SHELL).toBe('batch:shell')
    expect(CH.BATCH_PICK_DIRECTORY).toBe('batch:pick-directory')
    expect(CH.BATCH_PICK_APK).toBe('batch:pick-apk')
  })
})

describe('入参校验（zod）', () => {
  it.each([
    ['缺 serials', { }],
    ['serials 是空数组', { serials: [] }],
    ['serials 含空串', { serials: [''] }],
    ['serials 不是数组', { serials: 'S1' }],
    ['载荷是 null', null],
    ['载荷缺失', undefined],
  ])('batch:shell 入参非法（%s）→ E_BAD_ARGS 且不调用服务', async (_label, payload) => {
    const h = harness()
    const result = await h.invoke(CH.BATCH_SHELL, payload)
    expect(result).toEqual({ ok: false, error: E_BAD_ARGS })
    expect(h.calls()).toEqual([])
  })

  it('serials 超过 16 台被拒（批量是给人用的）', async () => {
    const h = harness()
    const serials = Array.from({ length: 17 }, (_, i) => 'S1')
    const result = await h.invoke(CH.BATCH_SHELL, { serials, command: 'ls' })
    expect(result).toEqual({ ok: false, error: E_BAD_ARGS })
    expect(h.calls()).toEqual([])
  })

  it('batch:install 缺 apkPath → E_BAD_ARGS', async () => {
    const h = harness()
    expect(await h.invoke(CH.BATCH_INSTALL, { serials: ['S1'] })).toEqual({ ok: false, error: E_BAD_ARGS })
    expect(h.calls()).toEqual([])
  })

  it('batch:push 的 files 为空 → E_BAD_ARGS', async () => {
    const h = harness()
    const result = await h.invoke(CH.BATCH_PUSH, { serials: ['S1'], files: [], dstDir: '/sdcard' })
    expect(result).toEqual({ ok: false, error: E_BAD_ARGS })
    expect(h.calls()).toEqual([])
  })

  it('batch:shell 的命令超过 4096 字符 → E_BAD_ARGS', async () => {
    const h = harness()
    const result = await h.invoke(CH.BATCH_SHELL, { serials: ['S1'], command: 'x'.repeat(4097) })
    expect(result).toEqual({ ok: false, error: E_BAD_ARGS })
    expect(h.calls()).toEqual([])
  })
})

describe('R6：serial 必须是主进程已知的会话', () => {
  it('渲染层传来未连接过的 serial → 整批 E_BAD_ARGS，且不调用服务（零命令）', async () => {
    const h = harness()
    const result = await h.invoke(CH.BATCH_SHELL, { serials: ['S1', 'NOT-CONNECTED'], command: 'ls' })
    expect(result).toEqual({ ok: false, error: E_BAD_ARGS })
    expect(h.calls()).toEqual([])
  })

  it('全部 serial 都已知时放行（在线与离线混排也放行：离线由服务层逐台跳过）', async () => {
    const h = harness()
    const result = await h.invoke(CH.BATCH_SHELL, { serials: ['S1', 'S2'], command: 'ls' })
    expect(result).toEqual({ ok: true, data: { results: [{ serial: 'S1', ok: true }] } })
    expect(h.calls()).toEqual([{ method: 'shell', args: [{ serials: ['S1', 'S2'] }, 'ls'] }])
  })
})

describe('错误码收敛', () => {
  it('adb 未定位到 → E_ADB_NOT_FOUND 且不调用服务', async () => {
    const h = harness({ adbPath: '' })
    for (const channel of [CH.BATCH_SCREENSHOT, CH.BATCH_SHELL]) {
      const payload = channel === CH.BATCH_SHELL ? { serials: ['S1'], command: 'ls' } : { serials: ['S1'], dstDir: 'C:/shots' }
      expect(await h.invoke(channel, payload)).toEqual({ ok: false, error: E_ADB_NOT_FOUND })
    }
    expect(h.calls()).toEqual([])
  })

  it('服务抛错 → 收敛成错误码（不穿越 ipcMain.handle 变成字符串异常）', async () => {
    const batch = fakeBatch()
    batch.shell = async () => { throw new Error('E_OP_FAILED') }
    const h = harness({ over: { batch } })
    expect(await h.invoke(CH.BATCH_SHELL, { serials: ['S1'], command: 'ls' }))
      .toEqual({ ok: false, error: 'E_OP_FAILED' })
  })
})

describe('四个动作的透传', () => {
  it('screenshot：serials 与 dstDir 都交给服务（I5：目录来自选择框）', async () => {
    const h = harness()
    await h.invoke(CH.BATCH_SCREENSHOT, { serials: ['S1', 'S2'], dstDir: 'C:/shots' })
    expect(h.calls()).toEqual([
      { method: 'screenshot', args: [{ serials: ['S1', 'S2'] }, 'C:/shots'] },
    ])
  })

  it('install：apkPath 原样透传（路径校验在服务层）', async () => {
    const h = harness()
    await h.invoke(CH.BATCH_INSTALL, { serials: ['S1'], apkPath: 'C:/pkg/app.apk' })
    expect(h.calls()).toEqual([{ method: 'install', args: [{ serials: ['S1'] }, 'C:/pkg/app.apk'] }])
  })

  it('push：files 与 dstDir 原样透传', async () => {
    const h = harness()
    await h.invoke(CH.BATCH_PUSH, { serials: ['S1'], files: ['C:/a.txt'], dstDir: '/sdcard/Download' })
    expect(h.calls()).toEqual([
      { method: 'push', args: [{ serials: ['S1'], files: ['C:/a.txt'], dstDir: '/sdcard/Download' }] },
    ])
  })

  it('shell：command 原样透传（逐字节）', async () => {
    const h = harness()
    const command = "ls -l '/sdcard/中文 目录'"
    await h.invoke(CH.BATCH_SHELL, { serials: ['S1'], command })
    expect(h.calls()).toEqual([{ method: 'shell', args: [{ serials: ['S1'] }, command] }])
  })

  it('两个选择框：取消时返回空串（不是错误）', async () => {
    const batch = fakeBatch()
    batch.pickScreenshotDir = async () => ''
    batch.pickApk = async () => ''
    const h = harness({ over: { batch } })
    expect(await h.invoke(CH.BATCH_PICK_DIRECTORY)).toEqual({ ok: true, data: '' })
    expect(await h.invoke(CH.BATCH_PICK_APK)).toEqual({ ok: true, data: '' })
  })

  it('选择框正常返回路径', async () => {
    const h = harness()
    expect(await h.invoke(CH.BATCH_PICK_DIRECTORY)).toEqual({ ok: true, data: 'C:/shots' })
    expect(await h.invoke(CH.BATCH_PICK_APK)).toEqual({ ok: true, data: 'C:/pkg/app.apk' })
  })
})
