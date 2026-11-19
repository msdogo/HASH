import { describe, it, expect, vi } from 'vitest'
import { makeShellSubmitter, planShellSubmit, submitShell } from '../src/shared/batch-shell'

/*
 * 规格 §9.6 二次确认的行为测试。
 *
 * ===== 为什么这一组必须存在 =====
 * 上一轮确认逻辑整段写在 OverviewPage 的回调里，复审把它全部删掉后
 * **全套 1093 仍全绿** —— 这是本轮三条 Important 里唯一「删掉破坏性操作的护栏
 * 而门禁无感」的一条，比假护栏更危险（假护栏只是没守住，这条是守的东西没了）。
 *
 * 现在决策在 submitShell 里，测试直接驱动：
 *   - 危险命令 + 用户取消 → **绝不调用 run**（这条是核心）；
 *   - 危险命令 + 用户确认 → 调用一次，且命令原文逐字节传下去；
 *   - 安全命令 → 不弹确认（否则用户学会无脑确定）；
 *   - 空命令 → 什么都不做。
 */

interface Recorded {
  confirms: Array<{ kind: string; count: string; command: string; devices: string }>
  runs: string[]
}

function harness(answer: boolean): { deps: { confirm: (p: unknown) => boolean; run: (c: string) => void }; seen: Recorded } {
  const seen: Recorded = { confirms: [], runs: [] }
  return {
    seen,
    deps: {
      confirm: (plan) => {
        seen.confirms.push(plan as Recorded['confirms'][number])
        return answer
      },
      run: (command) => { seen.runs.push(command) },
    },
  }
}

const DEVICES = [
  { serial: 'R5CY10S73DA', model: 'SM S9360' },
  { serial: '9N9CN2G0012A3P', model: 'SM S9360' },
]

describe('submitShell：危险命令的二次确认（规格 §9.6）', () => {
  it('危险命令 + 用户取消 → 绝不执行（这条取消掉就是安全隐患）', () => {
    const { deps, seen } = harness(false)
    expect(submitShell(deps, 'reboot', DEVICES)).toBe('cancelled')
    expect(seen.runs).toEqual([])
    expect(seen.confirms).toHaveLength(1)
  })

  it('危险命令 + 用户确认 → 执行一次，命令原文逐字节传下去', () => {
    const { deps, seen } = harness(true)
    const command = 'su -c "reboot -p"'
    expect(submitShell(deps, command, DEVICES)).toBe('submitted')
    expect(seen.runs).toEqual([command])
    expect(seen.confirms).toHaveLength(1)
  })

  it('确认框里能看到台数、命令原文与影响设备清单（同型号也能分辨）', () => {
    const { deps, seen } = harness(false)
    submitShell(deps, 'reboot', DEVICES)
    expect(seen.confirms[0]).toMatchObject({
      kind: 'reboot',
      count: '2',
      command: 'reboot',
      devices: 'SM S9360 (73DA)、SM S9360 (2A3P)',
    })
    // 清单条数与台数一致：不能告知 2 台却只列 1 个名字
    expect((seen.confirms[0].devices as string).split('、')).toHaveLength(2)
  })

  it('安全命令不弹确认（每次 echo 都弹会让用户学会无脑点确定）', () => {
    const { deps, seen } = harness(false)
    expect(submitShell(deps, 'echo ok', DEVICES)).toBe('submitted')
    expect(seen.confirms).toEqual([])
    expect(seen.runs).toEqual(['echo ok'])
  })

  it('空命令与纯空白命令什么都不做（与按钮禁用双保险）', () => {
    for (const command of ['', '   ', '\n\t']) {
      const { deps, seen } = harness(true)
      expect(submitShell(deps, command, DEVICES)).toBe('empty')
      expect(seen.runs).toEqual([])
      expect(seen.confirms).toEqual([])
    }
  })

  it('四类危险命令都要确认（kill-server / reboot / root / rm -rf）', () => {
    for (const command of ['adb kill-server', 'reboot', 'root', 'rm -rf /sdcard']) {
      const { deps, seen } = harness(false)
      expect(submitShell(deps, command, DEVICES)).toBe('cancelled')
      expect(seen.confirms).toHaveLength(1)
      expect(seen.runs).toEqual([])
    }
  })

  it('一台设备都没勾时仍然按台数 0 展示（不谎报）', () => {
    const { deps, seen } = harness(false)
    submitShell(deps, 'reboot', [])
    expect(seen.confirms[0]).toMatchObject({ count: '0', devices: '' })
  })
})

describe('planShellSubmit：提交计划（渲染与弹窗同源）', () => {
  it('危险命令 needsConfirm=true 并指出类别', () => {
    expect(planShellSubmit('reboot', DEVICES)).toMatchObject({
      needsConfirm: true,
      kind: 'reboot',
      count: '2',
    })
  })

  it('安全命令 needsConfirm=false，kind 为空串', () => {
    expect(planShellSubmit('ls -l /sdcard', DEVICES)).toMatchObject({
      needsConfirm: false,
      kind: '',
    })
  })

  it('计划里的清单与 dangerousConfirmText 一致（同一处产出，不会漂移）', () => {
    const plan = planShellSubmit('rm -rf /sdcard', DEVICES)
    expect(plan.devices).toBe('SM S9360 (73DA)、SM S9360 (2A3P)')
    expect(plan.command).toBe('rm -rf /sdcard')
  })
})

/*
 * ===== 组件级：makeShellSubmitter（复审 N10）=====
 *
 * 复审把 OverviewPage 的 handleShell 改成绕过 submitShell、直接 run(...)，
 * tsc 与全量 1128 全绿 —— 纯函数的 10 条单测拦不住「组件不调它」。
 *
 * 下面这一组按组件**真实的构造形状**驱动 makeShellSubmitter：
 * 组件把 (command, devices, confirm, run) 交给它，这里给同样的四样东西，
 * 只是 confirm / run 换成记录器。于是「入口必须经过 makeShellSubmitter→submitShell」
 * 这件事有了行为门禁：绕过 submitShell 就没有这一步确认。
 */

describe('makeShellSubmitter：组件真正用的那个入口（N10）', () => {
  it('危险命令：confirm 被调用一次，用户取消时 run 零调用', () => {
    const sees: string[] = []
    let confirmCalls = 0
    const submit = makeShellSubmitter({
      command: 'reboot',
      devices: DEVICES,
      confirm: () => { confirmCalls += 1; return false },
      run: (text) => { sees.push(text) },
    })
    expect(submit()).toBe('cancelled')
    expect(confirmCalls).toBe(1)
    expect(sees).toEqual([])
  })

  it('危险命令：用户确认后 run 被调用一次，命令原文逐字节传下去', () => {
    const sees: string[] = []
    let confirmCalls = 0
    const command = 'su -c "reboot -p"'
    const submit = makeShellSubmitter({
      command,
      devices: DEVICES,
      confirm: () => { confirmCalls += 1; return true },
      run: (text) => { sees.push(text) },
    })
    expect(submit()).toBe('submitted')
    expect(confirmCalls).toBe(1)
    expect(sees).toEqual([command])
  })

  it('安全命令：confirm 零调用，run 一次', () => {
    let confirmCalls = 0
    const sees: string[] = []
    const submit = makeShellSubmitter({
      command: 'echo ok',
      devices: DEVICES,
      confirm: () => { confirmCalls += 1; return true },
      run: (text) => { sees.push(text) },
    })
    expect(submit()).toBe('submitted')
    expect(confirmCalls).toBe(0)
    expect(sees).toEqual(['echo ok'])
  })

  it('空命令：confirm 与 run 都零调用', () => {
    let confirmCalls = 0
    const sees: string[] = []
    const submit = makeShellSubmitter({
      command: '   ',
      devices: DEVICES,
      confirm: () => { confirmCalls += 1; return true },
      run: (text) => { sees.push(text) },
    })
    expect(submit()).toBe('empty')
    expect(confirmCalls).toBe(0)
    expect(sees).toEqual([])
  })

  it('确认框拿到的是本台清单（尾号）与台数 —— 与组件传参同源', () => {
    const plans: Array<{ count: string; devices: string; kind: string }> = []
    const submit = makeShellSubmitter({
      command: 'reboot',
      devices: DEVICES,
      confirm: (plan) => { plans.push(plan); return false },
      run: () => { /* 不该被调用 */ },
    })
    submit()
    expect(plans).toEqual([{
      needsConfirm: true,
      kind: 'reboot',
      count: '2',
      command: 'reboot',
      devices: 'SM S9360 (73DA)、SM S9360 (2A3P)',
    }])
  })

  it('提交器可重复调用（组件每次点击都新建一个，不会共享状态）', () => {
    let confirmCalls = 0
    const sees: string[] = []
    const make = (answer: boolean) => makeShellSubmitter({
      command: 'reboot',
      devices: DEVICES,
      confirm: () => { confirmCalls += 1; return answer },
      run: (text) => { sees.push(text) },
    })
    expect(make(false)()).toBe('cancelled')
    expect(make(true)()).toBe('submitted')
    expect(confirmCalls).toBe(2)
    expect(sees).toEqual(['reboot'])
  })
})
