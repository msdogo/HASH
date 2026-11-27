import { create } from 'zustand'
import type { SettingsData } from '@shared/settings'

/**
 * 设置状态（R2-2）。
 *
 * 与其它 store 同构：数据来源只有 window.api，组件不碰 node 能力。
 * 这里多存一个字段 `error`：读取失败时界面必须说清「为什么现在没有下载路径」，
 * 而不是显示一个空白 —— 空白会让用户以为下载目录被清掉了。
 */

interface SettingsState {
  data: SettingsData | null
  /** 加载中（按钮禁用 + 「正在读取设置…」）。 */
  loading: boolean
  /** 错误码（读取/写入失败）；null 表示没有错误。 */
  error: string | null
  /** 首屏读取（幂等：已在加载中时不重复发请求）。 */
  load: () => Promise<void>
  /** 更换默认下载路径（非法值会返回错误码，界面据此提示）。返回是否成功。 */
  setDownloadDir: (dir: string) => Promise<boolean>
  /** 弹出选择框挑目录并写入；取消返回 null（不是错误）。 */
  pickDownloadDir: () => Promise<string | null>
  /** 恢复默认（系统「下载」目录）。 */
  resetDownloadDir: () => Promise<boolean>
  /**
   * 写自定义 scrcpy 参数；返回是否成功。
   *
   * 语义与 setDownloadDir 完全一致：失败时把错误码落到 error、不动 data ——
   * 界面因此永远不会出现「显示已改、实际没写进去」的分叉。
   */
  setScrcpyArgs: (raw: string) => Promise<boolean>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  data: null,
  loading: false,
  error: null,
  load: async () => {
    if (get().loading) return
    set({ loading: true })
    const result = await window.api.settings.get()
    if (!result.ok) {
      /*
       * 读取失败时**保留上一次的 data**：用户还能看到之前读到的目录，
       * 只是这次刷新失败了。把它清成 null 会让界面凭空显示「还没有读到下载路径」，
       * 而那与「从来没有设置过」是两件事。
       */
      set({ loading: false, error: result.error })
      return
    }
    set({ data: result.data, loading: false, error: null })
  },
  setDownloadDir: async (dir) => {
    const result = await window.api.settings.setDownloadDir({ downloadDir: dir })
    if (!result.ok) {
      set({ error: result.error })
      return false
    }
    set({ data: result.data, error: null })
    return true
  },
  pickDownloadDir: async () => {
    const picked = await window.api.settings.pickDownloadDir()
    if (!picked.ok) {
      set({ error: picked.error })
      return null
    }
    // 取消（空串）不是错误：什么都不做，也不写盘
    if (picked.data === '') return null
    const ok = await get().setDownloadDir(picked.data)
    return ok ? picked.data : null
  },
  resetDownloadDir: async () => {
    const result = await window.api.settings.resetDownloadDir()
    if (!result.ok) {
      set({ error: result.error })
      return false
    }
    set({ data: result.data, error: null })
    return true
  },
  setScrcpyArgs: async (raw) => {
    const result = await window.api.settings.setScrcpyArgs({ scrcpyArgs: raw })
    if (!result.ok) {
      set({ error: result.error })
      return false
    }
    set({ data: result.data, error: null })
    return true
  },
}))
