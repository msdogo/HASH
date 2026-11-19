import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  BatchService,
  SHOT_FALLBACK_DIR,
  SHOT_PREFIX,
  SHOT_TEMP_DIR,
  deviceShotDir,
  type BatchServiceDeps,
} from '../electron/batch/service'
import { E_STDOUT_LIMIT } from '../electron/adb/client'
import { DeviceManager } from '../electron/devices/manager'
import type { TransferTask } from '../src/shared/transfer'
import type { EnqueueIntent } from '../electron/transfer/service'
import type { RunResult } from '../electron/adb/client'
import type { ShellRunner } from '../electron/fs/remote'
import {
  E_BAD_COMMAND,
  E_BATCH_PARAM,
  E_DEVICE_OFFLINE,
  E_NO_PERMISSION,
  E_PROTECTED_PATH,
} from '../src/shared/errors'

/*
 * 批量服务的行为测试（任务 10）。
 *
 * 全部断言落在**行为**上：命令 argv 逐字节比对、结果矩阵逐项比对、传输入队的意图。
 * 没有一条匹配源码文本 —— 本项目已经出过 6 次「正则护栏注入缺陷仍全绿」。
 *
 * 假 client 是**有状态**的：它记录每次 run 的完整 argv 与超时，并且会像
 * AdbClient 一样把 stdout 通过 onStdout 流式吐出（这样流式封顶那条也能测）。
 * 于是「离线设备零命令」可以写成 expect(dev.commands).toEqual([]) 这种硬断言。
 */

/** 记录 argv 与超时的假设备客户端，并模拟 AdbClient 的流式行为。 */
class FakeDevice implements ShellRunner {
  readonly serial: string
  readonly commands: string[][] = []
  readonly timeouts: Array<number | undefined> = []
  /** 每条命令的应答；缺省是成功且空输出。 */
  reply: (args: readonly string[]) => RunResult = () => ({ code: 0, stdout: '', stderr: '' })

  constructor(serial: string) {
    this.serial = serial
  }

  async run(
    args: string[],
    opts: { adbPath: string; timeoutMs?: number; onStdout?: (chunk: string) => void; maxStdoutBytes?: number },
  ): Promise<RunResult> {
    this.commands.push([...args])
    this.timeouts.push(opts.timeoutMs)
    const result = this.reply(args)
    /*
     * 模拟 AdbClient 的**流式**行为（复审 I3）：分块吐给 onStdout，
     * 并在带 maxStdoutBytes 时像真 client 一样超限就 reject(E_STDOUT_LIMIT)。
     * 假 client 不分块的话，「主进程不在收流时累积」这条根本测不出来。
     */
    if (opts.onStdout !== undefined) {
      const chunkSize = 1024
      let bytes = 0
      for (let i = 0; i < result.stdout.length; i += chunkSize) {
        const chunk = result.stdout.slice(i, i + chunkSize)
        opts.onStdout(chunk)
        bytes += Buffer.byteLength(chunk, 'utf8')
        if (opts.maxStdoutBytes !== undefined && bytes > opts.maxStdoutBytes) {
          throw new Error(E_STDOUT_LIMIT)
        }
      }
    } else if (opts.maxStdoutBytes !== undefined) {
      throw new Error(E_STDOUT_LIMIT)
    }
    return result
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
  /** 已登记但未结算的清理回调（模拟 main.ts 的表）。 */
  settled: Map<string, () => void>
}

/** 每个用例一个临时根目录（本地访问闸门要求路径落在根内且真实存在）。 */
let roots: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'adbfm-batch-root-'))
  roots.push(dir)
  return dir
}

function harness(
  over: Partial<BatchServiceDeps> = {},
  options: { settleMode?: 'now' | 'manual' } = {},
): Harness {
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
  const settled = new Map<string, () => void>()
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
    onTaskSettled: (taskId, callback) => {
      settled.set(taskId, callback)
      if (options.settleMode !== 'manual') callback()
    },
    ...over,
  }
  return { service: new BatchService(deps), devices, devs, transfer, dir, settled }
}

beforeAll(() => { /* 无全局准备 */ })
afterAll(() => {
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
    const h = harness({ localRoot: () => root })
    const data = await h.service.install({ serials: ['OFFLINE-1'] }, apk)
    expect(h.devs.get('OFFLINE-1')?.commands ?? []).toEqual([])
    expect(data.results).toEqual([{ serial: 'OFFLINE-1', ok: false, code: E_DEVICE_OFFLINE }])
  })

  it('批量截图：离线设备零命令，且不会入队任何传输', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root })
    const data = await h.service.screenshot({ serials: ['OFFLINE-1'] }, root)
    expect(h.devs.get('OFFLINE-1')?.commands ?? []).toEqual([])
    expect(h.transfer.enqueued).toEqual([])
    expect(data.results).toEqual([{ serial: 'OFFLINE-1', ok: false, code: E_DEVICE_OFFLINE }])
  })

  it('批量推送：离线设备零入队（队列里不该出现注定要暂停的任务）', async () => {
    const root = tempDir()
    const file = path.join(root, 'a.txt')
    writeFileSync(file, 'x')
    const h = harness({ localRoot: () => root })
    const data = await h.service.push({ serials: ['OFFLINE-1'], files: [file], dstDir: '/sdcard/Download' })
    expect(h.transfer.enqueued).toEqual([])
    expect(data.results).toEqual([{ serial: 'OFFLINE-1', ok: false, code: E_DEVICE_OFFLINE }])
  })
})

describe('batch:shell（R8 / I3：流式封顶，命令逐字节）', () => {
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

  it('命令把 maxStdoutBytes 交给 client（I3：截断必须发生在收流过程中）', async () => {
    const h = harness()
    const dev = new FakeDevice('ONLINE-1')
    const limits: Array<number | undefined> = []
    const original = dev.run.bind(dev)
    dev.run = async (args, opts) => {
      limits.push(opts.maxStdoutBytes)
      return original(args, opts)
    }
    h.devs.set('ONLINE-1', dev)
    await h.service.shell({ serials: ['ONLINE-1'] }, 'cat /dev/zero')
    expect(limits).toEqual([8 * 1024])
  })

  it('stdout 超过 8 KB → 中止命令，但**这项仍然成功**且标 truncated（截断不是失败）', async () => {
    const h = harness()
    const dev = new FakeDevice('ONLINE-1')
    dev.reply = () => ({ code: 0, stdout: 'a'.repeat(20_000), stderr: '' })
    h.devs.set('ONLINE-1', dev)
    const data = await h.service.shell({ serials: ['ONLINE-1'] }, 'cat /dev/zero')
    const item = data.results[0]
    expect(item.ok).toBe(true)
    expect(item.truncated).toBe(true)
    // detail 是 512 字节摘要（R8 的第二层上限）
    expect(item.detail).toBe('a'.repeat(512))
  })

  it('流式预算只保留前 8 KB（内存不随输出增长），且不切出半个汉字', async () => {
    const h = harness()
    const dev = new FakeDevice('ONLINE-1')
    // 300 个汉字 = 900 字节，没超 8 KB 上限 → 不该截断；
    // 但 detail 会截到 512 字节 = 170 个汉字
    dev.reply = () => ({ code: 0, stdout: '汉'.repeat(300), stderr: '' })
    h.devs.set('ONLINE-1', dev)
    const data = await h.service.shell({ serials: ['ONLINE-1'] }, 'echo 汉')
    const item = data.results[0]
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

  it('命令含换行 → 整批 E_BAD_COMMAND 且零命令（Minor 4：换行不是「路径不合法」）', async () => {
    const h = harness()
    const data = await h.service.shell({ serials: ['ONLINE-1'] }, 'echo a\nrm -rf /sdcard')
    expect(h.devs.get('ONLINE-1')?.commands ?? []).toEqual([])
    expect(data.results[0].code).toBe(E_BAD_COMMAND)
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
    const h = harness({ localRoot: () => root })
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
    const h = harness({ localRoot: () => root })
    const data = await h.service.install({ serials: ['ONLINE-1'] }, apk)
    expect(h.devs.get('ONLINE-1')?.commands ?? []).toEqual([])
    expect(data.results[0].code).toBe(E_BATCH_PARAM)
  })

  it('正常安装：argv 逐字节 [install, -r, <apk 绝对路径>]，超时 120s', async () => {
    const root = tempDir()
    const apk = path.join(root, 'app.apk')
    writeFileSync(apk, 'PK-fake-apk-bytes')
    const h = harness({ localRoot: () => root })
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
    const h = harness({ localRoot: () => root })
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
    const h = harness({ localRoot: () => root })
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
    const h = harness({ localRoot: () => root })
    const data = await h.service.push({ serials: ['ONLINE-1'], files: [file], dstDir: '/data/local/tmp' })
    expect(h.transfer.enqueued).toEqual([])
    expect(data.results[0].code).toBe(E_PROTECTED_PATH)
  })

  it('本地文件不存在 → 整批失败且零入队（R7：一次校验，不让 N 台各报一次）', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root })
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
      transfer: fakeTransfer((input) => (input.serial === 'ONLINE-2' ? 'E_SYNC_FAILED' : undefined)),
    })
    const data = await h.service.push({ serials: ['ONLINE-1', 'ONLINE-2'], files: [file], dstDir: '/sdcard/Download' })
    expect(data.results[0].ok).toBe(true)
    expect(data.results[1].ok).toBe(false)
    expect(data.results[1].code).toBe('E_SYNC_FAILED')
  })
})

describe('batch:screenshot（R1 / I2：隐藏临时目录 + 传输队列 + 无条件清理）', () => {
  it('I2：落点是隐藏目录下的**本机专属**子目录，先 mkdir -p 再截图', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root })
    const dev = new FakeDevice('ONLINE-1')
    h.devs.set('ONLINE-1', dev)
    await h.service.screenshot({ serials: ['ONLINE-1'] }, root)

    expect(SHOT_TEMP_DIR).toBe('/sdcard/.adbfm')
    // N3：每台设备一个子目录，归属明确
    expect(deviceShotDir('ONLINE-1')).toBe('/sdcard/.adbfm/ONLINE-1')
    // 顺序：建目录 → 清扫陈旧残留 → 截图（→ 终态后 rm）
    expect(dev.commands[0]).toEqual(['shell', "mkdir -p '/sdcard/.adbfm/ONLINE-1'"])
    expect(dev.commands[1][1]).toBe("rm -f '/sdcard/.adbfm/ONLINE-1'/adbfm-shot-*.png")
    const shot = dev.commands.find((args) => args[1].startsWith('screencap -p '))
    expect(shot).toBeDefined()
    // 临时文件确实落在本机子目录里
    expect(shot?.[1]).toContain("'/sdcard/.adbfm/ONLINE-1/" + SHOT_PREFIX)
    expect(h.transfer.enqueued[0].src.startsWith('/sdcard/.adbfm/ONLINE-1/' + SHOT_PREFIX)).toBe(true)
  })

  it('I2：隐藏目录建不出来时回退 /sdcard/Download（宁可可见也不能让功能不可用）', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root })
    const dev = new FakeDevice('ONLINE-1')
    dev.reply = (args) => (args[1].includes('/.adbfm/')
      ? { code: 1, stdout: '', stderr: 'mkdir: Permission denied' }
      : { code: 0, stdout: '', stderr: '' })
    h.devs.set('ONLINE-1', dev)
    await h.service.screenshot({ serials: ['ONLINE-1'] }, root)

    expect(SHOT_FALLBACK_DIR).toBe('/sdcard/Download')
    const shot = dev.commands.find((args) => args[1].startsWith('screencap'))
    // 回退落点同样按设备分目录
    expect(shot?.[1]).toContain("'" + SHOT_FALLBACK_DIR + '/ONLINE-1/' + SHOT_PREFIX)
  })

  it('I1：截图前先清扫陈旧残留（进程被强杀时唯一的清理出口）', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root })
    const dev = new FakeDevice('ONLINE-1')
    h.devs.set('ONLINE-1', dev)
    await h.service.screenshot({ serials: ['ONLINE-1'] }, root)

    // 通配符不能被引号包住（否则 rm 删的是字面量文件名）
    const sweep = dev.commands.find((args) => args[1].startsWith('rm -f '))
    expect(sweep?.[1]).toBe("rm -f '/sdcard/.adbfm/ONLINE-1'/adbfm-shot-*.png")
  })

  it('N3：两台设备并发截图时，一台的清扫绝不碰另一台的源文件', async () => {
    /*
     * 复审真机复现的缺陷：清扫只按「目录 + 前缀」，先完成的那台会把
     * 另一台**还在排队的 pull 源文件**删掉 → 后者 E_NOT_FOUND。
     *
     * 判据不是「有没有发 rm」，而是**rm 的路径集合与各台的源文件集合不相交**：
     * 这才是用户能感知的行为（截图成功 vs 莫名失败）。
     */
    const root = tempDir()
    const h = harness({ localRoot: () => root })
    const a = new FakeDevice('ONLINE-1')
    const b = new FakeDevice('ONLINE-2')
    h.devs.set('ONLINE-1', a)
    h.devs.set('ONLINE-2', b)
    const data = await h.service.screenshot({ serials: ['ONLINE-1', 'ONLINE-2'] }, root)
    expect(data.results.every((item) => item.ok)).toBe(true)

    // 每台其实只对自己那台发命令（clientFor 按 serial 造），这里逐台核对
    for (const [serial, dev] of [['ONLINE-1', a], ['ONLINE-2', b]] as const) {
      const sweeps = dev.commands.filter((args) => args[1].startsWith('rm -f '))
      expect(sweeps.length).toBeGreaterThan(0)
      // 清扫命令里出现的目录必须只属于本机，且不得含另一台的 serial
      const other = serial === 'ONLINE-1' ? 'ONLINE-2' : 'ONLINE-1'
      for (const args of sweeps) expect(args[1]).not.toContain(other)
      for (const args of sweeps) expect(args[1]).toContain(serial)
    }

    // 最关键的一条：A 的清扫通配路径不得覆盖 B 的源文件
    const sourceA = h.transfer.enqueued.find((item) => item.serial === 'ONLINE-1')?.src as string
    const sourceB = h.transfer.enqueued.find((item) => item.serial === 'ONLINE-2')?.src as string
    expect(sourceA).toBeDefined()
    expect(sourceB).toBeDefined()
    /** 从 rm 命令里取出被清扫的目录：rm -f '<dir>'/<prefix>*.png */
    function sweepDirOf(command: string): string {
      const head = "rm -f '"
      const tail = "'/" + SHOT_PREFIX + '*.png'
      return command.slice(head.length, command.length - tail.length)
    }
    const sweepDirsA = a.commands.filter((args) => args[1].startsWith('rm -f ')).map((args) => sweepDirOf(args[1]))
    const sweepDirsB = b.commands.filter((args) => args[1].startsWith('rm -f ')).map((args) => sweepDirOf(args[1]))
    for (const dir of sweepDirsA) expect(sourceB.startsWith(dir + '/')).toBe(false)
    for (const dir of sweepDirsB) expect(sourceA.startsWith(dir + '/')).toBe(false)
    // 反向自证：各自清扫目录确实覆盖自己的源文件（否则这条测试就是空转）
    expect(sweepDirsA.some((dir) => sourceA.startsWith(dir + '/'))).toBe(true)
    expect(sweepDirsB.some((dir) => sourceB.startsWith(dir + '/'))).toBe(true)
  })

  it('先 screencap 到临时文件，再 pull 入队，最后 rm -f 清理', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root })
    const dev = new FakeDevice('ONLINE-1')
    h.devs.set('ONLINE-1', dev)
    const data = await h.service.screenshot({ serials: ['ONLINE-1'] }, root)

    const shot = dev.commands.find((args) => args[1].startsWith('screencap'))
    const remote = "/sdcard/.adbfm/ONLINE-1/" + SHOT_PREFIX + '1700000000000-ONLINE-1.png'
    expect(shot).toEqual(['shell', "screencap -p '" + remote + "'"])
    expect(h.transfer.enqueued).toEqual([
      { serial: 'ONLINE-1', direction: 'pull', src: remote, dstDir: root },
    ])
    // 任务结算后应发出 rm
    expect(dev.commands.some((args) => args[1] === "rm -f '" + remote + "'")).toBe(true)
    expect(data.results).toEqual([{ serial: 'ONLINE-1', ok: true, detail: 'task-1' }])
    // 全部结算完，登记表清空
    expect(h.service.pendingCleanups).toBe(0)
  })

  it('screencap 失败时仍然清理临时文件，结果带设备侧归类', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root })
    const dev = new FakeDevice('ONLINE-1')
    dev.reply = (args) => (args[1].startsWith('screencap')
      ? { code: 1, stdout: '', stderr: 'permission denied' }
      : { code: 0, stdout: '', stderr: '' })
    h.devs.set('ONLINE-1', dev)
    const data = await h.service.screenshot({ serials: ['ONLINE-1'] }, root)
    expect(dev.commands.some((args) => args[1].startsWith("rm -f '"))).toBe(true)
    expect(h.transfer.enqueued).toEqual([])
    expect(data.results[0]).toMatchObject({ ok: false, code: E_NO_PERMISSION })
  })

  it('入队失败时也清理临时文件（设备上不留垃圾）', async () => {
    const root = tempDir()
    const h = harness({
      localRoot: () => root,
      transfer: fakeTransfer(() => 'E_SYNC_FAILED'),
    })
    const dev = new FakeDevice('ONLINE-1')
    h.devs.set('ONLINE-1', dev)
    const data = await h.service.screenshot({ serials: ['ONLINE-1'] }, root)
    expect(dev.commands.some((args) => args[1].startsWith("rm -f '"))).toBe(true)
    expect(data.results[0]).toMatchObject({ ok: false, code: 'E_SYNC_FAILED' })
  })

  it('I1：任务一直不结算时，dispose() 会把未结算的清理全部执行掉（退出不留残留）', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root }, { settleMode: 'manual' })
    const dev = new FakeDevice('ONLINE-1')
    h.devs.set('ONLINE-1', dev)
    await h.service.screenshot({ serials: ['ONLINE-1'] }, root)

    // 任务还没结算：登录表里有 1 条（审查复现的 LEFTOVER_AFTER_QUIT 场景）
    expect(h.service.pendingCleanups).toBe(1)
    const before = dev.commands.filter((args) => args[1].startsWith("rm -f '")).length

    h.service.dispose()

    // dispose 之后必须真的发出 rm，且登记表清空
    expect(h.service.pendingCleanups).toBe(0)
    const after = dev.commands.filter((args) => args[1].startsWith("rm -f '")).length
    expect(after).toBe(before + 1)
  })

  it('I1：dispose 之后迟到的结算回调不会重复删（幂等）', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root }, { settleMode: 'manual' })
    const dev = new FakeDevice('ONLINE-1')
    h.devs.set('ONLINE-1', dev)
    await h.service.screenshot({ serials: ['ONLINE-1'] }, root)

    h.service.dispose()
    const removed = dev.commands.filter((args) => args[1].startsWith("rm -f '")).length
    // 终态事件迟到：已经结算过一次，不许再删一次
    for (const callback of h.settled.values()) callback()
    const after = dev.commands.filter((args) => args[1].startsWith("rm -f '")).length
    expect(after).toBe(removed)
  })

  it('目标目录不在本地根内 → 整批失败且零命令', async () => {
    const root = tempDir()
    const outside = tempDir()
    const h = harness({ localRoot: () => root })
    const data = await h.service.screenshot({ serials: ['ONLINE-1'] }, outside)
    expect(h.devs.get('ONLINE-1')?.commands ?? []).toEqual([])
    expect(data.results[0].code).toBe('E_OUTSIDE_ROOT')
  })

  it('目标目录为空串 → E_BATCH_PARAM 且零命令（R7）', async () => {
    const h = harness()
    const data = await h.service.screenshot({ serials: ['ONLINE-1'] }, '   ')
    expect(h.devs.get('ONLINE-1')?.commands ?? []).toEqual([])
    expect(data.results[0].code).toBe(E_BATCH_PARAM)
  })

  it('每台设备的临时文件名互不相同（同一时间戳下也按 serial 区分）', async () => {
    const root = tempDir()
    const h = harness({ localRoot: () => root })
    h.devs.set('ONLINE-1', new FakeDevice('ONLINE-1'))
    h.devs.set('ONLINE-2', new FakeDevice('ONLINE-2'))
    await h.service.screenshot({ serials: ['ONLINE-1', 'ONLINE-2'] }, root)
    const src1 = h.transfer.enqueued[0].src
    const src2 = h.transfer.enqueued[1].src
    expect(src1).not.toBe(src2)
    expect(src1).toContain('ONLINE-1')
    expect(src2).toContain('ONLINE-2')
  })
})
