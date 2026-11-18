import { describe, it, expect, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FrameDecoder, parseDeviceLines, DeviceTracker } from '../electron/adb/track'
import { DeviceManager } from '../electron/devices/manager'
import { adbChildCount, killAllAdbChildren } from '../electron/adb/children'

const isWin = process.platform === 'win32'
const ADB = isWin ? 'adb.exe' : 'adb'

// 本机是否有真 adb：有才跑真实集成用例。
function adbOnPath(): boolean {
  try {
    const r = spawnSync(ADB, ['version'], { windowsHide: true, timeout: 15_000 })
    return r.status === 0
  } catch {
    return false
  }
}
const HAS_ADB = adbOnPath()

/*
 * ===== 裁决 1：真实抓包数据（2026-11-18，adb 1.0.41，Windows 11，真机 9N9CN2G0012A6F）=====
 *
 * adb track-devices 原始字节（单设备）：
 *   hex: 30 30 31 36 39 4e 39 43 4e 32 47 30 30 31 32 41 36 46 09 64 65 76 69 63 65 0d 0a
 *   ascii: "0016" + "9N9CN2G0012A6F\tdevice\r\n"          共 27 字节
 *   帧头 0x0016 = 22 = 逻辑负载 "9N9CN2G0012A6F\tdevice\n" 的字节数（LF 计 1 字节）
 *   帧头后【没有】换行符。负载里的 \n 在 Windows 上被 CRT 文本模式翻成 \r\n，
 *   所以线上负载 23 字节 != 帧头 22 字节 —— 解码必须按「逻辑长度」等待，不能按字节数。
 *
 * adb track-devices 原始字节（两台设备，第二台是伪造的 TCP offline 设备）：
 *   hex: 30 30 32 64 | 394e...3646 09 646576696365 0d 0a | 3132372e302e302e313a35353939 09 6f66666c696e65 0d 0a
 *   ascii: "002d" + "9N9CN2G0012A6F\tdevice\r\n127.0.0.1:5599\toffline\r\n"   共 51 字节
 *   帧头 0x002d = 45 = 逻辑负载（两行，各以 \n 结尾）的字节数
 *   每台设备一行，多行同帧；任何一台设备变化都重发【全量列表】。
 *
 * adb track-devices 原始字节（空设备列表，用 -P 起独立空 server 抓到）：
 *   hex: 30 30 30 30     ascii: "0000"    共 4 字节，无任何换行
 *
 * 结论：简报里「4 位十六进制 + 换行 + 负载」不成立 —— 帧头后没有换行。
 *
 * 【危害更正，I5】简报原实现（先 indexOf(0x0a) 找换行）在真实字节上产出的假设备
 * serial 为 "00169N9CN2G0012A6F"、status 为 **device**（不是 unknown）——
 * 因为 \t 仍留在这行里，split('\t') 后 state 恰好是 device。
 * 也就是说 UI 会把它显示成一台可用的真设备，用户点进去才发现全部操作失败，
 * 危害比 unknown 更大。
 */
const RAW_SINGLE = '30303136' + '394e39434e324730303132413646' + '09' + '646576696365' + '0d0a'
const RAW_TWO =
  '30303264' +
  '394e39434e324730303132413646' + '09' + '646576696365' + '0d0a' +
  '3132372e302e302e313a35353939' + '09' + '6f66666c696e65' + '0d0a'
const RAW_EMPTY = '30303030'

const SINGLE_FRAME = '9N9CN2G0012A6F\tdevice\n'
const TWO_FRAME = '9N9CN2G0012A6F\tdevice\n127.0.0.1:5599\toffline\n'

// 真实 adb devices -l 的一行（含 model/transport_id 附加列）
const DEVICES_L =
  'List of devices attached\r\n' +
  '9N9CN2G0012A6F         device product:rc701 model:DJI_RC_PLUS_2 device:rc701 transport_id:8\r\n\r\n'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await wait(20)
  }
}

const dirs: string[] = []
const trackers: DeviceTracker[] = []

afterEach(() => {
  while (trackers.length > 0) trackers.pop()?.stop()
  killAllAdbChildren()
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'task4-track-'))
  dirs.push(dir)
  return dir
}

interface FakeTrackOpts {
  stdout?: Buffer
  stderr?: string
  exitCode?: number
  idle?: boolean
}

// 起一个假的 adb 子进程：真的 spawn node 脚本，因此能真实验证登记与回收。
function fakeTrack(opts: FakeTrackOpts): () => ReturnType<typeof spawn> {
  return () => {
    const dir = tmpDir()
    const script = path.join(dir, 'fake-track.mjs')
    const lines: string[] = []
    if (opts.stdout !== undefined) {
      lines.push('process.stdout.write(Buffer.from(' + JSON.stringify(opts.stdout.toString('hex')) + ', "hex"))')
    }
    if (opts.stderr !== undefined) lines.push('process.stderr.write(' + JSON.stringify(opts.stderr) + ')')
    if (opts.idle === true) lines.push('setInterval(() => {}, 1000)')
    else lines.push('process.exit(' + String(opts.exitCode ?? 0) + ')')
    writeFileSync(script, lines.join('\n'))
    return spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] })
  }
}

describe('FrameDecoder（真实帧格式）', () => {
  it('解析真实单设备帧：帧头后无换行，负载 CRLF 归一为 LF', () => {
    const d = new FrameDecoder()
    expect(d.push(Buffer.from(RAW_SINGLE, 'hex'))).toEqual([SINGLE_FRAME])
    expect(d.pendingBytes).toBe(0)
  })

  it('解析真实两设备帧：一帧多行', () => {
    const d = new FrameDecoder()
    expect(d.push(Buffer.from(RAW_TWO, 'hex'))).toEqual([TWO_FRAME])
    expect(d.pendingBytes).toBe(0)
  })

  it('解析真实空列表帧 0000：负载为空串而非零帧', () => {
    const d = new FrameDecoder()
    expect(d.push(Buffer.from(RAW_EMPTY, 'hex'))).toEqual([''])
    expect(d.pendingBytes).toBe(0)
  })

  // ---- C1：帧尾 \r 与 \n 分属两个 chunk 时必须等待，不得提前吐帧 ----
  it('C1 单设备帧切在帧尾 \\r 与 \\n 之间（k=26）时先不吐帧，下一 chunk 补齐后只吐一次', () => {
    const raw = Buffer.from(RAW_SINGLE, 'hex')
    // 末两字节是 0x0d 0x0a：切在它们中间
    expect(raw[raw.length - 2]).toBe(0x0d)
    expect(raw[raw.length - 1]).toBe(0x0a)
    const d = new FrameDecoder()
    expect(d.push(raw.subarray(0, raw.length - 1))).toEqual([])
    expect(d.push(raw.subarray(raw.length - 1))).toEqual([SINGLE_FRAME])
    expect(d.pendingBytes).toBe(0)
  })

  it('C1 两设备帧切在帧尾 \\r 与 \\n 之间（k=50）时先不吐帧，下一 chunk 补齐后只吐一次', () => {
    const raw = Buffer.from(RAW_TWO, 'hex')
    expect(raw[raw.length - 2]).toBe(0x0d)
    expect(raw[raw.length - 1]).toBe(0x0a)
    const d = new FrameDecoder()
    expect(d.push(raw.subarray(0, raw.length - 1))).toEqual([])
    expect(d.push(raw.subarray(raw.length - 1))).toEqual([TWO_FRAME])
    expect(d.pendingBytes).toBe(0)
  })

  // ---- C1：逐字节全遍历，任何切点都不得失步 ----
  it('C1 单设备帧逐字节切分全遍历（k=1..26）：每个切点都只吐一次正确帧且缓冲区清空', () => {
    const raw = Buffer.from(RAW_SINGLE, 'hex')
    for (let k = 1; k < raw.length; k++) {
      const d = new FrameDecoder()
      const got: string[] = []
      got.push(...d.push(raw.subarray(0, k)))
      got.push(...d.push(raw.subarray(k)))
      expect(got, 'k=' + k).toEqual([SINGLE_FRAME])
      expect(d.pendingBytes, 'k=' + k).toBe(0)
    }
  })

  it('C1 两设备帧逐字节切分全遍历（k=1..50）：每个切点都只吐一次正确帧且缓冲区清空', () => {
    const raw = Buffer.from(RAW_TWO, 'hex')
    for (let k = 1; k < raw.length; k++) {
      const d = new FrameDecoder()
      const got: string[] = []
      got.push(...d.push(raw.subarray(0, k)))
      got.push(...d.push(raw.subarray(k)))
      expect(got, 'k=' + k).toEqual([TWO_FRAME])
      expect(d.pendingBytes, 'k=' + k).toBe(0)
    }
  })

  it('C1 两设备帧三次切分（每个 \\r 与 \\n 都被切开）：仍只吐一次正确帧', () => {
    const raw = Buffer.from(RAW_TWO, 'hex')
    const d = new FrameDecoder()
    const got: string[] = []
    // 25|26 切在第一个 \r|\n 之间；49|50 切在第二个 \r|\n 之间
    for (const [a, b] of [[0, 25], [25, 26], [26, 49], [49, 51]] as const) {
      got.push(...d.push(raw.subarray(a, b)))
    }
    expect(got).toEqual([TWO_FRAME])
    expect(d.pendingBytes).toBe(0)
  })

  it('连续两帧在同一 chunk 内到达时全部吐出', () => {
    const d = new FrameDecoder()
    const raw = Buffer.concat([Buffer.from(RAW_SINGLE, 'hex'), Buffer.from(RAW_TWO, 'hex')])
    expect(d.push(raw)).toEqual([SINGLE_FRAME, TWO_FRAME])
    expect(d.pendingBytes).toBe(0)
  })

  it('连续两帧逐字节切分全遍历：每个切点都吐两帧且缓冲区清空（C1 加强）', () => {
    const raw = Buffer.concat([Buffer.from(RAW_SINGLE, 'hex'), Buffer.from(RAW_TWO, 'hex')])
    for (let k = 1; k < raw.length; k++) {
      const d = new FrameDecoder()
      const got: string[] = []
      got.push(...d.push(raw.subarray(0, k)))
      got.push(...d.push(raw.subarray(k)))
      expect(got, 'k=' + k).toEqual([SINGLE_FRAME, TWO_FRAME])
      expect(d.pendingBytes, 'k=' + k).toBe(0)
    }
  })

  it('兼容裸行输出（启动窗口内首 4 字节非十六进制时退化为按行切分）', () => {
    const d = new FrameDecoder()
    expect(d.push(Buffer.from('ABC123\tdevice\n'))).toEqual(['ABC123\tdevice'])
  })

  // ---- I1：裸行模式不再粘性，帧模式下的噪声行不会让解码器永久退化 ----
  it('I1 已判定帧模式后混入噪声行，后续真帧仍能解析（bare 不粘性）', () => {
    const d = new FrameDecoder()
    expect(d.push(Buffer.from(RAW_SINGLE, 'hex'))).toEqual([SINGLE_FRAME])
    // 流里插入一行噪声：帧模式下应从下一个换行重新同步并丢弃
    expect(d.push(Buffer.from('ZZZZ\n'))).toEqual([])
    expect(d.push(Buffer.from(RAW_SINGLE, 'hex'))).toEqual([SINGLE_FRAME])
    expect(d.pendingBytes).toBe(0)
  })

  it('I1 噪声与真帧同一 chunk 到达时丢掉噪声、保住真帧', () => {
    const d = new FrameDecoder()
    expect(d.push(Buffer.from(RAW_SINGLE, 'hex'))).toEqual([SINGLE_FRAME])
    const noise = Buffer.concat([Buffer.from('ZZZZ\n'), Buffer.from(RAW_SINGLE, 'hex')])
    expect(d.push(noise)).toEqual([SINGLE_FRAME])
    expect(d.pendingBytes).toBe(0)
  })

  it('I1 缓冲区异常增长超过上限时丢弃并从下一个换行重新同步', () => {
    const d = new FrameDecoder()
    // 帧头声称 65535 字节负载，随后灌入远超上限的垃圾（无换行）
    expect(d.push(Buffer.from('ffff'))).toEqual([])
    expect(d.push(Buffer.alloc(300 * 1024, 0x41))).toEqual([])
    // 清空后真帧仍正常解析
    expect(d.push(Buffer.from(RAW_SINGLE, 'hex'))).toEqual([SINGLE_FRAME])
    expect(d.pendingBytes).toBe(0)
  })
})

describe('parseDeviceLines', () => {
  it('多行解析为设备条目', () => {
    expect(parseDeviceLines('ABC123\tdevice\n192.168.1.7:5555\toffline\n')).toEqual([
      { serial: 'ABC123', status: 'device', transport: 'usb' },
      { serial: '192.168.1.7:5555', status: 'offline', transport: 'wireless' },
    ])
  })

  it('容忍 adb devices 表头行与空行（裁决 5）', () => {
    expect(parseDeviceLines('List of devices attached\r\n9N9CN2G0012A6F\tdevice\r\n\r\n')).toEqual([
      { serial: '9N9CN2G0012A6F', status: 'device', transport: 'usb' },
    ])
  })

  it('no permissions 状态行不产出假 serial、不崩（裁决 6）', () => {
    const raw =
      'List of devices attached\r\n' +
      '????????????\tno permissions (user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html]\r\n' +
      '\r\n'
    expect(parseDeviceLines(raw)).toEqual([
      { serial: '????????????', status: 'unknown', transport: 'usb' },
    ])
  })

  it('sideload / bootloader / host 等真实状态映射为 unknown 且保留 serial', () => {
    expect(parseDeviceLines('A1\tsideload\nB2\tbootloader\nC3\thost\nD4\tdevice\n')).toEqual([
      { serial: 'A1', status: 'unknown', transport: 'usb' },
      { serial: 'B2', status: 'unknown', transport: 'usb' },
      { serial: 'C3', status: 'unknown', transport: 'usb' },
      { serial: 'D4', status: 'device', transport: 'usb' },
    ])
  })

  it('adb devices -l 的附加列不影响状态判定，并把 model 解析出来（_ 还原为空格）（I3）', () => {
    expect(parseDeviceLines(DEVICES_L)).toEqual([
      { serial: '9N9CN2G0012A6F', status: 'device', transport: 'usb', model: 'DJI RC PLUS 2' },
    ])
  })

  it('I3 无 model 行时 model 字段不出现（不是空串）', () => {
    const rows = parseDeviceLines('List of devices attached\r\nABC123\tdevice\r\n\r\n')
    expect(rows).toEqual([{ serial: 'ABC123', status: 'device', transport: 'usb' }])
    expect('model' in rows[0]).toBe(false)
  })

  it('跳过 adb daemon 提示行', () => {
    const raw =
      '* daemon not running; starting now at tcp:5037\n' +
      '* daemon started successfully\n' +
      'ABC123\tdevice\n'
    expect(parseDeviceLines(raw)).toEqual([{ serial: 'ABC123', status: 'device', transport: 'usb' }])
  })

  it('空输入返回空数组', () => {
    expect(parseDeviceLines('')).toEqual([])
  })
})

describe('DeviceTracker', () => {
  it('track-devices 可用时按帧推送快照并写入会话表', async () => {
    const manager = new DeviceManager()
    const tracker = new DeviceTracker({
      adbPath: ADB,
      manager,
      spawnTrack: fakeTrack({ stdout: Buffer.from(RAW_SINGLE, 'hex'), idle: true }),
    })
    trackers.push(tracker)
    tracker.start()
    await waitFor(() => manager.list().length > 0)
    expect(tracker.mode).toBe('track')
    expect(manager.list().map((s) => s.serial)).toEqual(['9N9CN2G0012A6F'])
    expect(manager.list()[0].status).toBe('device')
  })

  it('track-devices 起不来时降级为定时 adb devices 轮询（裁决 3）', async () => {
    const manager = new DeviceManager()
    let polls = 0
    const tracker = new DeviceTracker({
      adbPath: ADB,
      manager,
      spawnTrack: fakeTrack({ stderr: 'error: unknown host service\n', exitCode: 1 }),
      pollDevices: async () => {
        polls += 1
        return 'List of devices attached\r\nABC123\tdevice\r\n\r\n'
      },
      pollIntervalMs: 30,
    })
    trackers.push(tracker)
    tracker.start()
    await waitFor(() => manager.list().length > 0)
    expect(tracker.mode).toBe('poll')
    expect(polls).toBeGreaterThan(0)
    expect(manager.list()[0].serial).toBe('ABC123')
  })

  it('轮询定时器可停止：stop() 之后不再发起轮询（裁决 3）', async () => {
    const manager = new DeviceManager()
    let polls = 0
    const tracker = new DeviceTracker({
      adbPath: ADB,
      manager,
      spawnTrack: fakeTrack({ exitCode: 1 }),
      pollDevices: async () => {
        polls += 1
        return 'ABC123\tdevice\n'
      },
      pollIntervalMs: 20,
    })
    tracker.start()
    await waitFor(() => polls >= 2)
    tracker.stop()
    const frozen = polls
    await wait(150)
    expect(polls).toBe(frozen)
    expect(tracker.mode).toBe('idle')
  })

  it('I2 轮询有 in-flight 守卫：慢 adb devices 不会叠加并发，旧快照不覆盖新快照', async () => {
    const manager = new DeviceManager()
    let concurrent = 0
    let maxConcurrent = 0
    let polls = 0
    const tracker = new DeviceTracker({
      adbPath: ADB,
      manager,
      spawnTrack: fakeTrack({ exitCode: 1 }),
      pollDevices: async () => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        polls += 1
        await wait(120)
        concurrent -= 1
        return 'ABC123\tdevice\n'
      },
      pollIntervalMs: 10,
    })
    trackers.push(tracker)
    tracker.start()
    await waitFor(() => polls >= 3)
    tracker.stop()
    expect(maxConcurrent).toBe(1)
  }, 15_000)

  it('I3 降级轮询使用 adb devices -l，model 写入会话表', async () => {
    const manager = new DeviceManager()
    const seenArgs: string[][] = []
    const tracker = new DeviceTracker({
      adbPath: ADB,
      manager,
      spawnTrack: fakeTrack({ exitCode: 1 }),
      spawnDevices: (args) => {
        seenArgs.push(args)
        return fakeTrack({ stdout: Buffer.from(DEVICES_L, 'utf8') })()
      },
      pollIntervalMs: 20,
    })
    trackers.push(tracker)
    tracker.start()
    await waitFor(() => manager.list().length > 0)
    expect(seenArgs[0]).toEqual(['devices', '-l'])
    expect(manager.list()[0].model).toBe('DJI RC PLUS 2')
  }, 15_000)

  it('track-devices 启动后长时间无输出时降级轮询（启动守卫）', async () => {
    const manager = new DeviceManager()
    const tracker = new DeviceTracker({
      adbPath: ADB,
      manager,
      spawnTrack: fakeTrack({ idle: true }),
      pollDevices: async () => 'ABC123\tdevice\n',
      startupTimeoutMs: 60,
      pollIntervalMs: 30,
    })
    trackers.push(tracker)
    tracker.start()
    await waitFor(() => manager.list().length > 0)
    expect(tracker.mode).toBe('poll')
  })

  it('track 子进程登记进 children 表，killAllAdbChildren 后归零（裁决 2）', async () => {
    const manager = new DeviceManager()
    const tracker = new DeviceTracker({
      adbPath: ADB,
      manager,
      spawnTrack: fakeTrack({ stdout: Buffer.from(RAW_SINGLE, 'hex'), idle: true }),
      pollDevices: async () => '',
      pollIntervalMs: 10_000,
    })
    trackers.push(tracker)
    tracker.start()
    await waitFor(() => manager.list().length > 0)
    expect(adbChildCount()).toBeGreaterThan(0)
    killAllAdbChildren()
    expect(adbChildCount()).toBe(0)
  })

  it('track 进程退出后自动转轮询（进程退出也是不可用）', async () => {
    const manager = new DeviceManager()
    const tracker = new DeviceTracker({
      adbPath: ADB,
      manager,
      spawnTrack: fakeTrack({ stdout: Buffer.from(RAW_SINGLE, 'hex'), exitCode: 0 }),
      pollDevices: async () => 'XYZ789\tdevice\n',
      pollIntervalMs: 30,
    })
    trackers.push(tracker)
    tracker.start()
    await waitFor(() => manager.list().some((s) => s.serial === 'XYZ789'))
    expect(tracker.mode).toBe('poll')
  })

  it('跟踪器生命周期驱动会话表 gc：start 起定时器，stop 停定时器（裁决 4）', async () => {
    const manager = new DeviceManager()
    const tracker = new DeviceTracker({
      adbPath: ADB,
      manager,
      spawnTrack: fakeTrack({ stdout: Buffer.from(RAW_SINGLE, 'hex'), idle: true }),
      pollDevices: async () => '',
      pollIntervalMs: 10_000,
    })
    trackers.push(tracker)
    expect(manager.gcRunning).toBe(false)
    tracker.start()
    await waitFor(() => manager.list().length > 0)
    expect(manager.gcRunning).toBe(true)
    tracker.stop()
    expect(manager.gcRunning).toBe(false)
  })

  it.skipIf(!HAS_ADB)('真实 adb：track-devices 快照与 adb devices 一致', async () => {
    const expected = parseDeviceLines(
      spawnSync(ADB, ['devices'], { windowsHide: true, encoding: 'utf8', timeout: 20_000 }).stdout,
    )
    const manager = new DeviceManager()
    const tracker = new DeviceTracker({ adbPath: ADB, manager, startupTimeoutMs: 4_000 })
    trackers.push(tracker)
    tracker.start()
    await waitFor(() => tracker.mode !== 'idle')
    await waitFor(() => manager.list().length === expected.length)
    expect(tracker.mode).toBe('track')
    expect(manager.list().map((s) => s.serial).sort()).toEqual(expected.map((e) => e.serial).sort())
  }, 30_000)
})
