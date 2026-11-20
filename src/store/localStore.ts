import { create } from 'zustand'
import type { LocalListData } from '@shared/file-ops'

/**
 * 本地栏状态（任务 9 裁决 5；R2-1 移除本地根沙箱）。
 *
 * 与 deviceStore / fileStore 同构：数据来源只有 window.api，组件不碰 node 能力。
 * **不缓存路径**：每次 list 都带上当前 cwd，主进程会重新做路径校验 ——
 * 若这里缓存「自己认为的起始目录」，用户在主进程改了之后界面就会显示错的位置。
 */

interface LocalState {
  data: LocalListData | null
  /** 加载中（用于按钮禁用与「正在读取」提示）。 */
  loading: boolean
  /** 错误码（路径不合法/不存在/无权限）；null 表示没有错误。 */
  error: string | null
  /** 已选中的名字（上传/下载用）。 */
  selected: string[]
  load: (dir?: string) => Promise<void>
  /** 换起始浏览目录：取消返回 null（不是错误）。 */
  pickRoot: () => Promise<string | null>
  select: (name: string) => void
  clearSelection: () => void
}

export const useLocalStore = create<LocalState>((set, get) => ({
  data: null,
  loading: false,
  error: null,
  selected: [],
  load: async (dir) => {
    set({ loading: true })
    const result = await window.api.local.list(dir === undefined ? {} : { dir })
    if (!result.ok) {
      // 失败时保留上一次的 data：用户还能看到之前的目录，只是这次跳转失败了
      set({ loading: false, error: result.error })
      return
    }
    set({ data: result.data, loading: false, error: null, selected: [] })
  },
  pickRoot: async () => {
    const result = await window.api.local.pickRoot()
    if (!result.ok) {
      set({ error: result.error })
      return null
    }
    // 取消（空串）不是错误：什么都不做
    if (result.data === '') return null
    await get().load(result.data)
    return result.data
  },
  select: (name) => {
    const data = get().data
    if (data === null) return
    const item = data.items.find((entry) => entry.name === name)
    // 目录与符号链接不可选（链接不当目录用：链接的真实目标与它显示的位置可能不同）
    if (item === undefined || item.isDir || item.isLink) return
    set({ selected: [name] })
  },
  clearSelection: () => { set({ selected: [] }) },
}))

/** 当前选中的完整本地路径（上传要用）；没有可选项时返回 null。 */
export function selectedLocalPath(data: LocalListData | null, selected: readonly string[]): string | null {
  if (data === null || selected.length === 0) return null
  const item = data.items.find((entry) => entry.name === selected[0])
  return item === undefined || item.isDir || item.isLink ? null : item.full
}
