import { describe, it, expect } from 'vitest'
import {
  resultRows,
  runBatchRequest,
  runningState,
  type BatchFlowApi,
  type BatchFlowState,
  type BatchResponse,
} from '../src/shared/batch-flow'
import type { BatchItemResult } from '../src/shared/batch'

/*
 * 批量流程的行为测试（复审 C1 的替代品）。
 *
 * 修前这条防线是 ui-contract 里一句 expect(source).toContain('window.api.batch.shell(')
 * —— 注释就能满足它（审查 V2 实测：删掉真调用、只留一行注释，全套 1063 个用例仍全绿）。
 *
 * 现在改成真行为：注入一个假后端，驱动 runBatchRequest，断言
 *   - 四个 action 各自调用到**哪一个**后端方法、带什么载荷；
 *   - 后端返回 ok:false / 抛异常 / 空结果时，落下来的状态是什么；
 *   - running 在任何出口都复位（否则按钮永远禁用）。
 *
 * 这样把「批量执行命令这个功能整个删掉」是**必然红**的（见报告 §C1 变异验证）。
 */

interface Call { method: string; payload: unknown }

/** 造一个假后端：记录调用，并按给定响应作答（Error 表示抛异常）。 */
function fakeApi(response: BatchResponse | Error): { calls: Call[]; api: BatchFlowApi } {
  const calls: Call[] = []
  const answer = async (method: string, payload: unknown): Promise<BatchResponse> => {
    calls.push({ method, payload })
    if (response instanceof Error) throw response
    return response
  }
  return {
    calls,
    api: {
      screenshot: (input) => answer('screenshot', input),
      install: (input) => answer('install', input),
      push: (input) => answer('push', input),
      shell: (input) => answer('shell', input),
    },
  }
}

const OK: BatchItemResult = { serial: 'S1', ok: true }

/** 跑一次并把落下来的状态全收集起来（第一条应是 running=true，最后一条是终态）。 */
async function run(
  response: BatchResponse | Error,
  request: Parameters<typeof runBatchRequest>[1],
): Promise<{ calls: Call[]; states: BatchFlowState[]; code: string | null }> {
  const { calls, api } = fakeApi(response)
  const states: BatchFlowState[] = []
  const code = await runBatchRequest({ api, apply: (state) => { states.push(state) } }, request)
  return { calls, states, code }
}

describe('runBatchRequest：四个动作各自真的打到哪个后端方法（C1 的真护栏）', () => {
  it('screenshot → api.screenshot，载荷只含 serials', async () => {
    const { calls, states, code } = await run(
      { ok: true, data: { results: [OK] } },
      { action: 'screenshot', serials: ['S1', 'S2'], dstDir: 'C:/shots' },
    )
    expect(code).toBeNull()
    expect(calls).toEqual([{ method: 'screenshot', payload: { serials: ['S1', 'S2'], dstDir: 'C:/shots' } }])
    expect(states.at(-1)).toEqual({
      running: false, results: [OK], action: 'screenshot', error: null, notice: null,
    })
  })

  it('install → api.install，apkPath 原样透传', async () => {
    const { calls } = await run(
      { ok: true, data: { results: [OK] } },
      { action: 'install', serials: ['S1'], apkPath: 'C:/pkg/app.apk' },
    )
    expect(calls).toEqual([
      { method: 'install', payload: { serials: ['S1'], apkPath: 'C:/pkg/app.apk' } },
    ])
  })

  it('push → api.push，files 与 dstDir 都带上（缺一个后端就会报参数错）', async () => {
    const { calls } = await run(
      { ok: true, data: { results: [OK] } },
      { action: 'push', serials: ['S1'], files: ['C:/a.txt', 'C:/b.txt'], dstDir: '/sdcard/Download' },
    )
    expect(calls).toEqual([
      {
        method: 'push',
        payload: { serials: ['S1'], files: ['C:/a.txt', 'C:/b.txt'], dstDir: '/sdcard/Download' },
      },
    ])
  })

  it('shell → api.shell，命令逐字节透传（审查 V2 删掉的正是这一条）', async () => {
    const command = "ls -l '/sdcard/中文 目录'"
    const { calls } = await run(
      { ok: true, data: { results: [OK] } },
      { action: 'shell', serials: ['S1'], command },
    )
    expect(calls).toEqual([{ method: 'shell', payload: { serials: ['S1'], command } }])
    // 关键：command 是**真的传下去了**，不是被换成常量
    expect((calls[0].payload as { command: string }).command).toBe(command)
  })
})

describe('runBatchRequest：状态迁移（任何出口都要复位 running）', () => {
  it('先落一条 running=true 的初始态，再落终态', async () => {
    const { states } = await run(
      { ok: true, data: { results: [OK] } },
      { action: 'shell', serials: ['S1'], command: 'ls' },
    )
    expect(states[0]).toEqual(runningState('shell'))
    expect(states).toHaveLength(2)
  })

  it('后端 ok:false → 错误落地、running 复位、返回该错误码', async () => {
    const { states, code } = await run({ ok: false, error: 'E_BAD_ARGS' }, { action: 'shell', serials: ['S1'], command: 'ls' })
    expect(code).toBe('E_BAD_ARGS')
    expect(states.at(-1)).toMatchObject({ running: false, error: 'E_BAD_ARGS', results: null })
  })

  it('后端抛异常 → 折算成 E_UNKNOWN，且 running 一定复位（否则按钮永远禁用）', async () => {
    const { states, code } = await run(new Error('ipc blew up'), { action: 'shell', serials: ['S1'], command: 'ls' })
    expect(code).toBe('E_UNKNOWN')
    expect(states.at(-1)).toMatchObject({ running: false, error: 'E_UNKNOWN' })
  })

  it('空结果（用户取消选择框）→ notice 提示，不是错误', async () => {
    const { states, code } = await run({ ok: true, data: { results: [] } }, { action: 'screenshot', serials: ['S1'], dstDir: 'C:/shots' })
    expect(code).toBeNull()
    expect(states.at(-1)).toMatchObject({ running: false, notice: 'batch.pickCancelled', error: null, results: null })
  })

  it('成功时把 action 记进状态（结果文案要按动作解释 detail）', async () => {
    for (const request of [
      { action: 'screenshot' as const, serials: ['S1'], dstDir: 'C:/shots' },
      { action: 'install' as const, serials: ['S1'], apkPath: 'C:/a.apk' },
      { action: 'push' as const, serials: ['S1'], files: ['C:/a'], dstDir: '/sdcard' },
      { action: 'shell' as const, serials: ['S1'], command: 'ls' },
    ]) {
      const { states } = await run({ ok: true, data: { results: [OK] } }, request)
      expect(states.at(-1)?.action).toBe(request.action)
    }
  })
})

describe('resultRows：结果矩阵的行（C1 的第三个替代品）', () => {
  it('null 结果 → 空数组（没有批量跑过时不渲染矩阵）', () => {
    expect(resultRows(null)).toEqual([])
  })

  it('逐项映射，且 truncated 归一成布尔（缺省 false）', () => {
    expect(resultRows([
      { serial: 'A', ok: true, detail: 'x' },
      { serial: 'B', ok: false, code: 'E_TIMEOUT' },
      { serial: 'C', ok: true, detail: 'y', truncated: true },
    ])).toEqual([
      { serial: 'A', ok: true, detail: 'x', truncated: false },
      { serial: 'B', ok: false, code: 'E_TIMEOUT', truncated: false },
      { serial: 'C', ok: true, detail: 'y', truncated: true },
    ])
  })

  it('顺序与入参一致（R4：同一 serial 重复也要逐行保留）', () => {
    const rows = resultRows([
      { serial: 'S1', ok: true },
      { serial: 'S1', ok: false, code: 'E_TIMEOUT' },
      { serial: 'S2', ok: true },
    ])
    expect(rows.map((row) => [row.serial, row.ok])).toEqual([
      ['S1', true],
      ['S1', false],
      ['S2', true],
    ])
  })
})
