import { create } from 'zustand'
import type { MirrorEvent, MirrorSession } from '@shared/mirror'

/**
 * 渲染层的投屏会话状态（只读镜像）。
 *
 * ===== 谁是事实源 =====
 * 主进程（electron/mirror/service.ts）。这里的 store 只是「界面上要知道的那一份」，
 * 任何时候都可以被 mirror:list 覆盖 —— 所以它**不**做任何推断
 * （不猜「应该还在投屏」、不自己加超时结束会话）。
 *
 * ===== 为什么需要它 =====
 * 设备栏右键菜单要显示「投屏 / 关闭投屏」、工具条要知道当前设备是否已在投屏。
 * 这些都得有一份可订阅的状态；逐组件各自 invoke 一次 list 会得到不同时刻的快照。
 */

interface MirrorState {
  /** 当前会话（按 serial 索引）。 */
  sessions: Record<string, MirrorSession>
  /** 整体替换（来自 mirror:list 或 started 事件）。 */
  setSessions: (sessions: MirrorSession[]) => void
  /** 应用一条推送事件。 */
  apply: (event: MirrorEvent) => void
  /** 这台设备是否在投屏。 */
  isMirroring: (serial: string) => boolean
}

export const useMirrorStore = create<MirrorState>((set, get) => ({
  sessions: {},
  setSessions: (sessions) =>
    set(() => {
      const next: Record<string, MirrorSession> = {}
      for (const session of sessions) next[session.serial] = session
      return { sessions: next }
    }),
  apply: (event) =>
    set((state) => {
      if (event.kind === 'started') {
        return { sessions: { ...state.sessions, [event.session.serial]: event.session } }
      }
      /*
       * exited / failed 都要把会话删掉。
       *
       * 是「删除」而不是「标记为失败」：会话不存在 = 这台设备当前没在投屏，
       * 界面据此显示「投屏」按钮。留一个失败态会让用户点不了重试。
       */
      const next = { ...state.sessions }
      delete next[event.serial]
      return { sessions: next }
    }),
  isMirroring: (serial) => get().sessions[serial] !== undefined,
}))

/**
 * 订阅投屏会话变化并返回退订函数。
 *
 * 与 subscribeDeviceChanges 同一手法：先拉一次首屏（mirror:list），再订阅增量。
 * 顺序反了会丢掉「启动瞬间已经在投屏」的那一台。
 *
 * 返回的退订函数必须在窗口卸载时调用（main.tsx 的 beforeunload）。
 */
export function subscribeMirrorChanges(): () => void {
  const store = useMirrorStore.getState()
  void window.api.mirror.list().then((result) => {
    if (result.ok) store.setSessions(result.data)
  })
  return window.api.mirror.onChanged((event) => {
    useMirrorStore.getState().apply(event)
  })
}

