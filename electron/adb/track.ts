import { spawn, type ChildProcess } from 'node:child_process'
import type { DeviceStatus, Transport } from '../../src/shared/types'
import { killTree, trackChild, untrackChild } from './children'
import type { DeviceManager, DeviceSnapshotItem } from '../devices/manager'

/**
 * track-devices 帧解码器。
 *
 * ===== 真实帧格式（2026-11-18 实测 adb 1.0.41 / Windows，证据见 task-4-report.md）=====
 * 帧 = [4 位小写十六进制 ASCII 长度][负载]。长度后【没有】换行符。
 *   单设备：  30 30 31 36 | 39 4e ... 0d 0a   → "0016" + "9N9CN2G0012A6F\tdevice\r\n"（共 27 字节）
 *   两台设备：30 30 32 64 | 两行，各以 \r\n 结尾  → "002d" + "…device\r\n127.0.0.1:5599\toffline\r\n"（共 51 字节）
 *   空列表：  30 30 30 30                    → "0000"，无负载也无换行（共 4 字节）
 *
 * 帧头给的是【逻辑】负载字节数（\n 记 1 字节）。Windows 上 adb 的 CRT 文本模式
 * 把每个 \n 写成 \r\n，线上实际多出一串 \r 字节 —— 所以既不能按线上字节数等待（会多切），
 * 也不能数 \n 的个数（len 是字节数不是行数）。必须逐字节数「逻辑长度」，
 * 最后再把 \r\n 归一成 \n。
 *
 * 兼容退路：首 4 字节不是小写十六进制时，退化为按 \n 切分的裸行模式。
 */
export class FrameDecoder {
  private buf = Buffer.alloc(0)
  /** 一旦判定为裸行模式就保持，避免同一流里两种模式来回抖动。 */
  private bare = false

  push(chunk: Buffer): string[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: string[] = []
    for (;;) {
      if (!this.bare && this.buf.length < 4) break
      const head = this.buf.subarray(0, 4).toString('latin1')
      const framed = !this.bare && /^[0-9a-f]{4}$/.test(head)

      if (!framed) {
        this.bare = true
        const nl = this.buf.indexOf(0x0a)
        if (nl < 0) break
        out.push(this.buf.subarray(0, nl).toString('utf8'))
        this.buf = this.buf.subarray(nl + 1)
        continue
      }

      const len = parseInt(head, 16)
      const payloadStart = 4
      if (len === 0) {
        out.push('')
        this.buf = this.buf.subarray(payloadStart)
        continue
      }

      // 逐字节数逻辑长度：\r 后紧跟 \n 说明这是 CRT 加出来的那个 \r，不计入；
      // 其余字节（含真正的 \n）各计 1。
      let logical = 0
      let end = -1
      for (let i = payloadStart; i < this.buf.length; i++) {
        const isExtraCr = this.buf[i] === 0x0d && i + 1 < this.buf.length && this.buf[i + 1] === 0x0a
        if (isExtraCr) continue
        logical += 1
        if (logical === len) {
          end = i
          break
        }
      }
      if (end < 0) break

      out.push(this.buf.subarray(payloadStart, end + 1).toString('utf8').replace(/\r\n/g, '\n'))
      this.buf = this.buf.subarray(end + 1)
    }
    return out
  }
}

/** adb 状态词 → 受控枚举。未列出的（sideload/bootloader/host/no permissions…）一律 unknown。 */
function toStatus(word: string): DeviceStatus {
  switch (word) {
    case 'device':
    case 'unauthorized':
    case 'offline':
    case 'recovery':
      return word
    default:
      return 'unknown'
  }
}

/** adb devices 的表头行与提示行，必须跳过，否则会解析出一条假设备（裁决 5）。 */
function isNoiseLine(line: string): boolean {
  if (line === '') return true
  if (line.startsWith('List of devices attached')) return true
  // '* daemon not running; starting now at tcp:5037' / '* daemon started successfully'
  if (line.startsWith('* ')) return true
  if (line.startsWith('adb server')) return true
  return false
}

/**
 * 把 adb 的设备表文本解析成设备条目。
 *
 * 列分隔用 \t（adb 的真实输出就是 tab），不能按空格切分：
 * no permissions 状态自带空格与括号（裁决 6），按空格切会把 serial 切碎。
 * 空格式（adb devices -l：serial<多个空格>state product:…）先取第一个 token 当 serial，
 * 剩下按空白切出状态词。
 */
export function parseDeviceLines(payload: string): DeviceSnapshotItem[] {
  const rows: DeviceSnapshotItem[] = []
  for (const rawLine of payload.split('\n')) {
    const line = rawLine.trim()
    if (isNoiseLine(line)) continue

    const tab = line.indexOf('\t')
    let serial: string
    let rest: string
    if (tab >= 0) {
      serial = line.slice(0, tab).trim()
      rest = line.slice(tab + 1).trim()
    } else {
      const parts = line.split(/\s+/)
      serial = parts[0] ?? ''
      rest = parts.slice(1).join(' ')
    }
    if (serial === '' || serial.startsWith('*')) continue

    // 只取状态词本身：no permissions (...)、device product:xxx 的附加部分都不影响判定。
    const stateWord = rest.split(/[\s:;]/).filter(Boolean)[0] ?? ''
    const transport: Transport = serial.includes(':') ? 'wireless' : 'usb'
    rows.push({ serial, status: toStatus(stateWord), transport })
  }
  return rows
}

export type TrackerMode = 'idle' | 'track' | 'poll'

export interface DeviceTrackerOptions {
  adbPath: string
  manager: DeviceManager
  /** 仅在测试注入：替换 spawn(adbPath, ['track-devices'])。 */
  spawnTrack?: () => ChildProcess
  /** 仅在测试注入：替换真实的一次 adb devices 调用，返回 stdout。 */
  pollDevices?: () => Promise<string>
  /** 降级轮询周期，默认 DEFAULT_POLL_INTERVAL_MS。 */
  pollIntervalMs?: number
  /** track-devices 启动后多久没有任何输出就判定不可用，默认 DEFAULT_STARTUP_TIMEOUT_MS。 */
  startupTimeoutMs?: number
}

interface ResolvedTrackerOptions {
  adbPath: string
  manager: DeviceManager
  spawnTrack?: () => ChildProcess
  pollDevices?: () => Promise<string>
  pollIntervalMs: number
  startupTimeoutMs: number
}

/** 默认轮询周期：3 秒一次 adb devices，跟得上插拔，又不至于压垮 adb server。 */
export const DEFAULT_POLL_INTERVAL_MS = 3_000
/** 默认启动守卫：5 秒内没吐第一帧就认为 track-devices 不可用。 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 5_000

/**
 * 设备跟踪器：优先用 adb track-devices 长驻流，不可用时自动降级为定时 adb devices 轮询。
 *
 * 红线一：track-devices 子进程必须登记进 children.ts，
 * 否则 app.on('before-quit') 的 killAllAdbChildren() 枚举不到它，窗口退出后进程存活。
 *
 * 红线二：轮询定时器与 gc 定时器都必须能被 stop() 清掉，
 * 否则 Electron 退出时事件循环不空、进程挂住。所有定时器都已 unref。
 */
export class DeviceTracker {
  private readonly opts: ResolvedTrackerOptions
  private decoder = new FrameDecoder()
  private child: ChildProcess | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private currentMode: TrackerMode = 'idle'
  private stopped = false
  /** gc 定时器是不是本跟踪器起的；只有自己起的才由自己停。 */
  private ownsGc = false

  constructor(options: DeviceTrackerOptions) {
    this.opts = {
      adbPath: options.adbPath,
      manager: options.manager,
      spawnTrack: options.spawnTrack,
      pollDevices: options.pollDevices,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    }
  }

  get mode(): TrackerMode {
    return this.currentMode
  }

  start(): void {
    if (this.currentMode !== 'idle') return
    this.stopped = false
    // 会话表 gc 由跟踪器生命周期驱动：跟踪器在跑，掉线会话就必须有人清理；
    // 跟踪器停了，这个定时器也要跟着停。仅在没人管时接管，不抢调用方自己的定时器。
    if (!this.opts.manager.gcRunning) {
      this.ownsGc = true
      this.opts.manager.startGc()
    }
    this.startTrack()
  }

  /** 停掉长驻进程与所有定时器。幂等。 */
  stop(): void {
    // 先置 stopped：stop() 触发的 close/error 回调会据此提前返回，不得再降级。
    this.stopped = true
    if (this.ownsGc) {
      this.ownsGc = false
      this.opts.manager.stopGc()
    }
    this.clearStartupTimer()
    this.clearPollTimer()
    const child = this.child
    this.child = undefined
    if (child !== undefined) {
      untrackChild(child)
      killTree(child)
    }
    this.currentMode = 'idle'
    this.decoder = new FrameDecoder()
  }

  private clearStartupTimer(): void {
    if (this.startupTimer === undefined) return
    clearTimeout(this.startupTimer)
    this.startupTimer = undefined
  }

  private clearPollTimer(): void {
    if (this.pollTimer === undefined) return
    clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  private startTrack(): void {
    let child: ChildProcess
    try {
      child = this.opts.spawnTrack !== undefined
        ? this.opts.spawnTrack()
        : spawn(this.opts.adbPath, ['track-devices'], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
    } catch {
      // spawn 同步抛错（路径不存在等）也算 track 不可用
      this.fallbackToPoll()
      return
    }

    this.child = child
    // 登记进全局子进程表：before-quit 时 killAllAdbChildren() 才能枚举到它。
    trackChild(child)
    this.currentMode = 'track'

    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.stopped) return
      this.clearStartupTimer()
      for (const payload of this.decoder.push(chunk)) this.applyPayload(payload)
    })
    // stderr 必须消费，否则管道写满会把 adb 自己阻塞住。
    child.stderr?.resume()

    child.on('error', () => {
      untrackChild(child)
      if (this.child === child) this.child = undefined
      if (this.stopped) return
      this.fallbackToPoll()
    })

    child.on('close', () => {
      untrackChild(child)
      if (this.child === child) this.child = undefined
      // 进程退出（老版 adb 不认 track-devices、adb server 崩了）→ 降级轮询
      if (this.stopped) return
      this.fallbackToPoll()
    })

    // 启动守卫：老版 adb 遇到未知 service 可能既不退出也不吐数据，只挂在那里。
    // 收到第一帧才算 track 真正可用。
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined
      if (this.stopped || this.currentMode !== 'track') return
      this.fallbackToPoll()
    }, this.opts.startupTimeoutMs)
    this.startupTimer.unref()
  }

  /** 降级为定时轮询。幂等：已在轮询就只保证定时器存在。 */
  private fallbackToPoll(): void {
    if (this.stopped) return
    this.clearStartupTimer()
    const child = this.child
    this.child = undefined
    if (child !== undefined) {
      untrackChild(child)
      killTree(child)
    }
    this.currentMode = 'poll'
    if (this.pollTimer !== undefined) return
    // 立刻拉一次，别让用户干等一个轮询周期
    void this.pollOnce()
    this.pollTimer = setInterval(() => { void this.pollOnce() }, this.opts.pollIntervalMs)
    this.pollTimer.unref()
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped || this.currentMode !== 'poll') return
    let stdout: string
    try {
      stdout = this.opts.pollDevices !== undefined
        ? await this.opts.pollDevices()
        : await this.runDevices()
    } catch {
      // 单次轮询失败不是故障：下一周期再试，不值得把整个跟踪器停掉
      return
    }
    if (this.stopped) return
    this.applyPayload(stdout)
  }

  /** 一次 adb devices。必须登记子进程，退出时才会被回收。 */
  private runDevices(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(this.opts.adbPath, ['devices'], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (err) {
        reject(err)
        return
      }
      trackChild(child)
      let stdout = ''
      // setEncoding 走 StringDecoder，多字节字符跨 chunk 不会被切坏
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (text: string) => { stdout += text })
      child.stderr?.resume()
      child.on('error', (err) => {
        untrackChild(child)
        reject(err)
      })
      child.on('close', () => {
        untrackChild(child)
        resolve(stdout)
      })
    })
  }

  private applyPayload(payload: string): void {
    if (this.stopped) return
    this.opts.manager.applySnapshot(parseDeviceLines(payload))
  }
}
