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
  /** invoke：把文件加入传输队列（上传或下载）。 */
  TRANSFER_ENQUEUE: 'transfer:enqueue',
  /** invoke：取消一个传输。 */
  TRANSFER_CANCEL: 'transfer:cancel',
  /** invoke：重试失败的传输。 */
  TRANSFER_RETRY: 'transfer:retry',
  /** invoke：取当前传输队列快照。 */
  TRANSFER_LIST: 'transfer:list',
  /** invoke：清掉已完成的传输。 */
  TRANSFER_CLEAR: 'transfer:clear',
  /** invoke：打开系统文件选择框，返回用户选中的本地文件绝对路径。 */
  TRANSFER_PICK_FILES: 'transfer:pick-files',
  /** event（主进程 → 渲染层）：传输队列有变化（进度已节流）。 */
  TRANSFER_CHANGED: 'transfer:changed',

  /* ===== 任务 9：文件操作与本地双栏 ===== */
  /** invoke：新建目录。 */
  FS_MKDIR: 'fs:mkdir',
  /** invoke：重命名（同目录内改名）。 */
  FS_RENAME: 'fs:rename',
  /** invoke：删除前的确认事实（数量 / 前 3 个名字 / 是否有非空目录）。 */
  FS_REMOVE_FACTS: 'fs:remove-facts',
  /** invoke：删除（**唯一不可逆操作**，必须由渲染层二次确认后才调）。 */
  FS_REMOVE: 'fs:remove',
  /** invoke：复制（同一设备内 cp）。 */
  FS_COPY: 'fs:copy',
  /** invoke：移动（同一设备内 mv）。 */
  FS_MOVE: 'fs:move',
  /** invoke：列举本地目录（限制在用户选定的根目录内）。 */
  LOCAL_LIST: 'local:list',
  /** invoke：让用户挑选本地根目录（系统目录选择框）。 */
  LOCAL_PICK_ROOT: 'local:pick-root',
} as const

export type Channel = (typeof CH)[keyof typeof CH]

/** 需要 ipcMain.handle 的通道（渲染层主动发起）。 */
export const INVOKE_CHANNELS = [
  CH.DEVICES_LIST,
  CH.FS_LIST,
  // 任务 9：写操作 + 本地双栏
  CH.FS_MKDIR,
  CH.FS_RENAME,
  CH.FS_REMOVE_FACTS,
  CH.FS_REMOVE,
  CH.FS_COPY,
  CH.FS_MOVE,
  CH.LOCAL_LIST,
  CH.LOCAL_PICK_ROOT,
  CH.TRANSFER_ENQUEUE,
  CH.TRANSFER_CANCEL,
  CH.TRANSFER_RETRY,
  CH.TRANSFER_LIST,
  CH.TRANSFER_CLEAR,
  CH.TRANSFER_PICK_FILES,
] as const

/** 由主进程单向推送的通道（webContents.send，绝不 handle）。 */
export const EVENT_CHANNELS = [CH.DEVICES_CHANGED, CH.TRANSFER_CHANGED] as const

export function isInvokeChannel(channel: string): boolean {
  return (INVOKE_CHANNELS as readonly string[]).includes(channel)
}

export function isEventChannel(channel: string): boolean {
  return (EVENT_CHANNELS as readonly string[]).includes(channel)
}
