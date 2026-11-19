import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AdbClient, killAllAdbChildren } from '../electron/adb/client'

/*
 * 审查 I1（第 2 轮）：client.ts 的定时器泄漏。
 *
 * 根因：一次改动留下了两段 setTimeout 赋值共用同一个 timer 变量，
 * 后一段把前一段覆盖 -> 前一个永远不会被 clearTimeout，也从未 unref，
 * 于是每条 adb 命令泄漏一个定时器（复审实测 HANDLES 单调增长 [1,2,3,3,4]）。
 * 对传输路径尤其致命：TRANSFER_TIMEOUT_MS 是 6 小时，泄漏的 Timer 会挂 6 小时。
 *
 * ===== 检测手段的选择（踩过一次坑，记下来）=====
 * 最初用 process._getActiveHandles() 数 handle，结果**它看不到 setTimeout**：
 * Node 的 Timers 不是 libuv handle，实测连开 3 个 60s 定时器该数组长度纹丝不动
 * （只有 2 个 Socket）。用它写的用例是**假护栏** ——
 * 我故意注入一个泄漏定时器做变异，用例照样全绿（当场抓到并推翻了自己）。
 *
 * 正确手段是 process.getActiveResourcesInfo()：定时器在里面表现为 'Timeout'。
 * 实测：开 1 个多一个 'Timeout'，clear 后消失。下面第一条用例专门钉住这个前提，
 * 避免将来 Node 改掉这个行为时整套用例变成假护栏而不自知。
 */

const isWin = process.platform === 'win32'
const SHELL = isWin ? 'cmd' : 'bash'

function echoArgs(word: string): string[] {
  return isWin ? ['/c', 'echo', word] : ['-c', 'echo ' + word]
}

/** 当前活动定时器数量（Timeout 资源）。 */
function activeTimeouts(): number {
  const proc = process as unknown as { getActiveResourcesInfo?: () => string[] }
  const info = proc.getActiveResourcesInfo?.() ?? []
  return info.filter((name) => name === 'Timeout').length
}

afterEach(() => { killAllAdbChildren() })

describe('client 定时器不泄漏', () => {
  it('检测手段本身有效：能数到定时器（否则整条用例是假护栏）', async () => {
    const before = activeTimeouts()
    const t1 = setTimeout(() => {}, 60_000)
    const t2 = setTimeout(() => {}, 60_000)
    expect(activeTimeouts()).toBe(before + 2)
    clearTimeout(t1)
    clearTimeout(t2)
    expect(activeTimeouts()).toBe(before)
  })

  it('连续执行 12 条命令后活动定时器数不增长', async () => {
    const client = new AdbClient('ABC123')
    await client.run(echoArgs('warm'), { adbPath: SHELL, timeoutMs: 10_000 })
    await new Promise((r) => setTimeout(r, 100))
    const baseline = activeTimeouts()

    for (let i = 0; i < 12; i++) {
      await client.run(echoArgs('ok' + i), { adbPath: SHELL, timeoutMs: 10_000 })
    }
    await new Promise((r) => setTimeout(r, 100))

    // 严格相等：每条命令都必须把自己的超时定时器清干净。泄漏则是 baseline + 12。
    expect(activeTimeouts()).toBe(baseline)
  }, 60_000)

  it('abort 路径也不泄漏（定时器在 cancel 时必须被清掉）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'task8-leak-'))
    try {
      // 必须让子进程真的还在跑：echo 几十毫秒就结束，abort 时往往已经 close，
      // 走的就不是 abort 路径而是正常 close（会变成假绿）。
      const script = path.join(dir, 'long.mjs')
      writeFileSync(script, 'setInterval(() => {}, 1000)')
      const args = isWin
        ? ['/c', process.execPath, script]
        : ['-c', 'exec "' + process.execPath + '" "' + script + '"']

      const client = new AdbClient('ABC123')
      const warm = await client.run(echoArgs('warm'), { adbPath: SHELL, timeoutMs: 10_000 })
      expect(warm.code).toBe(0)
      await new Promise((r) => setTimeout(r, 100))
      const baseline = activeTimeouts()

      for (let i = 0; i < 4; i++) {
        const controller = new AbortController()
        const pending = client.run(args, { adbPath: SHELL, timeoutMs: 60_000, signal: controller.signal })
        await new Promise((r) => setTimeout(r, 150))
        controller.abort()
        await expect(pending).rejects.toThrow()
      }
      await new Promise((r) => setTimeout(r, 100))

      // 每条 abort 泄漏一个 6 万毫秒定时器的话，这里是 baseline + 4
      expect(activeTimeouts()).toBe(baseline)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
