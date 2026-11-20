import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEVICE_LOCK_PREFIX,
  acquireDeviceLock,
  deviceSkipReason,
  isStaleLock,
  lockPathOf,
  readLockRecord,
} from './device-lock'
import type { LockRecord } from './device-lock'

/*
 * ===== 第 5 轮 N21：锁存活判定终于有测试了 =====
 *
 * 第 4 轮这三行判定写在 batch-real.test.ts 的私有函数里，复审判定：
 * 删掉 `!pidAlive(...)` 这一支**没有任何测试变红**（真机用例要么整组 skip、
 * 要么依赖环境）。把一个没有任何测试的行为判据留在「测试文件」里，本身就矛盾 ——
 * 测试文件里的逻辑同样需要被测试。
 *
 * isStaleLock 把 alive 做成参数注入，所以下面四条既不碰 process.kill、
 * 也不会误杀机器上的真实进程。
 *
 * 第 4 条的 **pid 存活但 age 很大** 正是 N20 的回归锁：
 * 第 4 轮的实现是 `|| age > 15min`，那条会让这里返回 true（= 抢走活锁）。
 */

const NOW = 1_700_000_000_000
const HOUR = 60 * 60_000

function record(pid: number, startedAt: number): LockRecord {
  return { pid, startedAt }
}

describe('isStaleLock：设备锁的陈旧判定（N20 / N21）', () => {
  it('record 为 null（空文件 / 半个 JSON / 旧格式）→ 陈旧', () => {
    expect(isStaleLock(null, () => true)).toBe(true)
    expect(isStaleLock(null, () => false)).toBe(true)
  })

  it('pid 不存活 → 陈旧（崩溃 / Ctrl-C 的典型形态，该被接管）', () => {
    const alive = (pid: number): boolean => pid !== 999999
    expect(isStaleLock(record(999999, NOW), alive)).toBe(true)
  })

  it('pid 存活且刚拿到锁 → 不陈旧（后来者必须让位）', () => {
    expect(isStaleLock(record(4321, NOW), () => true)).toBe(false)
  })

  it('【N20 回归锁】pid 存活但锁已握了很久 → 仍然不陈旧', () => {
    /*
     * 这是本轮的核心断言。真机用例可能跑很久；一个持锁 5 小时的进程
     * 依然是**合法持有者**，后来者无权接管。
     *
     * 第 4 轮的 `|| age > 15min` 会让这条返回 true，于是后来者 rm 掉活锁并
     * 抢走设备 —— N14 的并发症（两个进程互删在途临时文件）重新打开。
     */
    const longHeld = record(4321, NOW - 5 * HOUR)
    expect(isStaleLock(longHeld, () => true)).toBe(false)
    // 对照：同一个 pid 死掉之后，同样的年龄就该接管
    expect(isStaleLock(longHeld, () => false)).toBe(true)
  })

  it('判定只看 pid 存活，与 startedAt 的取值无关（年龄不参与）', () => {
    const ages = [0, 1, HOUR, 24 * HOUR, 365 * 24 * HOUR]
    for (const age of ages) {
      expect(isStaleLock(record(4321, NOW - age), () => true), 'age=' + age).toBe(false)
      expect(isStaleLock(record(4321, NOW - age), () => false), 'age=' + age).toBe(true)
    }
  })
})

/*
 * ===== N17：互斥必须是**行为**证明出来的 =====
 *
 * 这一组的每一条都在真实文件系统上抢真锁（tmpdir 下的 adbfm-device-*.lock），
 * 并且自己清理。它们要证明的不是「源码里有某个字符串」，
 * 而是「同一 serial 抢两次，第二次拿不到」—— 后者才是四个真机文件互斥的原因。
 *
 * 变异验证（见 device-lock-report.md）：把锁文件名改成带文件名字样的前缀，
 * 下面「不同 label 也必须互斥」这条立刻红。
 */

/** 本组用的 serial：足够特别，不会与真实设备或其残留撞上。 */
const TEST_SERIAL = 'ADBfm-lock-unit-9Z'

/** 每条用例结束都把锁清掉：失败时也不留垃圾（本项目硬要求）。 */
afterEach(() => {
  rmSync(lockPathOf(TEST_SERIAL), { force: true })
})

describe('acquireDeviceLock：跨文件互斥（N17 的行为证明）', () => {
  it('首次获取返回释放函数，且锁文件确实已落盘', () => {
    const release = acquireDeviceLock(TEST_SERIAL, 'unit-first')
    expect(release).not.toBeNull()

    const lockPath = lockPathOf(TEST_SERIAL)
    expect(existsSync(lockPath)).toBe(true)
    const recordNow = readLockRecord(lockPath)
    expect(recordNow === null ? -1 : recordNow.pid).toBe(process.pid)
    release?.()
  })

  it('同进程第二次获取 → null（模拟另一个测试文件同时抢同一台设备）', () => {
    const first = acquireDeviceLock(TEST_SERIAL, 'unit-A')
    expect(first).not.toBeNull()
    // 第二个文件（另一个 label）也必须拿不到 —— label 不进文件名
    const second = acquireDeviceLock(TEST_SERIAL, 'unit-B')
    expect(second).toBeNull()
    first?.()
  })

  it('release 之后可以再次获取（锁不是一次性的）', () => {
    const first = acquireDeviceLock(TEST_SERIAL, 'unit-A')
    expect(first).not.toBeNull()
    first?.()
    expect(existsSync(lockPathOf(TEST_SERIAL))).toBe(false)
    const second = acquireDeviceLock(TEST_SERIAL, 'unit-B')
    expect(second).not.toBeNull()
    second?.()
  })

  it('陈旧锁（持有者 pid 已死）被接管，并打印 warn', () => {
    // 造一把「pid 不可能存在」的锁
    writeFileSync(lockPathOf(TEST_SERIAL), JSON.stringify({ pid: 999999, startedAt: NOW }), 'utf8')
    const release = acquireDeviceLock(TEST_SERIAL, 'unit-stale')
    expect(release).not.toBeNull()
    const recordNow = readLockRecord(lockPathOf(TEST_SERIAL))
    expect(recordNow === null ? -1 : recordNow.pid).toBe(process.pid)
    release?.()
  })

  it('【行为断言】锁文件名只由 serial 决定：两个不同 label 指向同一个文件', () => {
    /*
     * 这一条替代了曾经想写的 `expect(源码).not.toContain('adbfm-batch-real-')`：
     * 那是「源码文本断言」，本项目已经为它踩了 14 次坑，而且它证明不了互斥。
     *
     * 真正要证明的是：batch-real 与 ops-real 这类不同调用方，抢的是**同一个文件**。
     * 所以先拿一次锁、让另一个 label 抢 —— 抢不到，就说明它们指向同一个路径。
     */
    const first = acquireDeviceLock(TEST_SERIAL, 'batch-real')
    expect(first).not.toBeNull()

    const other = acquireDeviceLock(TEST_SERIAL, 'ops-real')
    // 若第二个也拿到了（变异 B：label 进了文件名），先把它放掉再断言，避免残留影响后续用例
    other?.()
    expect(other).toBeNull()

    const batchPath = lockPathOf(TEST_SERIAL)
    expect(batchPath.startsWith(path.join(tmpdir(), DEVICE_LOCK_PREFIX))).toBe(true)
    // 文件内容里只有持有者信息，**没有 label** —— 否则每个文件会各拿一把锁
    const raw = readFileSync(batchPath, 'utf8')
    expect(raw).not.toContain('batch-real')
    expect(raw).not.toContain('ops-real')
    first?.()
  })
})

describe('deviceSkipReason：三种跳过原因必须能区分', () => {
  it('有 serial 但没抢到锁 → 说明是跨进程独占', () => {
    const reason = deviceSkipReason(TEST_SERIAL, null)
    expect(reason).toContain(TEST_SERIAL)
    expect(reason).toContain('独占')
  })

  it('ADB_TEST_SERIAL 指定了但不在线 → 说明 serial 不可用', () => {
    const previous = process.env.ADB_TEST_SERIAL
    process.env.ADB_TEST_SERIAL = 'GHOST-SERIAL-LOCK'
    try {
      expect(deviceSkipReason(null, null)).toContain('GHOST-SERIAL-LOCK')
    } finally {
      if (previous === undefined) delete process.env.ADB_TEST_SERIAL
      else process.env.ADB_TEST_SERIAL = previous
    }
  })

  it('没有环境变量也没有设备 → 说明没有在线设备', () => {
    const previous = process.env.ADB_TEST_SERIAL
    delete process.env.ADB_TEST_SERIAL
    try {
      expect(deviceSkipReason(null, null)).toContain('没有找到在线设备')
    } finally {
      if (previous !== undefined) process.env.ADB_TEST_SERIAL = previous
    }
  })
})
