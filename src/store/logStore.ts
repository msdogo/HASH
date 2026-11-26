import { create } from 'zustand'
import { appendLog, type LogEntry, type LogLevel } from '@shared/log'
import type { InstallProgress } from '@shared/apps'
import { deviceLogTag } from '@shared/device-view'
import { errorText, t, tf } from '@shared/i18n'
import { formatBytes } from '@shared/transfer'
import { useDeviceStore } from '@/store/deviceStore'

/**
 * 日志栏状态（只追加、可清空）。
 *
 * ===== 为什么订阅挂在这里而不是挂在应用页 =====
 * 安装一个 150 MB 的包要几十秒，用户中途完全可能切到文件页或总览页 ——
 * 而切页会**卸载**应用页（App.tsx 里三页互斥渲染，见那里的注释）。
 * 如果订阅跟着应用页走，切页之后的进度与结果就全丢了，
 * 日志栏反而在最需要它的时候是空的。
 *
 * 所以订阅在 main.tsx 挂一次（与 device / transfer 同一手法），
 * 日志由 store 自己累积，页面只是它的一个读者。
 */

interface LogState {
  entries: LogEntry[]
  /** 当前正在进行的安装（没有则为 null）。底栏据此显示实时进度条。 */
  installing: InstallProgress | null
  /** 底栏是否折叠（默认展开：出问题时用户第一眼要看的就是它）。 */
  collapsed: boolean
  push: (level: LogLevel, text: string) => void
  clear: () => void
  setCollapsed: (collapsed: boolean) => void
  /** 由订阅推送进来的一条安装进度。 */
  applyInstall: (progress: InstallProgress) => void
}

let nextId = 1

/**
 * 设备在日志里的称呼：型号 + serial 后 4 位。
 *
 * 从 deviceStore 现查而不是让调用方传：日志的每一行都必须能说清「哪台设备」，
 * 而调用方（页面、订阅回调）手里往往只有 serial —— 让它自己拼会漏。
 * 设备已掉线时 store 里仍有记录（掉线不等于消失），所以这里拿得到型号。
 */
function deviceTag(serial: string): string {
  const device = useDeviceStore.getState().devices.find((d) => d.serial === serial)
  return deviceLogTag(device, serial)
}

export const useLogStore = create<LogState>((set, get) => ({
  entries: [],
  installing: null,
  collapsed: false,
  push: (level, text) => {
    const entry: LogEntry = { id: nextId, at: Date.now(), level, text }
    nextId += 1
    set({ entries: appendLog(get().entries, entry) })
  },
  clear: () => { set({ entries: [] }) },
  setCollapsed: (collapsed) => { set({ collapsed }) },
  applyInstall: (progress) => {
    const previous = get().installing
    set({ installing: progress.phase === 'done' ? null : progress })
    /*
     * 只在**阶段变化**时写一行日志。
     *
     * 为什么不把每次百分比都记下来：推送阶段每 300ms 就会来一条，
     * 一次安装能糊出上百行，把真正要看的那几行（开始 / 失败原因）顶出视野。
     * 实时数值由进度条负责，日志负责「发生过哪些阶段」。
     */
    if (previous !== null && previous.phase === progress.phase) return
    const device = deviceTag(progress.serial)
    const apk = progress.apkName === '' ? t('log.apkUnknown') : progress.apkName
    const size = formatBytes(progress.totalBytes)
    if (progress.phase === 'preparing') {
      get().push('info', tf('log.install.preparing', { device, apk, size }))
      return
    }
    if (progress.phase === 'pushing') {
      get().push('info', tf('log.install.pushing', { device, apk, size }))
      return
    }
    if (progress.phase === 'installing') {
      get().push('info', tf('log.install.installing', { device, apk, size }))
      return
    }
    get().push('info', tf('log.install.done', { device, apk, size }))
  },
}))

/**
 * 订阅安装进度并记日志；返回退订函数。
 *
 * 与 subscribeDeviceChanges / subscribeTransferChanges 一样在 main.tsx 挂一次 ——
 * 组件里挂会在 StrictMode 下双订阅，日志就会出现重复行。
 */
export function subscribeInstallLog(): () => void {
  return window.api.apps.onInstallProgress((progress) => {
    useLogStore.getState().applyInstall(progress)
  })
}

/** 把一条普通说明写进日志。 */
export function logInfo(text: string): void {
  useLogStore.getState().push('info', text)
}

/** 把一条失败写进日志（错误码翻成人话）。 */
export function logError(text: string): void {
  useLogStore.getState().push('error', text)
}

/**
 * 记录一次应用管理动作。
 *
 * 为什么统一在这里拼文案：五处调用（拉/启/停/清/卸）必须说同一套话术，
 * 且都要带设备与包名 —— 分开写必然漏一个（上一版就是只写了动作、没写对象，
 * 日志里连「卸的是哪个包」都看不出来）。
 */
export function logAppAction(
  kind: 'launched' | 'forceStopped' | 'cleared' | 'uninstalled',
  serial: string,
  packageName: string,
): void {
  useLogStore.getState().push('info', tf('log.app.' + kind, { device: deviceTag(serial), pkg: packageName }))
}

/** 拉取 APK 的结果（带数量）。 */
export function logApkPulled(serial: string, packageName: string, count: number): void {
  useLogStore.getState().push('info', tf('log.app.pulled', {
    device: deviceTag(serial), pkg: packageName, count,
  }))
}

/** 安装结果（成功 / 失败都要留痕：顶部提示会被下一条顶掉）。 */
export function logApkInstalled(serial: string, apkPath: string): void {
  const apk = apkPath.split(/[\\/]/).pop() ?? apkPath
  useLogStore.getState().push('info', tf('log.app.installed', { device: deviceTag(serial), apk }))
}

/** 动作失败（带错误码翻译后的原因）。 */
export function logAppFailed(serial: string, code: string): void {
  useLogStore.getState().push('error', tf('log.app.failed', {
    device: deviceTag(serial), reason: errorText(code),
  }))
}