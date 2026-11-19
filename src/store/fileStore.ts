import { create } from 'zustand'
import {
  createFileViewsModel,
  viewOf,
  type FileViewAction,
  type FileViews,
} from '@shared/file-view'

/**
 * 文件页状态（裁决 2 / 7 + 审查轮 1 的 C1/I2/I5/I6）。
 *
 * 设计要点：
 * 1. **按 serial 分片**（views[serial]）：A 机停在 /sdcard/DCIM、B 机停在 /sdcard/Download，
 *    切回来各自恢复，包括条目、选中项、排序、隐藏开关与滚动位置。
 * 2. **所有状态迁移走 @shared/file-view 的模型**：store 只是它的一层壳，
 *    纯逻辑部分能在 node 环境里单测（测试工程 import 不了 src/ 下的非 shared 目录）。
 * 3. **forget 接线**：设备从 deviceStore 消失时清掉分片（I5/I6），并立 tombstone 拦住迟到响应。
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
  /** 请求跳转到目录（成功后 cwd 才提交，失败保留当前目录：C1）。 */
  openDir: (serial: string, dir: string, linkTarget?: string) => Promise<void>
  /** 重新加载当前目录（条目不清空，新结果到了再替换）。 */
  refresh: (serial: string) => Promise<void>
  /** 加载当前请求目标（首次进入 / 重试）。同目录的在飞请求会复用。 */
  load: (serial: string) => Promise<void>
  /** 忘记某台设备（断开连接时清掉分片，并阻止迟到的响应复活它）。 */
  forget: (serial: string) => void
  /** 设备表变化时同步分片（新设备建分片，消失的设备 forget）。 */
  syncDevices: (serials: readonly string[]) => void
}

/**
 * 造一个文件页 store。
 *
 * 导出工厂而非常量：测试可各拿一份独立状态，
 * 而模块级常量会让两次 create 共用同一个闭包（协调器的在飞表会串味）。
 */
export function createFileStore() {
  return create<FileStoreState>((set, get) => {
    // 模型持有全部状态与在飞表；onChange 把新快照同步进 zustand
    const model = createFileViewsModel({
      // 数据来源只有 window.api（渲染层没有任何 node 能力）。
      // 类型上 FsListData 直接满足 ListResultData（多出的 serial 字段无害）。
      fetch: (request) => window.api.fs.list({ serial: request.serial, dir: request.dir }),
      onChange: (views) => { set({ views }) },
    })

    return {
      views: {},
      ensure: (serial) => { model.ensure(serial) },
      dispatch: (serial, action) => { model.dispatch(serial, action) },
      openDir: (serial, dir, linkTarget) => model.openDir(serial, dir, linkTarget),
      refresh: (serial) => model.refresh(serial),
      load: (serial) => model.load(serial),
      forget: (serial) => { model.forget(serial) },
      syncDevices: (serials) => { model.syncDevices(serials) },
    }
  })
}

export const useFileStore = createFileStore()

/** 取某台设备的视图（不存在时给默认值，不写入）。 */
export function fileViewOf(views: FileViews, serial: string) {
  return viewOf(views, serial)
}
