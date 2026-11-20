import { describe, it, expect } from 'vitest'
import {
  AUTO_DISMISS_MS,
  createAutoDismissTimer,
  shouldAutoDismiss,
  type AutoDismissTimerDeps,
} from '../src/shared/notice-auto-dismiss'

/*
 * R5 事项 1 的门禁：成功提示 2 秒自动消失，失败不自动消失。
 *
 * 用户裁决：成功（failed === 0）→ ${AUTO_DISMISS_MS} 后自动关闭；
 * 有失败项 → 永不自动消失（错误码列表 2 秒看不完）。
 *
 * 这些断言跑在**生产代码**上（OpDialog 的 useEffect 也调用同一对函数），
 * 不是测试里的仿制品：判断或计时器被改坏，这里直接红。
 */

/** 假时钟：可控的 schedule，把「到点」这件事变成显式调用。 */
function fakeClock(): { deps: (dismiss: () => void) => AutoDismissTimerDeps; tick: () => number; pending: () => number } {
  const queue: (() => void)[] = []
  return {
    deps: (dismiss) => ({
      schedule: (_delayMs, run) => {
        queue.push(run)
        return () => {
          const index = queue.indexOf(run)
          if (index >= 0) queue.splice(index, 1)
        }
      },
      dismiss,
    }),
    /** 触发当前所有待执行回调（生产里就是等够 2 秒）。返回触发了几个。 */
    tick: () => {
      const run = queue.splice(0, queue.length)
      for (const fn of run) fn()
      return run.length
    },
    pending: () => queue.length,
  }
}

describe('R5-1 shouldAutoDismiss：只有零失败才自动消失', () => {
  const cases: { name: string; summary: { failed: number } | null; expected: boolean }[] = [
    { name: '没有结果（null）→ 不计时', summary: null, expected: false },
    { name: '全部成功（failed 0）→ 自动消失', summary: { failed: 0 }, expected: true },
    { name: '失败 1 项 → 不自动消失', summary: { failed: 1 }, expected: false },
    { name: '失败 3 项 → 不自动消失', summary: { failed: 3 }, expected: false },
    { name: '失败 100 项 → 不自动消失', summary: { failed: 100 }, expected: false },
  ]
  for (const tableCase of cases) {
    it(tableCase.name, () => {
      expect(shouldAutoDismiss(tableCase.summary)).toBe(tableCase.expected)
    })
  }

  it('判据只看 failed，不看 ok/total（成功 1 失败 0 与成功 999 失败 0 同样自动消失）', () => {
    // 用变量而不是字面量：OpSummary 形状的对象要能直接喂进来（结构子类型），
    // 字面量会被 TS 的「多余属性检查」拦住，那是类型细节而不是行为断言的一部分
    const one: { failed: number; ok: number; total: number } = { failed: 0, ok: 1, total: 1 }
    const many: { failed: number; ok: number; total: number } = { failed: 0, ok: 999, total: 999 }
    // 反向：哪怕成功率很高，只要有一项失败就不许自动消失
    const mixed: { failed: number; ok: number; total: number } = { failed: 1, ok: 999, total: 1000 }
    expect(shouldAutoDismiss(one)).toBe(true)
    expect(shouldAutoDismiss(many)).toBe(true)
    expect(shouldAutoDismiss(mixed)).toBe(false)
  })
})

describe('R5-1 自动消失时长是用户裁决的 2000ms', () => {
  it('AUTO_DISMISS_MS === 2000', () => {
    expect(AUTO_DISMISS_MS).toBe(2000)
  })

  it('schedule 收到的延迟就是 AUTO_DISMISS_MS（不是写死的别的数字）', () => {
    const delays: number[] = []
    const timer = createAutoDismissTimer({
      schedule: (delayMs) => { delays.push(delayMs); return () => undefined },
      dismiss: () => undefined,
    })
    timer.arm({ failed: 0 })
    expect(delays).toEqual([2000])
  })
})

describe('R5-1 计时器状态机：成功计时、失败不计时、到点关闭', () => {
  it('成功结果 → 到点后 dismiss 恰好一次', () => {
    const clock = fakeClock()
    let dismissed = 0
    const timer = createAutoDismissTimer(clock.deps(() => { dismissed += 1 }))
    timer.arm({ failed: 0 })
    expect(dismissed).toBe(0)
    expect(clock.tick()).toBe(1)
    expect(dismissed).toBe(1)
  })

  it('有失败项 → 一个定时器都不排（到点也不会 dismiss）', () => {
    const clock = fakeClock()
    let dismissed = 0
    const timer = createAutoDismissTimer(clock.deps(() => { dismissed += 1 }))
    timer.arm({ failed: 2 })
    expect(clock.pending()).toBe(0)
    expect(clock.tick()).toBe(0)
    expect(dismissed).toBe(0)
    expect(timer.state()).toBe('idle')
  })

  it('null（没有结果）→ 不排定时器', () => {
    const clock = fakeClock()
    const timer = createAutoDismissTimer(clock.deps(() => undefined))
    timer.arm(null)
    expect(clock.pending()).toBe(0)
  })

  it('先成功后失败：旧的计时被取消（失败提示绝不能被悄悄关掉）', () => {
    const clock = fakeClock()
    let dismissed = 0
    const timer = createAutoDismissTimer(clock.deps(() => { dismissed += 1 }))
    timer.arm({ failed: 0 })
    expect(clock.pending()).toBe(1)
    timer.arm({ failed: 1 })
    expect(clock.pending()).toBe(0)
    expect(clock.tick()).toBe(0)
    expect(dismissed).toBe(0)
  })

  it('连着两份成功结果只留一个定时器（不会 dismiss 两次）', () => {
    const clock = fakeClock()
    let dismissed = 0
    const timer = createAutoDismissTimer(clock.deps(() => { dismissed += 1 }))
    timer.arm({ failed: 0 })
    timer.arm({ failed: 0 })
    expect(clock.pending()).toBe(1)
    expect(clock.tick()).toBe(1)
    expect(dismissed).toBe(1)
  })

  it('dispose 之后到点也不再 dismiss（组件卸载不能改 store）', () => {
    const clock = fakeClock()
    let dismissed = 0
    const timer = createAutoDismissTimer(clock.deps(() => { dismissed += 1 }))
    timer.arm({ failed: 0 })
    timer.dispose()
    expect(clock.pending()).toBe(0)
    expect(clock.tick()).toBe(0)
    expect(dismissed).toBe(0)
    // 幂等：重复 dispose 不抛
    timer.dispose()
    expect(dismissed).toBe(0)
  })
})

describe('R5-1 悬停暂停：鼠标移入暂停、移出重新给满 2 秒', () => {
  it('悬停后定时器被取消，到点也不 dismiss', () => {
    const clock = fakeClock()
    let dismissed = 0
    const timer = createAutoDismissTimer(clock.deps(() => { dismissed += 1 }))
    timer.arm({ failed: 0 })
    timer.pause()
    expect(timer.state()).toBe('paused')
    expect(clock.pending()).toBe(0)
    expect(clock.tick()).toBe(0)
    expect(dismissed).toBe(0)
  })

  it('移出后重新排一次满额定时器，到点 dismiss', () => {
    const clock = fakeClock()
    let dismissed = 0
    const timer = createAutoDismissTimer(clock.deps(() => { dismissed += 1 }))
    timer.arm({ failed: 0 })
    timer.pause()
    timer.resume()
    expect(timer.state()).toBe('running')
    expect(clock.pending()).toBe(1)
    expect(clock.tick()).toBe(1)
    expect(dismissed).toBe(1)
  })

  it('移出时用的是满额 AUTO_DISMISS_MS（不是剩余时间）', () => {
    const delays: number[] = []
    const timer = createAutoDismissTimer({
      schedule: (delayMs) => { delays.push(delayMs); return () => undefined },
      dismiss: () => undefined,
    })
    timer.arm({ failed: 0 })
    timer.pause()
    timer.resume()
    expect(delays).toEqual([2000, 2000])
  })

  it('没有在计时时悬停 / 移出都是无副作用（不会凭空造出定时器）', () => {
    const clock = fakeClock()
    const timer = createAutoDismissTimer(clock.deps(() => undefined))
    timer.pause()
    expect(timer.state()).toBe('idle')
    timer.resume()
    expect(timer.state()).toBe('idle')
    expect(clock.pending()).toBe(0)
  })

  it('失败结果下悬停/移出不会启动计时（失败提示必须一直留着）', () => {
    const clock = fakeClock()
    let dismissed = 0
    const timer = createAutoDismissTimer(clock.deps(() => { dismissed += 1 }))
    timer.arm({ failed: 1 })
    timer.pause()
    timer.resume()
    expect(clock.pending()).toBe(0)
    expect(dismissed).toBe(0)
  })

  it('dispatch 到点后状态回到 idle，重复 tick 不会二次 dismiss', () => {
    const clock = fakeClock()
    let dismissed = 0
    const timer = createAutoDismissTimer(clock.deps(() => { dismissed += 1 }))
    timer.arm({ failed: 0 })
    clock.tick()
    expect(timer.state()).toBe('idle')
    expect(clock.tick()).toBe(0)
    expect(dismissed).toBe(1)
  })
})
