/**
 * IPC 通道常量（唯一事实源）。
 *
 * 红线：preload 只能引用这里的常量，不得出现裸通道字符串 ——
 * 裸字符串等于绕过白名单，渲染层就能 invoke 任意主进程能力。
 * 主进程注册时同样只认这些常量，并在 registerHandlers 里校验没有遗漏。
 */

export const CH = {
  /** invoke：取当前设备表与 adb 自检状态。 */
  DEVICES_LIST: 'devices:list',
  /** event（主进程 → 渲染层）：设备表有真实变化。 */
  DEVICES_CHANGED: 'devices:changed',
  /** invoke：列举远程目录。 */
  FS_LIST: 'fs:list',
} as const

export type Channel = (typeof CH)[keyof typeof CH]

/** 需要 ipcMain.handle 的通道（渲染层主动发起）。 */
export const INVOKE_CHANNELS = [CH.DEVICES_LIST, CH.FS_LIST] as const

/** 由主进程单向推送的通道（webContents.send，绝不 handle）。 */
export const EVENT_CHANNELS = [CH.DEVICES_CHANGED] as const

export function isInvokeChannel(channel: string): boolean {
  return (INVOKE_CHANNELS as readonly string[]).includes(channel)
}

export function isEventChannel(channel: string): boolean {
  return (EVENT_CHANNELS as readonly string[]).includes(channel)
}
