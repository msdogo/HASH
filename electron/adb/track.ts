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
 * 也不能数 \n 的个数（len 是字节数不是行数）。必须逐字节数「逻辑长度」。
 *
 * ===== 跨 chunk 的边界规则（C1）=====
 * 某个 \r 是不是「CRT 加出来的」，取决于它后面那个字节是不是 \n。
 * 如果 \r 正好是当前缓冲区的最后一个字节，\n 还在下一个 chunk 里，此时【无法判定】，
 * 只能先等 —— 绝不能把它当成有效负载计入长度，否则会提前吐帧、
 * 缓冲区错位、下一帧读出假设备且不可自愈。见 push() 里的 needMore 分支。
 *
 * ===== 帧模式 / 裸行模式（I1）=====
 * 只在「启动窗口」（首次 push 的前 4 字节）里决定是否走裸行兼容。
 * 判定为帧模式之后，裸行退路永不重新启用 —— 否则一次误判会让解码器永久退化。
 * 帧模式下遇到非十六进制帧头（流内噪声）时，丢弃到下一个 \n 重新同步，
 * 而不是切换模式。
 */

/** 单帧逻辑长度上限（256KB）。超过即判为流异常，不无限等待。 */
export const MAX_FRAME_LEN = 256 * 1024
/** 缓冲区上限：超过说明已经失步（帧头读错且永远等不到负载），必须丢弃重同步。 */
export const MAX_BUFFER_BYTES = MAX_FRAME_LEN

export class FrameDecoder {
  private buf = Buffer.alloc(0)
  /** 是否已判定为「帧模式」。判定只在启动窗口内做一次，之后不再改变（I1）。 */
  private framed = false
  /** 启动窗口是否已决策。 */
  private decided = false
  /** 因流异常丢弃过的字节累计数（诊断用）。 */
  private discarded = 0

  /** 缓冲区里尚未消费的字节数（诊断与测试用）。 */
  get pendingBytes(): number {
    return this.buf.length
  }

  /** 已丢弃的异常字节数（诊断用）。 */
  get discardedBytes(): number {
    return this.discarded
  }

  push(chunk: Buffer): string[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: string[] = []
    for (;;) {
      // 缓冲区无界增长 = 已失步：丢弃到下一个 \n（含）或整段清空，重新同步。
      if (this.buf.length > MAX_BUFFER_BYTES) {
        this.discarded += this.buf.length
        const nl = this.buf.indexOf(0x0a)
        this.buf = nl < 0 ? Buffer.alloc(0) : this.buf.subarray(nl + 1)
        // 清空后仍按当前模式继续，绝不切回裸行（I1）
        continue
      }

      if (!this.decided) {
        // 启动窗口：前 4 字节决定后续用哪种模式
        if (this.buf.length < 4) break
        this.decided = true
        this.framed = /^[0-9a-f]{4}$/.test(this.buf.subarray(0, 4).toString('latin1'))
      }

      if (!this.framed) {
        // 裸行兼容（仅启动窗口判定的裸行流）：按 \n 切
        const nl = this.buf.indexOf(0x0a)
        if (nl < 0) break
        out.push(this.buf.subarray(0, nl).toString('utf8'))
        this.buf = this.buf.subarray(nl + 1)
        continue
      }

      const head = this.buf.subarray(0, 4).toString('latin1')
      if (!/^[0-9a-f]{4}$/.test(head)) {
        // 帧模式下的噪声（流内偶发垃圾）：丢弃到下一个 \n 重新同步。
        // 找不到 \n 说明噪声还没吐完，等下一个 chunk —— 但不能无限等，由上面的缓冲上限兜底。
        const nl = this.buf.indexOf(0x0a)
        if (nl < 0) break
        this.discarded += nl + 1
        this.buf = this.buf.subarray(nl + 1)
        continue
      }

      const len = parseInt(head, 16)
      if (len > MAX_FRAME_LEN) {
        // 帧头荒谬（读错了）：丢 4 字节重新找下一个帧头，不无限等待
        this.discarded += 4
        this.buf = this.buf.subarray(4)
        continue
      }

      const payloadStart = 4
      if (len === 0) {
        out.push('')
        this.buf = this.buf.subarray(payloadStart)
        continue
      }

      // 逐字节数逻辑长度：\r 后紧跟 \n 时该 \r 不计入；其余字节（含真正的 \n）各计 1。
      // 关键：\r 落在缓冲区末尾时无法判断，必须先等下一个 chunk（C1）。
      let logical = 0
      let end = -1
      let needMore = false
      for (let i = payloadStart; i < this.buf.length; i++) {
        if (this.buf[i] === 0x0d) {
          if (i + 1 === this.buf.length) {
            // 末尾的 \r：它后面是不是 \n 还不知道，等下一块
            needMore = true
            break
          }
          if (this.buf[i + 1] === 0x0a) continue
        }
        logical += 1
        if (logical === len) {
          end = i
          break
        }
      }
      if (needMore || end < 0) break

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

/** adb devices -l 里的 model:<值>；adb 把型号里的空格写成下划线，这里还原。 */
function parseModel(rest: string): string | undefined {
  const m = /(?:^|\s)model:(\S+)/.exec(rest)
  if (m === null) return undefined
  return m[1].replace(/_/g, ' ')
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
 * 空格式（adb devices -l：serial<多个空格>state product:… model:…）先取第一个 token 当 serial，
 * 剩下按空白切出状态词，并解析出 model（I3）。
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
    const model = parseModel(rest)
    // 无 model 时不写这个字段：写成 undefined 会让 'model' in row 为 true，
    // 上层做「有没有型号」判断时会被误导。
    rows.push(model === undefined
      ? { serial, status: toStatus(stateWord), transport }
      : { serial, status: toStatus(stateWord), transport, model })
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
  /** 仅在测试注入：替换 spawn(adbPath, args)，用于断言轮询真的带了 -l。 */
  spawnDevices?: (args: string[]) => ChildProcess
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
  spawnDevices?: (args: string[]) => ChildProcess
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
 *
 * 红线三：轮询必须有 in-flight 守卫（I2）。单次 adb devices 慢于轮询周期时，
 * 没有守卫会无限叠加并发子进程，既突破全局并发上限，又会让晚到的旧快照覆盖新快照。
 */
export class DeviceTracker {
  private readonly opts: ResolvedTrackerOptions
  private decoder = new FrameDecoder()
  private child: ChildProcess | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private currentMode: TrackerMode = 'idle'
  private stopped = false
  /** 上一轮轮询是否还没结束（I2）。 */
  private polling = false
  /** gc 定时器是不是本跟踪器起的；只有自己起的才由自己停。 */
  private ownsGc = false
  /** 已经补过型号的 serial（避免每帧都多跑一条 adb devices -l）。 */
  private enriched = new Set<string>()
  /** 补型号是否还在跑（同一时刻只允许一条，不得与自己的上一次重叠）。 */
  private enriching = false
  /** 补型号途中又有新设备报到：等这一次跑完再补一轮。 */
  private enrichPending = false

  constructor(options: DeviceTrackerOptions) {
    this.opts = {
      adbPath: options.adbPath,
      manager: options.manager,
      spawnTrack: options.spawnTrack,
      pollDevices: options.pollDevices,
      spawnDevices: options.spawnDevices,
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
      // 豁免「所有 adb 调用必须带 -s serial」：track-devices 本身就是设备枚举命令，
      // 它要列出全部设备，不可能也不应该带 -s serial（带了就只能看到一台）。
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
    // I2：上一轮没结束就直接跳过，避免慢 adb devices 无限叠加并发子进程，
    // 也避免晚到的旧快照覆盖新快照导致设备状态回退。
    if (this.polling) return
    this.polling = true
    try {
      const stdout = this.opts.pollDevices !== undefined
        ? await this.opts.pollDevices()
        : await this.runDevices()
      if (this.stopped) return
      this.applyPayload(stdout)
    } catch {
      // 单次轮询失败不是故障：下一周期再试，不值得把整个跟踪器停掉
    } finally {
      this.polling = false
    }
  }

  /** 一次 adb devices -l。必须登记子进程，退出时才会被回收。 */
  private runDevices(): Promise<string> {
    // 豁免「所有 adb 调用必须带 -s serial」：devices 是全局枚举命令，列出所有设备；
    // 带 -s 只能看到那一台，反而失去轮询的意义。
    // 用 -l 而不是裸 devices：设备栏要显示型号，-l 才有 model:（I3）。
    const args = ['devices', '-l']
    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = this.opts.spawnDevices !== undefined
          ? this.opts.spawnDevices(args)
          : spawn(this.opts.adbPath, args, {
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
    const rows = parseDeviceLines(payload)
    this.opts.manager.applySnapshot(rows)

    // 裁决 9：track-devices 的负载只有「serial\tstate」，【没有 model】——
    // 型号只出现在 adb devices -l 里。而生产路径优先走 track-devices，
    // 不补这一步设备栏就永远只能显示 serial 后 4 位。
    // 只对「新出现且还没补过」的设备补一次：track 每次变化都重发全量，
    // 每帧都补会把 adb 命令打成每秒几十条。
    // 设备消失（空帧或不在表里）时先清掉记号：重插回来型号可能变了，要重新补。
    // 这一步必须在下面的早退之前做 —— 空帧时 missing 一定为空，放在后面永远执行不到。
    const present = new Set(rows.map((row) => row.serial))
    for (const serial of [...this.enriched]) {
      if (!present.has(serial)) this.enriched.delete(serial)
    }

    // 只有 track 模式才需要补：轮询模式本来就是 adb devices -l，model 已经在 rows 里了。
    // 这一条也是硬约束 —— 轮询模式下再调一次 pollDevices 会与轮询循环并发，
    // 直接破坏任务 4 验收过的「in-flight 守卫：单次 devices 不叠加」不变量。
    if (this.currentMode !== 'track') return
    // 型号还可能在会话里（断线重插时 DeviceManager 会复用旧会话的元数据）——
    // 已经有就不必再跑一次 adb devices，否则每次拔插都多一条命令。
    const missing = rows.filter((row) =>
      row.model === undefined &&
      !this.enriched.has(row.serial) &&
      this.opts.manager.get(row.serial)?.model === undefined)
    if (missing.length === 0) return
    for (const row of missing) this.enriched.add(row.serial)
    this.requestEnrich()
  }

  /**
   * 排队一次补型号。
   *
   * 单飞（single-flight）：补型号是异步的，而 track 的一帧里可能同时冒出 3 台新设备；
   * 不合并就会并发跑 3 条 adb devices。跑的过程中又有设备报到就记一个 pending，
   * 等这一次结束再补一轮（只补一轮，避免「永远补不到型号」时无限自旋）。
   */
  private requestEnrich(): void {
    if (this.enriching) {
      this.enrichPending = true
      return
    }
    this.enriching = true
    void this.enrichModels().finally(() => {
      this.enriching = false
      if (!this.enrichPending || this.stopped) return
      this.enrichPending = false
      this.requestEnrich()
    })
  }

  /**
   * 补型号：跑一次 adb devices -l，把 model 合并进会话表。
   * 失败不影响设备发现 —— 型号只是展示字段，绝不能因为它挂掉整条 track 流。
   */
  private async enrichModels(): Promise<void> {
    let stdout: string
    try {
      stdout = this.opts.pollDevices !== undefined
        ? await this.opts.pollDevices()
        : await this.runDevices()
    } catch {
      // 补不到型号不是故障：下一帧如果设备重新出现会再试
      for (const serial of [...this.enriched]) {
        if (this.opts.manager.get(serial)?.model === undefined) this.enriched.delete(serial)
      }
      return
    }
    if (this.stopped) return
    for (const row of parseDeviceLines(stdout)) {
      if (row.model === undefined) continue
      this.opts.manager.upsert(row)
    }
  }
}