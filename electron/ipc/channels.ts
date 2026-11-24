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
  /**
   * invoke：把设备上的文件拖给资源管理器（先下载到临时目录，再 startDrag）。
   *
   * 注意**没有** transfer:get-path-for-file 通道：File 对象无法穿过 IPC
   * （结构化克隆会丢掉它的磁盘绑定），而 webUtils 是渲染进程侧的 API。
   * 所以「File → 本地路径」在 preload 里同步完成，见 electron/preload.ts 的
   * getPathForFile 与 DshApi.transfer.getPathForFile。
   */
  TRANSFER_BEGIN_DRAG_OUT: 'transfer:begin-drag-out',
  /** event（主进程 → 渲染层）：拖出准备进度「正在准备拖拽（N/M）」。 */
  TRANSFER_DRAG_OUT_PROGRESS: 'transfer:drag-out-progress',
  /** event（主进程 → 渲染层）：拖出失败（任一文件失败就整体不拖）。 */
  TRANSFER_DRAG_OUT_FAILED: 'transfer:drag-out-failed',

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
  /** invoke：列举本地目录（任意合法绝对路径；R2-1 之后没有根目录限制）。 */
  LOCAL_LIST: 'local:list',
  /** invoke：让用户挑选本地栏的起始浏览目录（系统目录选择框；不是访问边界）。 */
  LOCAL_PICK_ROOT: 'local:pick-root',
  /**
   * invoke：预检「这个本地目录里有没有同名文件、它多大」（R10 双击下载前）。
   *
   * 为什么单独一条通道而不是复用 local:list：list 要 readdir 整个目录再逐项 lstat，
   * 在 5000 个文件的下载目录里为「一个问题」做一次全量列举，代价与风险都不合理；
   * 而 fileStat 只 stat 一个确定的路径。返回形状也更小（LocalFileStat）。
   */
  LOCAL_FILE_STAT: 'local:file-stat',

  /* ===== R2-2：设置（默认下载路径持久化） ===== */
  /** invoke：取设置快照（默认下载路径 + adb 只读状态）。 */
  SETTINGS_GET: 'settings:get',
  /** invoke：写默认下载路径（zod 校验 + 主进程路径闸门）。 */
  SETTINGS_SET_DOWNLOAD_DIR: 'settings:set-download-dir',
  /** invoke：弹出目录选择框挑默认下载路径（取消返回空串，不改本地栏）。 */
  SETTINGS_PICK_DOWNLOAD_DIR: 'settings:pick-download-dir',
  /** invoke：恢复默认下载路径（写回系统「下载」目录）。 */
  SETTINGS_RESET_DOWNLOAD_DIR: 'settings:reset-download-dir',

  /* ===== R9：按设备序列号记住上次停留的目录 ===== */
  /**
   * invoke：读某台设备上次停留的目录（入参 serial）。
   *
   * 没有记录时返回空串而不是错误：**「从没记过」不是故障**，
   * 用错误码会让渲染层在首次使用时就走一遍错误处理。
   */
  SETTINGS_GET_DEVICE_CWD: 'settings:get-device-cwd',
  /** invoke：记住某台设备停留的目录（入参 serial + cwd）。 */
  SETTINGS_SET_DEVICE_CWD: 'settings:set-device-cwd',

  /* ===== 任务 10：批量操作（全设备总览页） ===== */
  /** invoke：批量截图（每台设备各存一张 png 到用户选的目录）。 */
  BATCH_SCREENSHOT: 'batch:screenshot',
  /** invoke：批量安装（adb install -r）。 */
  BATCH_INSTALL: 'batch:install',
  /** invoke：批量推送（每台设备各产生传输任务）。 */
  BATCH_PUSH: 'batch:push',
  /** invoke：在每台勾选设备上跑同一条 shell 命令。 */
  BATCH_SHELL: 'batch:shell',
  /** invoke：弹出目录选择框（批量截图的目标目录）。 */
  BATCH_PICK_DIRECTORY: 'batch:pick-directory',
  /** invoke：弹出文件选择框挑一个 .apk。 */
  BATCH_PICK_APK: 'batch:pick-apk',
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
  CH.LOCAL_FILE_STAT,
  // R2-2：设置（默认下载路径）
  CH.SETTINGS_GET,
  CH.SETTINGS_SET_DOWNLOAD_DIR,
  CH.SETTINGS_PICK_DOWNLOAD_DIR,
  CH.SETTINGS_RESET_DOWNLOAD_DIR,
  // R9：按设备记住上次停留的目录
  CH.SETTINGS_GET_DEVICE_CWD,
  CH.SETTINGS_SET_DEVICE_CWD,
  CH.TRANSFER_ENQUEUE,
  CH.TRANSFER_CANCEL,
  CH.TRANSFER_RETRY,
  CH.TRANSFER_LIST,
  CH.TRANSFER_CLEAR,
  CH.TRANSFER_PICK_FILES,
  // 拖拽（简报 C）：拖出必须经主进程（startDrag 只有主进程能调）
  CH.TRANSFER_BEGIN_DRAG_OUT,
  // 任务 10：批量操作 + 两个选择框
  CH.BATCH_SCREENSHOT,
  CH.BATCH_INSTALL,
  CH.BATCH_PUSH,
  CH.BATCH_SHELL,
  CH.BATCH_PICK_DIRECTORY,
  CH.BATCH_PICK_APK,
] as const

/** 由主进程单向推送的通道（webContents.send，绝不 handle）。 */
export const EVENT_CHANNELS = [
  CH.DEVICES_CHANGED,
  CH.TRANSFER_CHANGED,
  CH.TRANSFER_DRAG_OUT_PROGRESS,
  CH.TRANSFER_DRAG_OUT_FAILED,
] as const

export function isInvokeChannel(channel: string): boolean {
  return (INVOKE_CHANNELS as readonly string[]).includes(channel)
}

export function isEventChannel(channel: string): boolean {
  return (EVENT_CHANNELS as readonly string[]).includes(channel)
}
