import { describe, it, expect, beforeEach } from 'vitest'
import { useMirrorStore } from '../src/store/mirrorStore'
import { DEFAULT_SCREEN, type MirrorSession } from '../src/shared/mirror'

const session = (serial: string): MirrorSession => ({
  serial,
  pid: 1,
  startedAt: 0,
  token: 't-' + serial,
  source: 'bundled',
  version: '5.0.1',
  title: '设备 (' + serial + ')',
  screen: DEFAULT_SCREEN,
})

describe('mirrorStore', () => {
  beforeEach(() => {
    useMirrorStore.setState({ sessions: {} })
  })

  it('setSessions 整体替换（镜像主进程的权威列表）', () => {
    useMirrorStore.getState().setSessions([session('A'), session('B')])
    expect(Object.keys(useMirrorStore.getState().sessions).sort()).toEqual(['A', 'B'])
    // 再给一份只有 A 的 → B 必须消失（不是合并）
    useMirrorStore.getState().setSessions([session('A')])
    expect(Object.keys(useMirrorStore.getState().sessions)).toEqual(['A'])
  })

  it('started 事件加入会话', () => {
    useMirrorStore.getState().apply({ kind: 'started', session: session('A') })
    expect(useMirrorStore.getState().isMirroring('A')).toBe(true)
  })

  it('exited 事件移除会话（否则界面永远显示「投屏中」）', () => {
    useMirrorStore.getState().apply({ kind: 'started', session: session('A') })
    useMirrorStore.getState().apply({ kind: 'exited', serial: 'A', code: 0 })
    expect(useMirrorStore.getState().isMirroring('A')).toBe(false)
  })

  it('failed 事件也移除会话（留着会让用户无法重试）', () => {
    useMirrorStore.getState().apply({ kind: 'started', session: session('A') })
    useMirrorStore.getState().apply({ kind: 'failed', serial: 'A', code: 'E_MIRROR_START_FAILED' })
    expect(useMirrorStore.getState().isMirroring('A')).toBe(false)
  })

  it('移除不存在的会话不抛（迟到的 exited 很常见）', () => {
    expect(() => {
      useMirrorStore.getState().apply({ kind: 'exited', serial: 'GHOST', code: 0 })
    }).not.toThrow()
  })

  it('多设备互不影响', () => {
    useMirrorStore.getState().apply({ kind: 'started', session: session('A') })
    useMirrorStore.getState().apply({ kind: 'started', session: session('B') })
    useMirrorStore.getState().apply({ kind: 'exited', serial: 'A', code: 0 })
    expect(useMirrorStore.getState().isMirroring('A')).toBe(false)
    expect(useMirrorStore.getState().isMirroring('B')).toBe(true)
  })
})
