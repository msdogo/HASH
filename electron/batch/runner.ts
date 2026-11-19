import type { BatchItemResult } from '../../src/shared/batch'
import { toErrorCode } from '../../src/shared/errors'

/**
 * 批量执行器（任务 10 / R3 / R4）。
 *
 * 只有三件事，且每一件都有明确的失败历史：
 *
 * 1. **按下标回填**（R4）：计划文档里那段 out.push() 在并发下顺序不确定，
 *    用户看到的结果行会乱跳，甚至与设备对不上号。这里 out[index] = …，
 *    下标即入参下标 —— 这一点是本文件最重要的一条不变量。
 * 2. **失败隔离**：一台设备抛异常不许中断整批。否则前面成功的结果全丢，
 *    而后台已经跑完的 adb 命令产生了副作用（截图落盘、应用装上），用户无从知道。
 * 3. **并发上限**：车道数 = min(concurrency, serials.length)，既不超过上限，
 *    也不空转（3 台设备开 16 条车道只会让每条车道空跑一轮）。
 *
 * 关于 worker 的返回值：成功时调用方可选带出「文件名 / 已入队数量 / 命令输出摘要」。
 * 这里用**运行期收窄**读取 detail / truncated，而不是靠类型断言 ——
 * 签名是泛型的，传进来的是任意值，认不出就当没有附加信息。
 */

/** 批量并发上限（R3）。常量，**不接设置项**（设置项是给传输队列用的）。 */
export const BATCH_CONCURRENCY = 3

/** worker 成功时可选带出的附加信息。 */
export interface BatchWorkerOutcome {
  detail?: string
  truncated?: boolean
}

/** 运行期收窄：只读已知字段，其余忽略（绝不断言 worker 返回了什么类型）。 */
function outcomeOf(value: unknown): BatchWorkerOutcome {
  if (typeof value !== 'object' || value === null) return {}
  const record = value as Record<string, unknown>
  const outcome: BatchWorkerOutcome = {}
  if (typeof record.detail === 'string') outcome.detail = record.detail
  // 显式的 false 也要保留：界面据此区分「完整输出」与「旧版本没给这个字段」
  if (typeof record.truncated === 'boolean') outcome.truncated = record.truncated
  return outcome
}

/**
 * 跑一批设备。
 *
 * @param serials 设备列表。同一 serial 重复出现时**按出现次数各跑一次**
 *                （不静默去重：去重会让「结果长度 === 入参长度」这条不变量失效，用户对不上号）。
 * @returns 长度恒等于 serials、下标与入参一致的结果数组；serials 为空返回 []（不抛）。
 */
export async function runBatch<T = unknown>(
  serials: readonly string[],
  worker: (serial: string) => Promise<T | void>,
  concurrency: number = BATCH_CONCURRENCY,
): Promise<BatchItemResult[]> {
  const out: BatchItemResult[] = []
  if (serials.length === 0) return out

  /*
   * 车道数 = min(上限, 任务数)。
   *
   * 下限取 1：concurrency 传 0 / 负数 / NaN 时不能一条车道都不开
   * （那会静默返回空数组，调用方以为「都跑完了」）。
   */
  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : BATCH_CONCURRENCY
  const lanes = Math.min(limit, serials.length)

  /*
   * next 是共享游标：每条车道先同步取号再 await。
   * 取号与 await 之间没有 await 点，所以两条车道不可能拿到同一个下标。
   */
  let next = 0
  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= serials.length) return
      const serial = serials[index]
      try {
        const value = await worker(serial)
        out[index] = { serial, ok: true, ...outcomeOf(value) }
      } catch (err) {
        // 任何抛出（Error(E_*)、裸字符串、TypeError）都折算成**这一项**的失败
        out[index] = { serial, ok: false, code: toErrorCode(err) }
      }
    }
  }

  await Promise.all(Array.from({ length: lanes }, () => lane()))
  return out
}
