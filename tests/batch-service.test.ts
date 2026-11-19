import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BatchService } from '../electron/batch/service'
import type { BatchServiceDeps } from '../electron/batch/service'
import { DeviceManager } from '../electron/devices/manager'
import type { TransferTask } from '../src/shared/transfer'
import type { EnqueueIntent } from '../electron/transfer/service'
import type { RunResult } from '../electron/adb/client'
import type { ShellRunner } from '../electron/fs/remote'
import { E_BATCH_PARAM, E_DEVICE_OFFLINE, E_NO_PERMISSION, E_PROTECTED_PATH } from '../src/shared/errors'

/*
 * 批量服务的行为测试（任务 10）。
 *
 * 全部断言落在**行为**上：命令 argv 逐字节比对、结果矩阵逐项比对、传输入队的意图。
 * 没有一条匹配源码文本 —— 本项目已经出过 6 次「正则护栏注入缺陷仍全绿」。
 *
 * 假 client 是**有状态**的：它记录每次 run 的完整 argv 与超时，
 * 于是「离线设备零命令」可以写成 expect(dev.commands).toEqual([]) 这种硬断言。
 */

/** 记录 argv 与超时的假设备客户端。 */
class FakeDevice implements ShellRunner {
  readonly serial: string
  readonly commands: string[][] = []
  readonly timeouts: Array<number | undefined> = []
  /** 每条命令的应答；缺省是成功且空输出。 */
  reply: (args: readonly string[]) => RunResult = () => ({ code: 0, stdout: '', stderr: '' })

  constructor(serial: string) {
    this.serial = serial
  }

  async run(args: string[], opts: { adbPath: string; timeoutMs?: number }): Promise<RunResult> {
    // 复制一份：调用方后续若复用数组，历史记录不会被改掉
    this.commands.push([...args])
    this.timeouts.push(opts.timeoutMs)
    return this.reply(args)
  }
}

/** 记录入队意图的假传输队列。 */
function fakeTransfer(failOn?: (input: EnqueueIntent) => string | undefined): {
  enqueued: EnqueueIntent[]
  enqueue: (input: EnqueueIntent) => Promise<TransferTask>
} {
  const enqueued: EnqueueIntent[] = []
  let seq = 0
  return {
    enqueued,
    enqueue: async (input) => {
      const failure = failOn?.(input)
      if (failure !== undefined) throw new Error(failure)
      enqueued.push(input)
      seq += 1
      return {
        id: 'task-' + seq,
        serial: input.serial,
        direction: input.direction,
        src: input.src,
        dst: input.dstDir,
        totalBytes: 1,
        doneBytes: 0,
        status: 'queued',
        attempt: 0,
        createdAt: 0,
      }
    },
  }
}

interface Harness {
  service: BatchService
  devices: DeviceManager
  devs: Map<string, FakeDevice>
  transfer: ReturnType<typeof fakeTransfer>
  dir: string
}

/**
 * 每个用例一个临时根目录：本地访问闸门要求路径落在根内且真实存在。
 */
let roots: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'adbfm-batch-root-'))
  roots.push(dir)
  return dir
}

function harness(over: Partial<BatchServiceDeps> = {}): Harness {
  const devices = new DeviceManager()
  devices.applySnapshot([
    { serial: 'ONLINE-1', status: 'device', model: 'Pixel 7' },
    { serial: 'ONLINE-2', status: 'device', model: 'Mi 13' },
    { serial: 'OFFLINE-1', status: 'offline' },
    { serial: 'UNAUTH-1', status: 'unauthorized' },
  ])
  const devs = new Map<string, FakeDevice>()
  const transfer = fakeTransfer()
  const dir = tempDir()
  const deps: BatchServiceDeps = {
    devices,
    clientFor: (serial) => {
      const dev = devs.get(serial) ?? new FakeDevice(serial)
      devs.set(serial, dev)
      return dev
    },
    transfer,
    localRoot: () => dir,
    adbPath: () => 'C:/platform-tools/adb.exe',
    now: () => 1_700_000_000_000,
    pickDirectory: async () => dir,
    pickApk: async () => '',
    onTaskSettled: (_taskId, callback) => { callback() },
    ...over,
  }
  return { service: new BatchService(deps), devices, devs, transfer, dir }
}

beforeEach(() => { roots = [] })
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  roots = []
})

describe('R5：离线 / 未授权设备零命令', () => {
  it('批量执行命令：离线设备零命令，返回 E_DEVICE_OFFLINE', async () => {
    const h = harness()
    const data = await h.service.shell({ serials: ['OFFLINE-1'] }, 'echo ok')
    expect(h.devs.get('OFFLINE-1')?.commands ?? []).toEqual([])
    expect(data.results).toEqual([{ serial: 'OFFLINE-1', ok: false, code: E_DEVICE_OFFLINE }])
  })

  it('批量执行命令：未授权设备零命令，返回 E_NO_PERMISSION（用户要点的按钮不同）', async () => {
    const h = harness()
    const data = await h.service.shell({ serials: ['UNAUTH-1'] }, 'echo ok')
    expect(h.devs.get('UNAUTH-1')?.commands ?? []).toEqual([])
    expect(data.results).toEqual([{ serial: 'UNAUTH-1', ok: false, code: E_NO_PERMISSION }])
  })

  it('批量安装：离线设备零命令（apk 先校验通过才轮到设备判定）', async () => {
    const root = tempDir()
    const apk = path.join(root, 'app.apk')
    writeFileSync(apk, 'not-really-an-apk-but-non-empty')
    const h = harness({ localRoot: () => root, pickDirectory: async () => root })
    const data = await h.service.install({ serials: ['OFFLINE-1'] }, apk)
    expect(h.devs.get('OFFLINE-1')?.commands ?? []).toEqual([])
    expect(data.results).toEqual([{ serial: 'OFFLINE-1', ok: false, code: E_DEVICE_OFFLINE }])
  })

  it('批量截图：离线设备零命令，且不会入队任何传输', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root, pickDirectory: async () => root })
    const data = await h.service.screenshot({ serials: ['OFFLINE-1'] })
    expect(h.devs.get('OFFLINE-1')?.commands ?? []).toEqual([])
    expect(h.transfer.enqueued).toEqual([])
    expect(data.results).toEqual([{ serial: 'OFFLINE-1', ok: false, code: E_DEVICE_OFFLINE }])
  })

  it('批量推送：离线设备零入队（队列里不该出现注定要暂停的任务）', async () => {
    const root = tempDir()
    const file = path.join(root, 'a.txt')
    writeFileSync(file, 'x')
    const h = harness({ localRoot: () => root, pickDirectory: async () => root })
    const data = await h.service.push({ serials: ['OFFLINE-1'], files: [file], dstDir: '/sdcard/Download' })
    expect(h.transfer.enqueued).toEqual([])
    expect(data.results).toEqual([{ serial: 'OFFLINE-1', ok: false, code: E_DEVICE_OFFLINE }])
  })
})

describe('batch:shell（R8：输出截断，命令逐字节）', () => {
  it('命令 argv 逐字节等于 [shell, <command>]，超时 30s', async () => {
    const h = harness()
    const dev = new FakeDevice('ONLINE-1')
    dev.reply = () => ({ code: 0, stdout: 'ok\n', stderr: '' })
    h.devs.set('ONLINE-1', dev)
    const data = await h.service.shell({ serials: ['ONLINE-1'] }, 'echo ok')
    expect(dev.commands).toEqual([['shell', 'echo ok']])
    expect(dev.timeouts).toEqual([30_000])
    expect(data.results).toEqual([{ serial: 'ONLINE-1', ok: true, detail: 'ok\n', truncated: false }])
  })

  it('stdout 超过 8 KB 时截断并标 truncated（detail 再截到 512 字节）', async () => {
    const h = harness()
    const dev = new FakeDevice('ONLINE-1')
    dev.reply = () => ({ code: 0, stdout: 'a'.repeat(20_000), stderr: '' })
    h.devs.set('ONLINE-1', dev)
    const data = await h.service.shell({ serials: ['ONLINE-1'] }, 'cat /dev/zero')
    const item = data.results[0]
    expect(item.ok).toBe(true)
    expect(item.truncated).toBe(true)
    expect(item.detail).toBe('a'.repeat(512))
  })

  it('截断按 UTF-8 字节数、不切出半个汉字（3 字节字符）', async () => {
    const h = harness()
    const dev = new FakeDevice('ONLINE-1')
    dev.reply = () => ({ code: 0, stdout: '汉'.repeat(300), stderr: '' })
    h.devs.set('ONLINE-1', dev)
    const data = await h.service.shell({ serials: ['ONLINE-1'] }, 'echo 汉')
    const item = data.results[0]
    expect(item.truncated).toBe(true)
    expect(item.detail).toBe('汉'.repeat(170))
    expect(item.detail ?? '').not.toContain('\uFFFD')
  })

  it('命令非零退出 → 该项失败并带上设备侧原因的归类（不是笼统 E_UNKNOWN）', async () => {
    const h = harness()
    const dev = new FakeDevice('ONLINE-1')
    dev.reply = () => ({ code: 1, stdout: '', stderr: 'cat: /nope: Permission denied' })
    h.devs.set('ONLINE-1', dev)
    const data = await h.service.shell({ serials: ['ONLINE-1'] }, 'cat /nope')
    expect(data.results).toEqual([{ serial: 'ONLINE-1', ok: false, code: E_NO_PERMISSION }])
  })

  it('命令为空 → 整批 E_BATCH_PARAM 且零命令（R7：参数错不发命令）', async () => {
    const h = harness()
    const data = await h.service.shell({ serials: ['ONLINE-1', 'ONLINE-2'] }, '   ')
    expect(h.devs.get('ONLINE-1')?.commands ?? []).toEqual([])
    expect(data.results.map((item) => item.code)).toEqual([E_BATCH_PARAM, E_BATCH_PARAM])
  })

  it('命令含换行 → 整批失败且零命令（否则一条命令会变成多条）', async () => {
    const h = harness()
    const data = await h.service.shell({ serials: ['ONLINE-1'] }, 'echo a\nrm -rf /sdcard')
    expect(h.devs.get('ONLINE-1')?.commands ?? []).toEqual([])
    expect(data.results[0].code).toBe('E_INVALID_PATH')
  })

  it('一台失败不影响同批另一台（失败隔离）', async () => {
    const h = harness()
    const ok = new FakeDevice('ONLINE-1')
    ok.reply = () => ({ code: 0, stdout: 'fine', stderr: '' })
    const bad = new FakeDevice('ONLINE-2')
    bad.reply = () => ({ code: 1, stdout: '', stderr: 'sh: x: not found' })
    h.devs.set('ONLINE-1', ok)
    h.devs.set('ONLINE-2', bad)
    const data = await h.service.shell({ serials: ['ONLINE-1', 'ONLINE-2'] }, 'x')
    expect(data.results[0]).toMatchObject({ serial: 'ONLINE-1', ok: true })
    expect(data.results[1]).toMatchObject({ serial: 'ONLINE-2', ok: false })
    expect(ok.commands).toEqual([['shell', 'x']])
    expect(bad.commands).toEqual([['shell', 'x']])
  })
})

describe('batch:install（R7：apk 先校验一次，整批失败）', () => {
  it('apk 不存在 → 整批失败且零命令', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root, pickDirectory: async () => root })
    const data = await h.service.install({ serials: ['ONLINE-1', 'ONLINE-2'] }, path.join(root, 'nope.apk'))
    expect(h.devs.get('ONLINE-1')?.commands ?? []).toEqual([])
    expect(h.devs.get('ONLINE-2')?.commands ?? []).toEqual([])
    expect(data.results).toHaveLength(2)
    for (const item of data.results) expect(item.ok).toBe(false)
  })

  it('空 apk 文件 → E_BATCH_PARAM（零命令）', async () => {
    const root = tempDir()
    const apk = path.join(root, 'empty.apk')
    writeFileSync(apk, '')
    const h = harness({ localRoot: () => root, pickDirectory: async () => root })
    const data = await h.service.install({ serials: ['ONLINE-1'] }, apk)
    expect(h.devs.get('ONLINE-1')?.commands ?? []).toEqual([])
    expect(data.results[0].code).toBe(E_BATCH_PARAM)
  })

  it('正常安装：argv 逐字节 [install, -r, <apk 绝对路径>]，超时 120s', async () => {
    const root = tempDir()
    const apk = path.join(root, 'app.apk')
    writeFileSync(apk, 'PK-fake-apk-bytes')
    const h = harness({ localRoot: () => root, pickDirectory: async () => root })
    const dev = new FakeDevice('ONLINE-1')
    dev.reply = () => ({ code: 0, stdout: 'Success\n', stderr: '' })
    h.devs.set('ONLINE-1', dev)
    const data = await h.service.install({ serials: ['ONLINE-1'] }, apk)
    expect(dev.commands[0][0]).toBe('install')
    expect(dev.commands[0][1]).toBe('-r')
    // 路径来自 checkLocalAccess 的 realpath（Windows 上会把 8.3 短名解析成长名）
    expect(dev.commands[0][2]).toBe(await realpath(apk))
    expect(dev.timeouts).toEqual([120_000])
    expect(data.results).toEqual([{ serial: 'ONLINE-1', ok: true }])
  })

  it('adb 输出 Failure[...] 即使退出码 0 也判失败（版本差异）', async () => {
    const root = tempDir()
    const apk = path.join(root, 'app.apk')
    writeFileSync(apk, 'bytes')
    const h = harness({ localRoot: () => root, pickDirectory: async () => root })
    const dev = new FakeDevice('ONLINE-1')
    dev.reply = () => ({ code: 0, stdout: 'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]\n', stderr: '' })
    h.devs.set('ONLINE-1', dev)
    const data = await h.service.install({ serials: ['ONLINE-1'] }, apk)
    expect(data.results[0]).toMatchObject({ ok: false, code: 'E_NO_SPACE' })
  })
})

describe('batch:push（R2：只入队，自己不管并发）', () => {
  it('每台设备每个文件各入队一次，结果标已加入队列而不是已完成', async () => {
    const root = tempDir()
    const a = path.join(root, 'a.txt')
    const b = path.join(root, 'b.txt')
    writeFileSync(a, 'a')
    writeFileSync(b, 'b')
    const h = harness({ localRoot: () => root, pickDirectory: async () => root })
    const data = await h.service.push({ serials: ['ONLINE-1', 'ONLINE-2'], files: [a, b], dstDir: '/sdcard/Download' })
    expect(h.transfer.enqueued.map((item) => [item.serial, path.basename(item.src), item.direction]))
      .toEqual([
        ['ONLINE-1', 'a.txt', 'push'],
        ['ONLINE-1', 'b.txt', 'push'],
        ['ONLINE-2', 'a.txt', 'push'],
        ['ONLINE-2', 'b.txt', 'push'],
      ])
    expect(data.results).toEqual([
      { serial: 'ONLINE-1', ok: true, detail: '2' },
      { serial: 'ONLINE-2', ok: true, detail: '2' },
    ])
    // R2 的关键证据：批量层自己一条 adb 命令都没发（并发不归它管）
    expect(h.devs.get('ONLINE-1')?.commands ?? []).toEqual([])
    expect(h.devs.get('ONLINE-2')?.commands ?? []).toEqual([])
  })

  it('目标目录是受保护路径 → 整批 E_PROTECTED_PATH 且零入队', async () => {
    const root = tempDir()
    const file = path.join(root, 'a.txt')
    writeFileSync(file, 'a')
    const h = harness({ localRoot: () => root, pickDirectory: async () => root })
    const data = await h.service.push({ serials: ['ONLINE-1'], files: [file], dstDir: '/data/local/tmp' })
    expect(h.transfer.enqueued).toEqual([])
    expect(data.results[0].code).toBe(E_PROTECTED_PATH)
  })

  it('本地文件不存在 → 整批失败且零入队（R7：一次校验，不让 N 台各报一次）', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root, pickDirectory: async () => root })
    const data = await h.service.push({ serials: ['ONLINE-1', 'ONLINE-2'], files: [path.join(root, 'nope.txt')], dstDir: '/sdcard/Download' })
    expect(h.transfer.enqueued).toEqual([])
    expect(data.results.map((item) => item.code)).toEqual(['E_NOT_FOUND', 'E_NOT_FOUND'])
  })

  it('某台设备入队失败只影响它自己，另一台照常入队', async () => {
    const root = tempDir()
    const file = path.join(root, 'a.txt')
    writeFileSync(file, 'a')
    const h = harness({
      localRoot: () => root,
      pickDirectory: async () => root,
      transfer: fakeTransfer((input) => (input.serial === 'ONLINE-2' ? 'E_SYNC_FAILED' : undefined)),
    })
    const data = await h.service.push({ serials: ['ONLINE-1', 'ONLINE-2'], files: [file], dstDir: '/sdcard/Download' })
    expect(data.results[0].ok).toBe(true)
    expect(data.results[1].ok).toBe(false)
    expect(data.results[1].code).toBe('E_SYNC_FAILED')
  })
})

describe('batch:screenshot（R1：临时文件 + 传输队列 + 无条件清理）', () => {
  it('先 screencap 到设备临时目录，再 pull 入队，最后 rm -f 临时文件', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root, pickDirectory: async () => root })
    const dev = new FakeDevice('ONLINE-1')
    h.devs.set('ONLINE-1', dev)
    const data = await h.service.screenshot({ serials: ['ONLINE-1'] })

    const remote = '/sdcard/Download/adbfm-shot-1700000000000-ONLINE-1.png'
    expect(dev.commands).toEqual([
      ['shell', "screencap -p '" + remote + "'"],
      ['shell', "rm -f '" + remote + "'"],
    ])
    expect(dev.timeouts).toEqual([30_000, 30_000])
    expect(h.transfer.enqueued).toEqual([
      // dstDir 传用户原样选的目录（判定用 realpath，执行/传参用原串）
      { serial: 'ONLINE-1', direction: 'pull', src: remote, dstDir: root },
    ])
    expect(data.results).toEqual([{ serial: 'ONLINE-1', ok: true, detail: 'task-1' }])
  })

  it('screencap 失败时仍然清理临时文件（finally 里发 rm），结果带设备侧归类', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root, pickDirectory: async () => root })
    const dev = new FakeDevice('ONLINE-1')
    dev.reply = (args) => (args[1].startsWith('screencap')
      ? { code: 1, stdout: '', stderr: 'permission denied' }
      : { code: 0, stdout: '', stderr: '' })
    h.devs.set('ONLINE-1', dev)
    const data = await h.service.screenshot({ serials: ['ONLINE-1'] })
    expect(dev.commands).toHaveLength(2)
    expect(dev.commands[1][1].startsWith('rm -f ')).toBe(true)
    expect(h.transfer.enqueued).toEqual([])
    expect(data.results[0]).toMatchObject({ ok: false, code: E_NO_PERMISSION })
  })

  it('入队失败时也清理临时文件（设备上不留垃圾）', async () => {
    const root = tempDir()
    const h = harness({
      localRoot: () => root,
      pickDirectory: async () => root,
      transfer: fakeTransfer(() => 'E_SYNC_FAILED'),
    })
    const dev = new FakeDevice('ONLINE-1')
    h.devs.set('ONLINE-1', dev)
    const data = await h.service.screenshot({ serials: ['ONLINE-1'] })
    expect(dev.commands).toHaveLength(2)
    expect(data.results[0]).toMatchObject({ ok: false, code: 'E_SYNC_FAILED' })
  })

  it('用户取消目录选择 → 空结果、零命令、零入队（取消不是错误）', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root, pickDirectory: async () => '' })
    const data = await h.service.screenshot({ serials: ['ONLINE-1'] })
    expect(data.results).toEqual([])
    expect(h.devs.get('ONLINE-1')?.commands ?? []).toEqual([])
    expect(h.transfer.enqueued).toEqual([])
  })

  it('目标目录不在本地根内 → 整批失败且零命令', async () => {
    const root = tempDir()
    const outside = tempDir()
    const h = harness({ localRoot: () => root, pickDirectory: async () => outside })
    const data = await h.service.screenshot({ serials: ['ONLINE-1'] })
    expect(h.devs.get('ONLINE-1')?.commands ?? []).toEqual([])
    expect(data.results[0].code).toBe('E_OUTSIDE_ROOT')
  })

  it('每台设备的临时文件名互不相同（同一时间戳下也按 serial 区分）', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root, pickDirectory: async () => root })
    const dev1 = new FakeDevice('ONLINE-1')
    const dev2 = new FakeDevice('ONLINE-2')
    h.devs.set('ONLINE-1', dev1)
    h.devs.set('ONLINE-2', dev2)
    await h.service.screenshot({ serials: ['ONLINE-1', 'ONLINE-2'] })
    const src1 = h.transfer.enqueued[0].src
    const src2 = h.transfer.enqueued[1].src
    expect(src1).not.toBe(src2)
    expect(src1).toContain('ONLINE-1')
    expect(src2).toContain('ONLINE-2')
  })
})
