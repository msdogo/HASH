import { useDeviceStore } from '@/store/deviceStore'
import { useFileStore } from '@/store/fileStore'

/**
 * 开发期调试钩子（仅在 dev 构建里生效，生产构建被 import.meta.env.DEV 常量折叠掉）。
 *
 * 为什么需要：任务 7 的手工验证要在**真实运行的 Electron 渲染层**里驱动真实 store
 * （喂假目录数据然后看真实 DOM 反应），而 CDP 里 `import('/src/store/fileStore.ts')`
 * 拿到的是**另一份模块实例**——Vite 的 HMR 会给每个模块加时间戳查询串，
 * 与页面里已加载的那一份不是同一个 URL，于是拿到的是全新的空 store，
 * 写进去的状态根本不影响界面（我踩过这个坑：界面一直显示旧内容）。
 *
 * 暴露真实单例既解决验证问题，也让「出问题时打开 DevTools 看 store」变得可能。
 * 只写 `window.__stores`，不改变任何业务行为；生产构建里这段代码不会执行。
 */
export function exposeStoresForDebug(): void {
  if (!import.meta.env.DEV) return
  window.__stores = { device: useDeviceStore, file: useFileStore }
}

declare global {
  interface Window {
    /** 仅 dev 存在：调试/手工验证用的真实 store 单例。 */
    __stores?: {
      device: typeof useDeviceStore
      file: typeof useFileStore
    }
  }
}
