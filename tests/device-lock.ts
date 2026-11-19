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
