import { create } from 'zustand'
import {
  createLoadCoordinator,
  fileViewsReducer,
  viewOf,
  type FileViewAction,
  type FileViews,
} from '@shared/file-view'

/**
 * 文件页状态（裁决 2 / 7）。
 *
 * 设计要点：
 * 1. **按 serial 分片**（views[serial]）：A 机停在 /sdcard/DCIM、B 机停在 /sdcard/Download，
 *    切回来各自恢复，包括条目、选中项、排序、隐藏开关与滚动位置。
 * 2. **所有状态迁移走纯 reducer**（@shared/file-view）：store 只负责「持有 + 派发」，
 *    这样状态机逻辑能在 node 环境里单测（测试工程 import 不了 src/ 下的非 shared 目录）。
 * 3. **加载协调器**负责 in-flight 去重与过期丢弃：切目录只发一次请求，
 *    旧目录的晚到结果不会覆盖新目录（裁决 2）。
 *
 * 任务 9 扩展点：文件操作/本地双栏会需要「每个面板各自的 cwd」，
 * 届时在 FileViewState 上加 pane 分片即可，这一层的分片键（serial）不用动。
 */

interface FileStoreState {
  views: FileViews
  /** 确保某台设备有视图分片（首次进入文件页时调用）。 */
  ensure: (serial: string) => void
  /** 派发一个视图 action。 */
  dispatch: (serial: string, action: FileViewAction) => void
  /** 跳转到目录并加载。 */
  openDir: (serial: string, dir: string) => void
  /** 重新加载当前目录（条目不清空，新结果到了再替换）。 */
  refresh: (serial: string) => void
  /** 加载当前 cwd（首次进入 / 重试）。代次未变时不会重复发请求。 */
  load: (serial: string) => Promise<void>
  /** 忘记某台设备（断开连接时清掉分片）。 */
  forget: (serial: string) => void
}

/**
 * 造一个文件页 store。
 *
 * 导出工厂而非常量：测试与未来的多窗口场景可以各拿一份独立状态，
 * 而模块级常量会让两次 create 共用同一个闭包（协调器的在飞表会串味）。
 */
export function createFileStore() {
  return create<FileStoreState>((set, get) => {
    // 协调器的 get / dispatch 必须指向【本 store 实例】，
    // 所以它只能建在 create 的回调里（放在模块顶层会捕获到错误的 set）
    const coordinator = createLoadCoordinator({
      get: (serial) => viewOf(get().views, serial),
      dispatch: (serial, action) => {
        set((state) => ({ views: fileViewsReducer(state.views, { ...action, serial }) }))
      },
      // 数据来源只有 window.api（渲染层没有任何 node 能力）。
      // 类型上 FsListData 直接满足 ListResultData（多出的 serial 字段无害）。
      fetch: (request) => window.api.fs.list({ serial: request.serial, dir: request.dir }),
    })

    return {
      views: {},
      ensure: (serial) =>
        set((state) => {
          if (state.views[serial] !== undefined) return state
          // 借助 reducer 建立分片：默认值只在一处定义（createFileView）
          return { views: fileViewsReducer(state.views, { serial, type: 'setScrollTop', value: 0 }) }
        }),
      dispatch: (serial, action) => {
        set((state) => {
          const views = fileViewsReducer(state.views, { ...action, serial })
          return views === state.views ? state : { views }
        })
      },
      openDir: (serial, dir) => {
        get().dispatch(serial, { type: 'navigate', cwd: dir })
        // dispatch 是同步的：这里 load 读到的已经是推进后的代次与新 cwd
        void get().load(serial)
      },
      refresh: (serial) => {
        get().dispatch(serial, { type: 'beginLoad' })
        void get().load(serial)
      },
      load: (serial) => {
        // load 永远不向外抛（协调器内部把异常收敛成错误码）
        return coordinator.load(serial)
      },
      forget: (serial) => {
        coordinator.reset(serial)
        set((state) => {
          if (state.views[serial] === undefined) return state
          const views = { ...state.views }
          delete views[serial]
          return { views }
        })
      },
    }
  })
}

export const useFileStore = createFileStore()
