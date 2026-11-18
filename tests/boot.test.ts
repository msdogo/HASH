import { describe, it, expect, vi } from 'vitest'
import { createBootSequence, type BootDeps } from '../electron/app/boot'

/*
 * I5 / I7（审查轮 1）。
 *
 * I7：修前 main.ts 里 createWindow() 排在 registerHandlers() 前，注释却写「先注册 IPC」——
 * 因果与代码顺序相反。当时同一 tick 无间隙所以没出事，但只要将来在两者之间插一个 await
 * 就会立刻失效（渲染层首屏 invoke 撞上 No handler registered）。
 * 修法：把启动顺序提成可测函数，顺序由代码本身保证，并有断言锁住。
 *
 * I5：await probe() 期间用户关窗，before-quit 里 tracking 还是 undefined，
 * killAllAdbChildren 此时也还没被调用；在飞的 probe 子进程就成了孤儿。
 * 修法：probe 支持 AbortSignal，before-quit 先 abort 再清理。
 */

function deps(over: Partial<BootDeps> = {}): { deps: BootDeps; order: string[] } {
  const order: string[] = []
  const base: BootDeps = {
    installCsp: () => { order.push('csp') },
    registerHandlers: () => { order.push('handlers') },
    createWindow: () => { order.push('window') },
    probeAdb: async () => {
      order.push('probe')
      return { state: 'ok', path: 'C:/adb.exe', version: '1.0.41', source: 'path' }
    },
    startTracking: () => { order.push('tracking') },
    notifyAdbState: () => { order.push('notify') },
    onAdbError: () => { order.push('adbError') },
    ...over,
  }
  return { deps: base, order }
}

describe('I7 启动顺序由代码保证（不再依赖「同一 tick 无间隙」）', () => {
  it('CSP → 注册 IPC → 建窗口 → 自检 → 起 tracker', async () => {
    const h = deps()
    await createBootSequence(h.deps)()
    expect(h.order).toEqual(['csp', 'handlers', 'window', 'probe', 'tracking', 'notify'])
  })

  it('注册 IPC 严格早于建窗口（这是修前注释与代码相反的因果）', async () => {
    const h = deps()
    await createBootSequence(h.deps)()
    expect(h.order.indexOf('handlers')).toBeLessThan(h.order.indexOf('window'))
    // 即便窗口创建是异步/耗时的，handler 也已经就位
    const slow = deps()
    slow.deps.createWindow = async () => {
      slow.order.push('window')
      await new Promise((r) => setTimeout(r, 30))
    }
    await createBootSequence(slow.deps)()
    expect(slow.order.indexOf('handlers')).toBeLessThan(slow.order.indexOf('window'))
  })

  it('自检结束后一定通知一次 adb 状态（否则界面停在 checking）', async () => {
    const h = deps()
    await createBootSequence(h.deps)()
    expect(h.order).toContain('notify')
    expect(h.order.indexOf('notify')).toBeGreaterThan(h.order.indexOf('tracking'))
  })

  it('自检失败也要起 tracker（降级轮询），并报告错误', async () => {
    const h = deps({
      probeAdb: async () => { h.order.push('probe'); return { state: 'error', code: 'E_ADB_NOT_FOUND', attempts: [] } },
    })
    await createBootSequence(h.deps)()
    expect(h.order).toContain('tracking')
    expect(h.order).toContain('adbError')
  })
})

describe('I5 退出时取消在飞的自检', () => {
  it('probe 支持 AbortSignal：abort 后不再等它、也不起 tracker', async () => {
    const controller = new AbortController()
    const h = deps({
      probeAdb: (signal) => new Promise((resolve) => {
        h.order.push('probe')
        signal?.addEventListener('abort', () => { resolve({ state: 'error', code: 'E_ABORTED', attempts: [] }) })
      }),
    })
    const boot = createBootSequence(h.deps, controller.signal)()
    await new Promise((r) => setTimeout(r, 10))
    // 模拟 before-quit
    controller.abort()
    await boot
    // abort 后不得起 tracker / 不得 notify
    expect(h.order).not.toContain('tracking')
    expect(h.order).not.toContain('notify')
  })

  it('已 abort 的信号则不启动任何东西（幂等）', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = deps()
    await createBootSequence(h.deps, controller.signal)()
    expect(h.order).not.toContain('probe')
  })

  it('正常路径不受影响（未 abort 时照常起 tracker）', async () => {
    const controller = new AbortController()
    const h = deps()
    await createBootSequence(h.deps, controller.signal)()
    expect(h.order).toEqual(['csp', 'handlers', 'window', 'probe', 'tracking', 'notify'])
  })
})