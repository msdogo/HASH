import type { WindowController } from '../electron/window/controller'

/**
 * 假窗口控制器：只为满足 HandlerDeps。
 *
 * 行为本身（没有窗口时安全空操作、最大化和还原共用一个按钮）在
 * tests/window-controller.test.ts 里测；这里只记录调用次数，
 * 让 IPC 层能断言「按钮确实转成了命令」。
 */
export interface FakeWindow extends WindowController {
  calls: string[]
}

export function fakeWindow(): FakeWindow {
  const calls: string[] = []
  let maximized = false
  return {
    calls,
    minimize: () => { calls.push('minimize') },
    toggleMaximize: () => {
      calls.push('toggleMaximize')
      maximized = !maximized
      return maximized
    },
    isMaximized: () => maximized,
  }
}