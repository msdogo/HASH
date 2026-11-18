import { create } from 'zustand'
import type { AdbState, DeviceSession } from '@shared/types'
import { nextActiveSerial, sortDevices } from '@shared/device-view'

/**
 * 设备栏状态（按 serial 天然分片，后续任务 7 的 fileStore 会按 serial 再分一层）。
 *
 * 数据来源只有两条：
 * 1. 启动时 window.api.devices.list() 拿首屏；
 * 2. window.api.devices.changed 推送（主进程已做过去重与 50ms 合并）。
 * 组件绝不自己轮询 —— 轮询在主进程，渲染层只被动接收。
 */

interface DeviceState {
  devices: DeviceSession[]
  adb: AdbState | null
  activeSerial: string | null
  /** 是否已完成首次加载（区分「还没拉到」与「真的没有设备」）。 */
  loaded: boolean
  setSnapshot: (devices: DeviceSession[], adb: AdbState) => void
  /** 增量合并推送批次：changed 里同 serial 覆盖，removed 里删掉；adb 状态随批次一起更新。 */
  applyBatch: (changed: DeviceSession[], removed: string[], adb?: AdbState) => void
  setActive: (serial: string) => void
}

export const useDeviceStore = create<DeviceState>((set) => ({
  devices: [],
  adb: null,
  activeSerial: null,
  loaded: false,
  setSnapshot: (devices, adb) =>
    set((state) => {
      const sorted = sortDevices(devices)
      return {
        devices: sorted,
        adb,
        loaded: true,
        // 原活动设备还在就保持；被拔掉了才回退到第一台
        activeSerial: nextActiveSerial(state.activeSerial, sorted),
      }
    }),
  applyBatch: (changed, removed, adb) =>
    set((state) => {
      const bySerial = new Map(state.devices.map((d) => [d.serial, d]))
      for (const device of changed) bySerial.set(device.serial, device)
      for (const serial of removed) bySerial.delete(serial)
      const sorted = sortDevices([...bySerial.values()])
      return {
        devices: sorted,
        // 推送里带 adb 状态就更新（停在 checking 时靠它推进），没带就保持原值
        adb: adb ?? state.adb,
        activeSerial: nextActiveSerial(state.activeSerial, sorted),
      }
    }),
  setActive: (serial) => set({ activeSerial: serial }),
}))

/**
 * 订阅主进程推送并返回退订函数。
 * 单独导出而不是塞进组件：main.tsx 里挂一次即可，避免 StrictMode 双挂导致重复订阅。
 */
export function subscribeDeviceChanges(): () => void {
  const { setSnapshot, applyBatch } = useDeviceStore.getState()

  // 首屏：先拉一次全量，再订阅增量 —— 顺序不能反，
  // 反了会丢掉「订阅建立到首屏返回之间」发生的变化。
  void window.api.devices.list().then((result) => {
    if (!result.ok) return
    setSnapshot(result.data.devices, result.data.adb)
  })

  return window.api.devices.onChanged((batch) => {
    applyBatch(batch.changed, batch.removed, batch.adb)
  })
}