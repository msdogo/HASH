import { describe, it, expect } from 'vitest'
import { acquireGlobalInstanceLock, GLOBAL_MUTEX_NAME, type Kernel32 } from '../electron/app/instance-lock'

/*
 * 全局单实例锁。
 *
 * 这里用假 kernel32 覆盖三种结局，而不是真的调 CreateMutexW：
 *   - 真调会让测试依赖「当前机器上有没有实例在跑」，结果不可重复；
 *   - 真调拿到的是真句柄，忘了释放就会把后面所有用例串起来。
 */

const ERROR_ALREADY_EXISTS = 183

interface FakeState {
  lastError: number
  closed: unknown[]
  created: string[]
}

function fakeKernel32(state: FakeState, behaviour: 'fresh' | 'exists' | 'null-handle'): Kernel32 {
  return {
    CreateMutexW: (_attrs, _owner, name) => {
      state.created.push(name)
      if (behaviour === 'null-handle') return null
      // 关键细节：CreateMutexW 自己会把 lastError 置成 183（已存在）；
      // 「新建」时它**不清** lastError —— 这正是调用方必须先 SetLastError(0) 的原因。
      if (behaviour === 'exists') state.lastError = ERROR_ALREADY_EXISTS
      return { handle: 'h1' }
    },
    GetLastError: () => state.lastError,
    SetLastError: (code) => { state.lastError = code },
    CloseHandle: (handle) => { state.closed.push(handle); return 1 },
  }
}

function mk(behaviour: 'fresh' | 'exists' | 'null-handle') {
  const state: FakeState = { lastError: 0, closed: [], created: [] }
  return { state, load: () => fakeKernel32(state, behaviour) }
}

describe('全局单实例锁', () => {
  it('互斥体名必须带 Local\\ 前缀（只需在当前登录会话内唯一，不需要特权）', () => {
    expect(GLOBAL_MUTEX_NAME.startsWith('Local\\')).toBe(true)
  })

  /* 名字里带 appId，避免与机器上别的 Electron 应用撞车。 */
  it('互斥体名带应用 appId', () => {
    expect(GLOBAL_MUTEX_NAME).toContain('com.msdogo.hash')
  })

  it('非 Windows 直接放行（返回 null，交给调用方 fail-open）', () => {
    const { state, load } = mk('fresh')
    const lock = acquireGlobalInstanceLock({ platform: 'linux', load })
    expect(lock.held).toBeNull()
    // 根本不该碰 kernel32
    expect(state.created).toEqual([])
  })

  it('kernel32 加载失败 → null（不能把应用锁死）', () => {
    const lock = acquireGlobalInstanceLock({ platform: 'win32', load: () => null })
    expect(lock.held).toBeNull()
  })

  it('新锁 → held=true，且调用前清过 lastError', () => {
    const { state, load } = mk('fresh')
    const lock = acquireGlobalInstanceLock({ platform: 'win32', load, name: 'Local\\t-fresh' })
    expect(lock.held).toBe(true)
    expect(state.created).toEqual(['Local\\t-fresh'])
    expect(state.closed).toEqual([])
  })

  /*
   * 这条锁住的是「残留 lastError 把第一个实例误判成第二个」。
   * 初始 lastError 故意设成 183，模拟上一次 API 调用留下的脏值。
   */
  it('调用前必须 SetLastError(0)：否则残留的 183 会把首个实例误判为重复', () => {
    const state: FakeState = { lastError: ERROR_ALREADY_EXISTS, closed: [], created: [] }
    const lock = acquireGlobalInstanceLock({
      platform: 'win32',
      load: () => fakeKernel32(state, 'fresh'),
      name: 'Local\\t-dirty',
    })
    expect(lock.held).toBe(true)
  })

  it('已有实例 → held=false，并且必须关掉我们自己开的句柄', () => {
    const { state, load } = mk('exists')
    const lock = acquireGlobalInstanceLock({ platform: 'win32', load, name: 'Local\\t-exists' })
    expect(lock.held).toBe(false)
    // 不关的话这个引用会让真正持有者释放不掉互斥体
    expect(state.closed).toHaveLength(1)
  })

  it('CreateMutexW 返回空句柄 → null（fail-open）', () => {
    const { load } = mk('null-handle')
    const lock = acquireGlobalInstanceLock({ platform: 'win32', load, name: 'Local\\t-null' })
    expect(lock.held).toBeNull()
  })

  it('release 幂等：重复调用只关一次句柄', () => {
    const { state, load } = mk('fresh')
    const lock = acquireGlobalInstanceLock({ platform: 'win32', load, name: 'Local\\t-release' })
    lock.release()
    lock.release()
    expect(state.closed).toHaveLength(1)
  })

  it('没拿到锁时 release 是空操作', () => {
    const { state, load } = mk('exists')
    const lock = acquireGlobalInstanceLock({ platform: 'win32', load, name: 'Local\\t-noop' })
    lock.release()
    expect(state.closed).toHaveLength(1) // 只有 CreateMutexW 后立刻关的那一次
  })
})
