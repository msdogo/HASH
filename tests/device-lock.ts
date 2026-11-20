/**
 * 设备锁的**判定逻辑**（从 tests/batch-real.test.ts 抽出来的纯函数）。
 *
 * ===== 为什么单独成文件（第 5 轮 N21）=====
 * 第 4 轮把「pid 是否存活」写进了 batch-real.test.ts 的私有函数里，
 * 复审判定：删掉 `!pidAlive(record.pid)` 这一支，**没有任何测试变红** ——
 * 因为真机用例整组被 skip 或者要靠环境才能跑到，锁逻辑本身是不可测的。
 *
 * 所以把判定抽成纯函数：`alive` 作为**参数注入**，测试传 () => true / () => false
 * 就能覆盖全部四个分支，不必真的去 kill 一个 pid（那会误伤机器上的真实进程）。
 *
 * 红线：这里只做判定，不碰文件系统、不碰 process.kill、不读时间 ——
 * 全是纯输入到纯输出，所以可以在 node 里直接断言。
 */

import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** 锁文件内容：谁持着它、从什么时候开始。 */
export interface LockRecord {
  pid: number
  startedAt: number
}

/**
 * 这个锁是不是「陈旧」的（= 可以安全接管）。
 *
 * ===== 判据只有一条：持有者死了吗（第 5 轮 N20）=====
 * 第 4 轮这里是三项 OR：`record === null || !pidAlive(pid) || age > 15min`。
 * 复审当场指出：**TTL 是无条件的，会把活着的锁抢走**。真机用例本来就可能跑很久，
 * 一个持锁 16 分钟的合法进程会被后来者 rm 掉锁并夺走设备 ——
 * N14 的并发症（两个进程互删在途临时文件）原封不动地回来了。
 *
 * 现在只保留两条，且都关于「持有者还在不在」：
 *   1. record 为 null（空文件 / 半个 JSON / 旧格式）→ 没人能证明它活着 → 接管；
 *   2. pid 不存活 → 明确死了 → 接管。
 *
 * **进程活着时，年龄毫无意义**：跑 5 小时的真机用例仍然是合法持有者。
 *
 * 代价（明确接受）：pid 复用 —— 旧锁的 pid 恰好被一个新进程占用 —— 会让锁永不释放。
 * 但那是极小概率，且后果只是「需要手工删一个文件」；
 * 反过来把活锁抢走，后果是并发破坏设备状态。两害相权，取前者。
 */
export function isStaleLock(record: LockRecord | null, alive: (pid: number) => boolean): boolean {
  if (record === null) return true
  return !alive(record.pid)
}

/*
 * ===== 2026 实装部分（N17：四个真机文件必须互斥）=====
 *
 * 上面是纯判定（必须有测试、不能碰 fs）。下面是它的两个「不纯」搭档：
 * 抢锁（文件系统 + process.kill）与取设备号（child_process）。
 *
 * 它们也放在这里，理由只有一条：**锁文件名只允许有一处定义**。
 *
 * N17 的根因就是「文件名只对 batch-real 成立」：
 * batch-real 用 `adbfm-batch-real-<serial>.lock`，另外三个真机文件（drag/ops/transfer）
 * 根本没有锁，于是默认并行的 `npx vitest run` 里四个文件同时抢同一台设备，
 * 13 条红、而 `--fileParallelism=false` 全绿 —— 生产代码无缺陷，是调度。
 *
 * 所以文件名统一成 `adbfm-device-<serial>.lock`（不带任何文件名字样）：
 * serial 相同 → 锁文件相同 → 四个文件互斥。
 *
 * `label` **只进日志前缀，绝不进文件名** —— 一旦进了文件名就退化成
 * 「每个文件一把锁」，那正是 N17 本身。
 */

/** 锁文件名前缀（唯一一处定义；测试用 lockPathOf 造陈旧锁，不复制这个字符串）。 */
export const DEVICE_LOCK_PREFIX = 'adbfm-device-'

/** 设备的锁文件路径：只由 serial 决定，与调用它的测试文件无关。 */
export function lockPathOf(serial: string): string {
  const safe = serial.replace(/[^A-Za-z0-9._-]/g, '_')
  return path.join(tmpdir(), DEVICE_LOCK_PREFIX + safe + '.lock')
}

/** 读锁内容；读不懂（旧格式 / 空文件 / 半个 JSON）一律视为陈旧。 */
export function readLockRecord(lockPath: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const { pid, startedAt } = parsed as Partial<LockRecord>
    if (typeof pid !== 'number' || typeof startedAt !== 'number') return null
    return { pid, startedAt }
  } catch {
    return null
  }
}

/** 持锁进程还活着吗（signal 0 只探测，不发送）。 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 抢设备锁；抢不到时**判断持有者是否已死**，死了就接管。
 *
 * 【N15】只写 wx、只在 afterAll unlink 的版本有个坑：进程崩溃或 Ctrl-C 后锁永久留下，
 * 之后每次跑都整组静默 skip，而套件仍然是绿的
 * （复审实测：造一个陈旧锁 → 5 skipped、全量 1143 passed | 6 skipped、EXIT=0）。
 * **静默通过比失败更危险**：失败有人看，静默跳过没人看。
 * 所以判据只有一条：**持有者死了吗**（isStaleLock）。
 *
 * 【N20】曾经还有一个「超过 15 分钟即接管」的 TTL 分支，而且是无条件 OR ——
 * 不看 pid 是否还活着，会**抢走活锁**：真机用例本来就可能跑很久，
 * 一个持锁 16 分钟的合法进程被后来者 rm 掉锁、夺走设备，N14 的并发症原封不动地回来。
 * 现在整条删除：进程活着时年龄毫无意义，跑 5 小时的用例仍然是合法持有者。
 *
 * @param label 只用于 console.warn 前缀（`[batch-real]` / `[ops-real]` …），便于看清谁在接管。
 * @returns 释放函数；抢不到返回 null。
 */
export function acquireDeviceLock(serial: string, label: string): (() => void) | null {
  const lockPath = lockPathOf(serial)
  const release = (): void => { try { unlinkSync(lockPath) } catch { /* 已被清掉 */ } }
  const claim = (): (() => void) => {
    // wx：文件已存在即失败 —— 跨进程互斥。建文件与写内容不能合并成一个原子操作，
    // 所以「先 wx 占位、再写 {pid, startedAt}」；读到空内容时 readLockRecord 返回 null，
    // 会被当成陈旧锁（写入方要么正在写、要么已崩溃，两者都不该长期阻塞后来者）。
    closeSync(openSync(lockPath, 'wx'))
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8')
    return release
  }

  try {
    return claim()
  } catch {
    // 抢不到：下面判断持有者是否还活着
  }

  const record = readLockRecord(lockPath)
  if (!isStaleLock(record, pidAlive)) return null

  console.warn(
    '[' + label + '] 接管陈旧设备锁：' + lockPath
      + '（' + (record === null ? '内容不可解析' : 'pid=' + record.pid + ' 已不存活') + '）',
  )
  try {
    rmSync(lockPath, { force: true })
    return claim()
  } catch {
    return null
  }
}

/**
 * 跳过原因：三种必须能区分（照 batch-real 原来的措辞）。
 *
 * 为什么要在这条路径上花力气：**静默跳过比失败更危险**。
 * 本项目已经吃过一次亏 —— 陈旧锁导致整组静默 skip 而套件仍然全绿。
 * 三个真机文件此前把「没有设备」和「设备被别的进程占用」混成一句话，
 * 排查时看不出到底缺设备还是撞锁。
 */
export function deviceSkipReason(serial: string | null, lockRelease: (() => void) | null): string {
  if (serial !== null && lockRelease === null) {
    return '设备 ' + serial + ' 正被另一个进程独占（跨进程锁 ' + DEVICE_LOCK_PREFIX + '*.lock），避免两边互相删临时文件'
  }
  const wanted = process.env.ADB_TEST_SERIAL
  if (wanted !== undefined && wanted !== '') {
    return 'ADB_TEST_SERIAL=' + wanted + ' 不在 device 状态（可能是 offline/unauthorized/已拔掉）'
  }
  return '没有找到在线设备（adb devices 里没有 device 状态的设备）'
}

/** 完整的跳过日志行（`[batch-real] 跳过真机用例：…`），模块顶层直接 console.log。 */
export function deviceSkipMessage(
  label: string,
  serial: string | null,
  lockRelease: (() => void) | null,
): string {
  return '[' + label + '] 跳过真机用例：' + deviceSkipReason(serial, lockRelease)
}

/**
 * 取一台**当前**处于 device 状态的设备。
 *
 * 四个真机文件此前各自抄了一份 `resolveSerial()`，而且**行为不一致**：
 * batch-real 先跑 `adb devices` 再把 ADB_TEST_SERIAL 与在线列表比对（不在线 → null），
 * 另外三个先认 ADB_TEST_SERIAL（不在线也照用）。后者的后果是：
 * 设备 offline 时 beforeAll 直接抛 "device not found"，整个文件红成一片，
 * 看起来像实现坏了，而不是「设备不在」。
 *
 * 统一成 batch-real 的语义（更严格、且跳过原因说得清）：
 * 先 `adb devices` 取在线列表，再按 ADB_TEST_SERIAL 过滤，否则取第一台。
 * 设备号绝不硬编码。
 *
 * @param adbPath 缺省取 ADB_PATH 环境变量，再退到 'adb'。
 */
export function resolveSerial(adbPath?: string): string | null {
  const adb = adbPath ?? process.env.ADB_PATH ?? 'adb'
  let online: string[] = []
  try {
    const out = execFileSync(adb, ['devices'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    for (const line of out.split(/\r?\n/)) {
      const match = /^(\S+)\s+device\b/.exec(line.trim())
      if (match !== null) online.push(match[1])
    }
  } catch {
    return null
  }
  const fromEnv = process.env.ADB_TEST_SERIAL
  if (fromEnv !== undefined && fromEnv !== '') {
    return online.includes(fromEnv) ? fromEnv : null
  }
  return online[0] ?? null
}

