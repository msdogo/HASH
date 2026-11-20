import { create } from 'zustand'
import { createDragFlow } from '@shared/drag-flow'

/**
 * 拖拽状态（简报 C 的渲染层）。
 *
 * 只做三件事：把 window.api 接给 createDragFlow、保存「正在准备拖拽（N/M）」、
 * 保存一句给用户看的提示。所有判断都在 @shared/drag-flow（有行为测试）——
 * 组件里剩下的只有渲染。
 *
 * ===== 为什么流程句柄是「每次拖出新建、结束即释放」而不是模块级单例 =====
 * 第一版把 createDragFlow 的结果缓存在模块顶层：容器只创建一次，于是
 * 它捕获的 window.api 也被永久固化。后果有两个，都是真事故级的：
 *   1. 窗口重载后 store 里还是旧桥（HMR / 第二次创建窗口时事件全丢）；
 *   2. 单元测试之间互相污染 —— 第一个用例装的假桥会被后面的用例继续用，
 *      「beginDragOut 真的被调用了」这种断言就永远打不到真实的桥。
 * 拖出本身是「一次动作」，事件只在这段时间里有意义，所以按次订阅最诚实：
 * 不泄漏监听器，也不需要「谁负责 reset 全局单例」这种脆弱约定。
 */

interface DragStoreState {
  /** null = 空闲；否则是「正在准备拖拽（done/total）」。 */
  preparing: { total: number; done: number } | null
  /** 一句提示（错误原因或成功摘要）；null = 不显示。 */
  notice: string | null
  /** 发起拖出；返回错误码或 null。 */
  dragOut: (serial: string, paths: readonly string[]) => Promise<string | null>
  dismissNotice: () => void
}

export const useDragStore = create<DragStoreState>((set, get) => ({
  preparing: null,
  notice: null,
  dragOut: async (serial, paths) => {
    // 没有路径就什么都不做：绝不发一条空请求去主进程（拖空白处/拖文件夹时会发生）
    if (paths.length === 0) return null
    set({ preparing: { total: paths.length, done: 0 } })
    const flow = createDragFlow({
      beginDragOut: (input) => window.api.transfer.beginDragOut(input),
      onProgress: (callback) => window.api.transfer.onDragOutProgress(callback),
      onFailed: (callback) => window.api.transfer.onDragOutFailed(callback),
      setState: (state) => {
        set({ preparing: state.phase === 'preparing' ? { total: state.total, done: state.done } : null })
      },
      notify: (text) => { set({ notice: text }) },
    })
    try {
      return await flow.start(serial, paths)
    } finally {
      // 无论成功/失败/抛异常都要退订：拖出是「一次动作」，结束后不留监听器
      flow.dispose()
      set({ preparing: null })
    }
  },
  dismissNotice: () => { set({ notice: null }) },
}))
