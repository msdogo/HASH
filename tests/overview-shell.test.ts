import { describe, it, expect } from 'vitest'
import { buildShellSubmitter } from '../src/shared/batch-shell'
import type { ShellSubmitOutcome, ShellSubmitPayload, ShellSubmitRequest } from '../src/shared/batch-shell'
import type { ShellSubmitPlan } from '../src/shared/batch-shell'

/*
 * ===== 第 4 轮 N10：用行为断言替换假护栏 =====
 *
 * 上一轮我在 tests/ui-contract.test.ts 里写了这条：
 *
 *   expect(read('src/pages/OverviewPage.tsx')).toContain('makeShellSubmitter(')
 *
 * 并声称它是「唯一可接受的静态断言」，因为「危险命令的提交必须经过这个入口」
 * 是结构性事实、渲染期观测不到。复审当场推翻：把那句真调用删掉、只留一行
 * 写着这串字符的**注释**，ui-contract 37 passed、全量 1148 passed、tsc 0。
 * 那是本项目第 8 次假护栏 —— 而且是我自己亲手写的那一条。
 *
 * 教训写在这里，避免再犯：**判据里出现「源码文本是否包含某串字符」就不是门禁**。
 * 任何断言都必须能对着一个**行为**说红或不红。
 *
 * 现在被测试的对象是 buildShellSubmitter 本身：组件把
 * （serial 列表、命令原文、仍存在的设备）交进去，它负责
 *   - 判断这条命令要不要确认（规格 §9.6）；
 *   - 危险命令用户取消时**绝不执行**；
 *   - 拼出 batch:shell 的完整载荷（action + serials + command）。
 * 下面每一条都只断言「谁被调了几次、拿到了什么」，不读任何源码。
 */

const DEVICES = [
  { serial: 'R5CY10S73DA', model: 'SM S9360' },
  { serial: '9N9CN2G0012A3P', model: 'SM S9360' },
]

interface Recorder {
  confirms: ShellSubmitPlan[]
  runs: ShellSubmitPayload[]
}

/** 按组件真实的构造形状造一个提交器：confirm / run 换成记录器。 */
function harness(answer: boolean): {
  submit: (request: ShellSubmitRequest) => ShellSubmitOutcome
  seen: Recorder
} {
  const seen: Recorder = { confirms: [], runs: [] }
  const submit = buildShellSubmitter({
    confirm: (plan) => { seen.confirms.push(plan); return answer },
    run: (payload) => { seen.runs.push(payload) },
  })
  return { submit, seen }
}

describe('buildShellSubmitter：组件真正的提交入口（N10 行为门禁）', () => {
  it('危险命令 + 用户取消 → 返回 cancelled，run 零调用（这条是安全底线）', () => {
    const { submit, seen } = harness(false)
    expect(submit({ serials: ['R5CY10S73DA'], command: 'reboot', devices: DEVICES })).toBe('cancelled')
    // 零调用必须是 []，不是「没断言」——复审要求写成 expect(...).toEqual([])
    expect(seen.runs).toEqual([])
    expect(seen.confirms).toHaveLength(1)
  })

  it('危险命令 + 用户确认 → 返回 submitted，run 恰好一次且载荷是完整的 shell 请求', () => {
    const { submit, seen } = harness(true)
    const serials = ['R5CY10S73DA', '9N9CN2G0012A3P']
    expect(submit({ serials, command: 'reboot', devices: DEVICES })).toBe('submitted')
    expect(seen.confirms).toHaveLength(1)
    expect(seen.runs).toHaveLength(1)
    // payload 必须是 batch:shell 的形状 —— action 判别字段 + 原样的 serials + 原文命令
    expect(seen.runs[0]).toEqual({ action: 'shell', serials, command: 'reboot' })
    expect(seen.runs[0].action).toBe('shell')
  })

  it('安全命令 → confirm 零调用，run 一次（每次 echo 都弹窗会让用户学会无脑点确定）', () => {
    const { submit, seen } = harness(false)
    expect(submit({ serials: ['R5CY10S73DA'], command: 'ls /sdcard', devices: DEVICES })).toBe('submitted')
    expect(seen.confirms).toEqual([])
    expect(seen.runs).toHaveLength(1)
    expect(seen.runs[0]).toEqual({ action: 'shell', serials: ['R5CY10S73DA'], command: 'ls /sdcard' })
  })

  it('命令为空 → 返回 empty，confirm 与 run 都零调用', () => {
    const { submit, seen } = harness(true)
    expect(submit({ serials: [], command: '', devices: DEVICES })).toBe('empty')
    expect(seen.confirms).toEqual([])
    expect(seen.runs).toEqual([])
  })

  it('【N23】空 serials 不在这里拦 —— 真正拦它的是 canSubmit（如实记录分工）', () => {
    /*
     * 第 4 轮这条用例的注释写的是「命令非空但没勾设备也不行 —— 会在 0 台设备上执行
     * 没有意义」，但它实际传的是 `command: ''`，命中的是「空命令」分支。
     * 复审实测 `{serials: [], command: 'echo hi'}` → 返回 'submitted' 并发出
     * `serials: []` 载荷 —— **注释在撒谎**。
     *
     * 真实分工：
     *   - 「一台设备都没勾就不许提交」拦在 src/shared/batch.ts 的 canSubmit
     *     （pickedCount <= 0 → 按钮 disabled），有 buttonStates 的单测；
     *   - buildShellSubmitter 只负责「这条命令要不要确认、取消后跑不跑、载荷长什么样」。
     *
     * 所以这里**不**加第二份 defensive 判断（两处判据会漂移），而是把真实行为
     * 写成断言，让后来者一眼看到边界在哪。命令为空由本函数拦（见上一条），
     * serials 为空**不由本函数拦** —— 这一条就是边界。
     */
    const { submit, seen } = harness(false)
    expect(submit({ serials: [], command: 'echo hi', devices: DEVICES })).toBe('submitted')
    expect(seen.confirms).toEqual([])
    expect(seen.runs).toEqual([{ action: 'shell', serials: [], command: 'echo hi' }])
  })

  it('确认框拿到可区分的设备标识（型号 + 尾号，N7）与台数', () => {
    const { submit, seen } = harness(false)
    submit({ serials: ['R5CY10S73DA', '9N9CN2G0012A3P'], command: 'reboot', devices: DEVICES })
    expect(seen.confirms).toHaveLength(1)
    const plan = seen.confirms[0]
    expect(plan.count).toBe('2')
    // 两台同型号：只靠型号分不出谁是谁，必须带 serial 尾号
    expect(plan.devices).toBe('SM S9360 (73DA)、SM S9360 (2A3P)')
    expect(plan.devices.split('、')).toHaveLength(2)
    expect(plan.needsConfirm).toBe(true)
    expect(plan.kind).toBe('reboot')
    expect(plan.command).toBe('reboot')
  })

  it('载荷里的 serials 与请求逐项相同（顺序原样传，结果矩阵按下标回填）', () => {
    const { submit, seen } = harness(true)
    const serials = ['B-SECOND', 'A-FIRST']
    submit({ serials, command: 'echo ok', devices: DEVICES })
    expect(seen.runs[0].serials).toEqual(['B-SECOND', 'A-FIRST'])
  })

  it('同一个 deps 造出的提交器可被重复调用，各次互不影响', () => {
    const { submit, seen } = harness(false)
    expect(submit({ serials: ['X'], command: 'reboot', devices: DEVICES })).toBe('cancelled')
    expect(submit({ serials: ['X'], command: 'echo ok', devices: DEVICES })).toBe('submitted')
    expect(seen.confirms).toHaveLength(1)
    expect(seen.runs).toEqual([{ action: 'shell', serials: ['X'], command: 'echo ok' }])
  })

  it('空命令即使勾了设备也不执行（与按钮禁用的双保险）', () => {
    for (const command of ['', '   ', '\n\t']) {
      const { submit, seen } = harness(true)
      expect(submit({ serials: ['R5CY10S73DA'], command, devices: DEVICES })).toBe('empty')
      expect(seen.confirms).toEqual([])
      expect(seen.runs).toEqual([])
    }
  })
})

/*
 * 决策层（submitShell / planShellSubmit）的既有用例在 tests/batch-shell.test.ts，
 * 这里不重复。本文件的职责只有一个：**组件真正调用的那个函数**有行为门禁。
 *
 * 明确未覆盖的一环（如实记录，不编造断言）：
 * OverviewPage 里 onClick={() => { ... buildShellSubmitter({...})({...}) }} 这一行
 * 「有没有真的接上」无法在 node 里观测 —— renderToStaticMarkup 不执行回调，
 * SSR 也拿不到事件处理器。删掉这一行，本文件仍然全绿。
 * 这一层靠 code review，不再用源码文本匹配来假装有门禁。
 */
