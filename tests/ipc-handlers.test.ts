import { describe, it, expect, vi } from 'vitest'
import { DeviceManager } from '../electron/devices/manager'
import { CH, INVOKE_CHANNELS } from '../electron/ipc/channels'
import {
  registerHandlers,
  type FileOpsController,
  type HandlerDeps,
  type IpcMainLike,
  type LocalController,
  type TransferController,
} from '../electron/ipc/handlers'
import type { TransferSnapshot, TransferTask } from '../src/shared/transfer'
import type { ShellRunner } from '../electron/fs/remote'
import type { ListResult } from '../electron/fs/remote'
import type { AdbState } from '../src/shared/types'
import { fakeBatch } from './fake-batch'
import { fakeDrag } from './fake-drag'

/* ============ 假 ipcMain：捕获注册表，直接调用 handler ============ */

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
      return await fn({ sender: { id: 1 } }, payload)
    },
  }
}

const OK_ADB: AdbState = {
  state: 'ok',
  path: 'C:/platform-tools/adb.exe',
  version: '1.0.41',
  source: 'path',
}

/**
 * 假传输控制器：IPC 层只需要「调度器暴露的那一面」，
 * 用假实现就能测校验/会话检查/错误码收敛，不必起真 adb。
 */
export function fakeTransfer(): TransferController & { tasks: Map<string, TransferTask>; enqueued: unknown[] } {
  const tasks = new Map<string, TransferTask>()
  const enqueued: unknown[] = []
  const snapshot = (): TransferSnapshot => {
    const all = [...tasks.values()]
    return {
      tasks: all,
      running: all.filter((t) => t.status === 'running').length,
      queued: all.filter((t) => t.status === 'queued').length,
    }
  }
  return {
    tasks,
    enqueued,
    enqueue: async (input) => {
      enqueued.push(input)
      const task: TransferTask = {
        id: 'task-' + (tasks.size + 1),
        serial: input.serial,
        direction: input.direction,
        src: input.src,
        dst: input.dstDir + '/' + input.src.split(/[\\/]/).pop(),
        totalBytes: 10,
        doneBytes: 0,
        status: 'queued',
        attempt: 0,
        createdAt: 0,
      }
      tasks.set(task.id, task)
      return task
    },
    cancel: (id) => {
      const task = tasks.get(id)
      if (task === undefined || task.status !== 'queued') return false
      task.status = 'canceled'
      return true
    },
    retry: (id) => {
      const task = tasks.get(id)
      if (task === undefined || task.status !== 'canceled') return false
      task.status = 'queued'
      task.attempt += 1
      return true
    },
    get: (id) => tasks.get(id),
    snapshot,
    clearFinished: () => {
      let removed = 0
      for (const [id, task] of [...tasks]) {
        if (task.status === 'done') { tasks.delete(id); removed += 1 }
      }
      return removed
    },
  }
}

/**
 * 假文件操作服务：记录每次调用的入参，返回可预测的逐项结果。
 *
 * 用假的而不是真的 FsOpsService：IPC 层的职责只有「校验 / 会话检查 / 错误码收敛 /
 * 逐项结果原样透传」，真服务的行为已经由 tests/op-service.test.ts 全覆盖。
 * 混在一起测会让 IPC 用例在服务层改动时大面积假红。
 */
export function fakeOps(): FileOpsController & {
  calls: Array<{ method: string; serial: string; args: unknown[] }>
} {
  const calls: Array<{ method: string; serial: string; args: unknown[] }> = []
  const record = (method: string, serial: string, args: unknown[]): void => { calls.push({ method, serial, args }) }
  return {
    calls,
    mkdir: async (serial, dir, name) => { record('mkdir', serial, [dir, name]); return { ok: true } },
    rename: async (serial, from, newName) => { record('rename', serial, [from, newName]); return { ok: true } },
    removeFacts: async (serial, targets) => {
      record('removeFacts', serial, [targets])
      return { count: targets.length, names: targets.slice(0, 3), truncated: targets.length > 3, hasNonEmptyDir: false, blocked: [] }
    },
    remove: async (serial, targets) => {
      record('remove', serial, [targets])
      return { results: targets.map((target) => ({ name: target.split('/').pop() ?? target, ok: true })) }
    },
    copy: async (serial, sources, dstDir) => {
      record('copy', serial, [sources, dstDir])
      return { results: sources.map((source) => ({ name: source.split('/').pop() ?? source, ok: true })) }
    },
    move: async (serial, sources, dstDir) => {
      record('move', serial, [sources, dstDir])
      return { results: sources.map((source) => ({ name: source.split('/').pop() ?? source, ok: true })) }
    },
  }
}

/** 假本地目录访问（越界错误码由真实现给，这里只验证 IPC 的透传）。 */
export function fakeLocal(): LocalController & { calls: Array<string | undefined> } {
  const calls: Array<string | undefined> = []
  return {
    calls,
    list: async (dir) => {
      calls.push(dir)
      return { cwd: dir ?? 'C:/Users/me', parent: null, items: [], root: 'C:/Users/me' }
    },
  }
}

const LIST_OK: ListResult = {
  entries: [
    {
      name: 'note.txt',
      isDir: false,
      isLink: false,
      size: 7,
      mtime: 1_700_000_000_000,
      mode: '-rw-------',
      owner: 'u0_a104',
      group: 'u0_a104',
    },
  ],
  degraded: false,
  unparsed: 0,
  usedFallback: false,
  exitCode: 0,
  tzOffsetMinutes: 480,
}

interface Harness {
  ipc: ReturnType<typeof fakeIpc>
  deps: HandlerDeps
  listCalls: Array<{ serial: string; dir: string }>
  clients: string[]
}

function harness(over: Partial<HandlerDeps> = {}): Harness {
  const mgr = new DeviceManager()
  mgr.applySnapshot([{ serial: '9N9CN2G0012A6F', status: 'device', model: 'DJI RC PLUS 2' }])
  const listCalls: Array<{ serial: string; dir: string }> = []
  const clients: string[] = []
  const deps: HandlerDeps = {
    devices: mgr,
    adbPath: () => 'C:/platform-tools/adb.exe',
    adbState: () => OK_ADB,
    clientFactory: (serial) => {
      clients.push(serial)
      return { serial } as ShellRunner
    },
    fs: {
      list: async (client, adbPath, dir) => {
        listCalls.push({ serial: client.serial ?? '', dir })
        expect(adbPath).toBe('C:/platform-tools/adb.exe')
        return LIST_OK
      },
    },
    transfer: fakeTransfer(),
    pickFiles: async () => [],
    ops: fakeOps(),
    local: fakeLocal(),
    pickRoot: async () => '',
    batch: fakeBatch(),
    drag: fakeDrag(),
    ...over,
  }
  const ipc = fakeIpc()
  registerHandlers(deps, ipc.ipc)
  return { ipc, deps, listCalls, clients }
}

describe('IPC handler 注册（裁决 2：白名单）', () => {
  it('注册了全部 invoke 通道，且没有多注册', () => {
    const { ipc } = harness()
    expect([...ipc.channels].sort()).toEqual([...INVOKE_CHANNELS].sort())
    expect(ipc.channels).toContain(CH.DEVICES_LIST)
    expect(ipc.channels).toContain(CH.FS_LIST)
  })

  it('事件通道 devices:changed 不得注册成 handle（推送只能走 webContents.send）', () => {
    const { ipc } = harness()
    expect(ipc.channels).not.toContain(CH.DEVICES_CHANGED)
  })

  it('重复注册同一通道会抛错（防止两处 registerHandlers 互相覆盖）', () => {
    const h = harness()
    const second = fakeIpc()
    registerHandlers(h.deps, second.ipc)
    expect(() => registerHandlers(h.deps, second.ipc)).toThrow(/duplicate/)
  })
})

describe('devices:list', () => {
  it('返回 { ok:true, data:{ devices, adb } }', async () => {
    const { ipc } = harness()
    const result = await ipc.invoke(CH.DEVICES_LIST)
    expect(result).toMatchObject({ ok: true })
    const data = (result as { ok: true; data: { devices: Array<{ serial: string; model?: string }>; adb: AdbState } }).data
    expect(data.devices).toHaveLength(1)
    expect(data.devices[0].serial).toBe('9N9CN2G0012A6F')
    expect(data.devices[0].model).toBe('DJI RC PLUS 2')
    expect(data.adb).toEqual(OK_ADB)
  })

  it('adb 不可用时仍然返回设备表，只是 adb.state 为 error（设备栏据此显示「无法使用 adb」）', async () => {
    const { ipc } = harness({
      adbState: () => ({ state: 'error', code: 'E_ADB_NOT_FOUND', attempts: [] }),
    })
    const result = await ipc.invoke(CH.DEVICES_LIST)
    const data = (result as { ok: true; data: { adb: AdbState } }).data
    expect(data.adb.state).toBe('error')
  })

  it('忽略渲染层传来的多余载荷（不接受外部注入的设备表）', async () => {
    const { ipc } = harness()
    const result = await ipc.invoke(CH.DEVICES_LIST, { devices: [{ serial: 'EVIL' }] })
    const data = (result as { ok: true; data: { devices: Array<{ serial: string }> } }).data
    expect(data.devices.map((d) => d.serial)).toEqual(['9N9CN2G0012A6F'])
  })
})

describe('fs:list（裁决 7：接真实实现）', () => {
  it('合法入参：走 clientFactory(serial) + listDirDetailed，返回 degraded/exitCode', async () => {
    const { ipc, listCalls, clients } = harness()
    const result = await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/sdcard' })
    expect(result).toMatchObject({ ok: true })
    const data = (result as { ok: true; data: Record<string, unknown> }).data
    expect(clients).toEqual(['9N9CN2G0012A6F'])
    expect(listCalls).toEqual([{ serial: '9N9CN2G0012A6F', dir: '/sdcard' }])
    expect(data.entries).toHaveLength(1)
    // 任务 7 要用这两个字段显示「部分文件无法读取」
    expect(data.degraded).toBe(false)
    expect(data.exitCode).toBe(0)
    expect(data.tzOffsetMinutes).toBe(480)
    expect(data.dir).toBe('/sdcard')
  })

  it('目录路径被归一化后返回（消除尾斜杠与 ..，任务 7 直接拿来用）', async () => {
    const { ipc, listCalls } = harness()
    const result = await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/sdcard//DCIM/../DCIM/' })
    const data = (result as { ok: true; data: { dir: string } }).data
    expect(data.dir).toBe('/sdcard/DCIM')
    expect(listCalls[0].dir).toBe('/sdcard/DCIM')
  })

  it('degraded 结果如实透传（partial 不等于失败）', async () => {
    const { ipc } = harness({
      fs: { list: async () => ({ ...LIST_OK, degraded: true, usedFallback: true, unparsed: 3, exitCode: 1 }) },
    })
    const result = await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/proc/1' })
    const data = (result as { ok: true; data: Record<string, unknown> }).data
    expect(data.degraded).toBe(true)
    expect(data.exitCode).toBe(1)
    expect(data.unparsed).toBe(3)
  })

  it.each([
    ['缺 serial', { dir: '/sdcard' }],
    ['缺 dir', { serial: 'S' }],
    ['serial 空串', { serial: '', dir: '/sdcard' }],
    ['dir 空串', { serial: 'S', dir: '' }],
    ['serial 非字符串', { serial: 42, dir: '/sdcard' }],
    ['dir 非字符串', { serial: 'S', dir: ['/sdcard'] }],
    ['载荷是 null', null],
    ['载荷缺失', undefined],
    ['载荷是数组', []],
    ['载荷是字符串', 'serial=S'],
  ])('入参非法（%s）→ { ok:false, error:E_BAD_ARGS } 且不碰 adb', async (_label, payload) => {
    const { ipc, listCalls, clients } = harness()
    const result = await ipc.invoke(CH.FS_LIST, payload)
    expect(result).toEqual({ ok: false, error: 'E_BAD_ARGS' })
    expect(listCalls).toEqual([])
    expect(clients).toEqual([])
  })

  it('未登记的 serial → E_NO_SERIAL（不得凭渲染层给的 serial 就发命令）', async () => {
    const { ipc, listCalls } = harness()
    const result = await ipc.invoke(CH.FS_LIST, { serial: 'NOT-CONNECTED', dir: '/sdcard' })
    expect(result).toEqual({ ok: false, error: 'E_NO_SERIAL' })
    expect(listCalls).toEqual([])
  })

  it('listDirDetailed 抛出的错误码被翻译成统一错误结构，不冒泡异常', async () => {
    const { ipc } = harness({
      fs: { list: async () => { throw new Error('E_NOT_FOUND') } },
    })
    expect(await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/nope' }))
      .toEqual({ ok: false, error: 'E_NOT_FOUND' })
  })

  it('权限错误同样被翻译（E_NO_PERMISSION 原样传出）', async () => {
    const { ipc } = harness({
      fs: { list: async () => { throw new Error('E_NO_PERMISSION') } },
    })
    expect(await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/data' }))
      .toEqual({ ok: false, error: 'E_NO_PERMISSION' })
  })

  it('无法识别的异常 → E_UNKNOWN（渲染层永远能拿到一个错误码）', async () => {
    const { ipc } = harness({
      fs: { list: async () => { throw new Error('socket hang up') } },
    })
    expect(await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/sdcard' }))
      .toEqual({ ok: false, error: 'E_UNKNOWN' })
  })

  it('system 级非 Error 抛出（字符串）也被兜住', async () => {
    const { ipc } = harness({
      fs: { list: async () => { throw 'E_TIMEOUT' } },
    })
    expect(await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/sdcard' }))
      .toEqual({ ok: false, error: 'E_TIMEOUT' })
  })

  it('adb 未定位到（adbPath 为空）时不发命令，直接 E_ADB_NOT_FOUND', async () => {
    const { ipc, listCalls } = harness({ adbPath: () => '' })
    expect(await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/sdcard' }))
      .toEqual({ ok: false, error: 'E_ADB_NOT_FOUND' })
    expect(listCalls).toEqual([])
  })

  it('含换行的路径在校验层就被拒（E_INVALID_PATH），不发命令', async () => {
    const { ipc, listCalls } = harness()
    const result = await ipc.invoke(CH.FS_LIST, { serial: '9N9CN2G0012A6F', dir: '/sdcard/a\nb' })
    expect(result).toEqual({ ok: false, error: 'E_INVALID_PATH' })
    expect(listCalls).toEqual([])
  })
})

/* ============ 问题 1：local:pick-root 的「无载荷」必须合法 ============ */

/*
 * 修前 preflight 是：!parsed.success || parsed.data === undefined → E_BAD_ARGS。
 * 而 ipcRenderer.invoke(channel) 不带第二参时，payload 就是 undefined，
 * z.unknown().safeParse(undefined) 是 success=true、data=undefined ——
 * 于是「更换目录」按钮稳定报「请求参数不合法」（真机实测复现）。
 *
 * 下面三条都断言**行为**：返回值 + deps.pickRoot 的调用次数，不看任何源码文本。
 * 第三条是对照组：去掉判据不能把真正需要载荷的通道也一起放过。
 */

/** 记录 pickRoot 被调用几次、返回什么（默认空串 = 用户在对话框里点了取消）。 */
function fakePickRoot(result: string | Error = ''): { calls: number; pickRoot: () => Promise<string> } {
  const state = { calls: 0 }
  return {
    get calls() { return state.calls },
    pickRoot: async () => {
      state.calls += 1
      if (result instanceof Error) throw result
      return result
    },
  }
}

describe('local:pick-root（问题 1：不带载荷的 invoke 必须成功）', () => {
  it('不带载荷调用（invoke(channel) 的真实形态）→ { ok:true }，且 pickRoot 恰好被调用一次', async () => {
    const picker = fakePickRoot('/home/me/Pictures')
    const { ipc } = harness({ pickRoot: picker.pickRoot })
    // 关键：第二个参数根本不传 —— 与 preload 的 deps.invoke(CH.LOCAL_PICK_ROOT) 完全一致
    const result = await ipc.invoke(CH.LOCAL_PICK_ROOT)
    expect(result).toEqual({ ok: true, data: '/home/me/Pictures' })
    expect(picker.calls).toBe(1)
  })

  it('带 null 载荷调用（preload 现在的显式形态）→ 同样 { ok:true } 且 pickRoot 调用一次', async () => {
    const picker = fakePickRoot('/home/me/Music')
    const { ipc } = harness({ pickRoot: picker.pickRoot })
    const result = await ipc.invoke(CH.LOCAL_PICK_ROOT, null)
    expect(result).toEqual({ ok: true, data: '/home/me/Music' })
    expect(picker.calls).toBe(1)
  })

  it('用户取消（pickRoot 返回空串）也是 ok:true + 空串，不是错误', async () => {
    const picker = fakePickRoot('')
    const { ipc } = harness({ pickRoot: picker.pickRoot })
    expect(await ipc.invoke(CH.LOCAL_PICK_ROOT)).toEqual({ ok: true, data: '' })
    expect(picker.calls).toBe(1)
  })

  it('pickRoot 抛异常 → 收敛成错误码，不冒泡', async () => {
    const picker = fakePickRoot(new Error('E_BAD_ARGS'))
    const { ipc } = harness({ pickRoot: picker.pickRoot })
    expect(await ipc.invoke(CH.LOCAL_PICK_ROOT)).toEqual({ ok: false, error: 'E_BAD_ARGS' })
    expect(picker.calls).toBe(1)
  })

  it('对照组：真正需要载荷的通道（fs:list）不带载荷仍然必须是 E_BAD_ARGS', async () => {
    const { ipc, listCalls, clients } = harness()
    // 与上面第一条同样是「不带载荷」，但 fs:list 用的是 z.object，缺字段 → success=false
    expect(await ipc.invoke(CH.FS_LIST)).toEqual({ ok: false, error: 'E_BAD_ARGS' })
    expect(listCalls).toEqual([])
    expect(clients).toEqual([])
  })
})

/*
 * preload 那一层：electron 在 node 测试环境里是 undefined（preload.ts 模块顶层就调用
 * contextBridge.exposeInMainWorld），所以这里用 vi.mock('electron') 提供一个空壳桥，
 * 再驱动真正的 buildApi —— 判据仍然是「调用记录」，不是源码文本。
 */
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: () => undefined },
  ipcRenderer: { invoke: async () => undefined, on: () => undefined, off: () => undefined },
}))

describe('preload 的 pickRoot 真的把载荷传下去了（问题 1 的第二层防线）', () => {
  it('buildApi 的 local.pickRoot 调用 invoke 时带上了 LOCAL_PICK_ROOT 通道与一个非 undefined 载荷', async () => {
    /*
     * 直接驱动 buildApi（注入假 invoke），断言「调用记录」而不是源码文本：
     * 修前 deps.invoke(CH.LOCAL_PICK_ROOT) 只有通道名，args 是空数组。
     */
    const { buildApi } = await import('../electron/preload')
    const calls: Array<{ channel: string; args: unknown[] }> = []
    const api = buildApi({
      invoke: async (channel, ...args) => {
        calls.push({ channel, args })
        return { ok: true, data: '/picked' }
      },
      on: () => undefined,
      off: () => undefined,
      // 本用例只测 pickRoot：File→路径的真相由 tests/drag-*.test.ts 压制
      getPathForFile: () => '',
    })
    const result = await api.local.pickRoot()
    expect(result).toEqual({ ok: true, data: '/picked' })
    expect(calls).toHaveLength(1)
    expect(calls[0].channel).toBe('local:pick-root')
    // 关键：确实传了载荷，且不是 undefined（undefined 会被主进程当成「没传」）
    expect(calls[0].args).toHaveLength(1)
    expect(calls[0].args[0]).not.toBeUndefined()
  })
})
