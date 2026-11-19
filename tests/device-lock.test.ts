import { describe, it, expect } from 'vitest'
import { isStaleLock } from './device-lock'
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
