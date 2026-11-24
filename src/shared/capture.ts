import { E_SYNC_FAILED, E_TIMEOUT, E_NO_PERMISSION, E_NOT_FOUND, E_NO_SPACE, E_PROTECTED_PATH, type ErrorCode } from './errors'

/**
 * 截图 / 录屏的共享常量与纯函数（P1 第一批）。
 *
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块。
 *
 * ===== 为什么落点常量从这里搬过来 =====
 * 任务 10 的批量截图已经在 electron/batch/service.ts 里定义了
 * SHOT_TEMP_DIR / deviceShotDir / sanitizeSerial 这一组。单机截图是同一件事的
 * 单设备版本 —— 两处各写一份「临时目录怎么拼」就是两份必须同步的事实，
 * 而它们一旦漂移，清理用的通配符就扫不到新写的那批文件，设备上会留垃圾。
 * 因此本文件成为唯一事实源，batch/service.ts 改为从它 re-export
 * （对外导出的名字与行为逐字不变，既有测试不需要改）。
 */

/**
 * 设备上的临时目录（隐藏目录）。
 *
 * 为什么不是 /data/local/tmp：传输通道的路径闸门（src/shared/path-guard.ts 的
 * PROTECTED_REMOTE_SUBTREES）拒绝 /data 整棵子树，那是传输路径的安全边界。
 * 真机实测：用 /data/local/tmp 时每一次截图都在入队那一步失败（E_PROTECTED_PATH）。
 */
export const SHOT_TEMP_DIR = '/sdcard/.adbfm'

/** 隐藏目录建不出来时的回退落点（设备上必然存在，闸门也放行）。 */
export const SHOT_FALLBACK_DIR = '/sdcard/Download'

/** 截图临时文件名前缀（陈旧残留清扫靠它识别，改名会破坏清理）。 */
export const SHOT_PREFIX = 'adbfm-shot-'

/** 录屏临时文件名前缀（与截图分开：两者清理时的通配符不同）。 */
export const RECORD_PREFIX = 'adbfm-rec-'

/** 截图超时（screencap 30s）。 */
export const CAPTURE_TIMEOUT_MS = 30_000

/**
 * 录屏硬上限（秒）。
 *
 * 必须有：screenrecord 是一个**长驻**进程，用户忘了按停止时它会一直录下去，
 * 直到把设备存储写满。--time-limit 让它在服务端自己停，这是唯一不依赖本进程的兜底。
 */
export const RECORD_MAX_SECONDS = 180

/** 录屏控制命令的超时（起进程本身要的时间，不含录制时长）。 */
export const RECORD_START_TIMEOUT_MS = 30_000

/**
 * serial → 可安全落成文件名的片段。
 *
 * 无线设备的 serial 形如 192.168.1.7:5555，冒号在 Windows 文件名里非法；
 * 统一换成下划线。唯一性不受影响（时间戳在前）。
 */
export function sanitizeSerial(serial: string): string {
  return serial.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** 每台设备自己的截图子目录（清扫只碰自己那台，不会误删别人的在途文件）。 */
export function deviceShotDir(serial: string): string {
  return SHOT_TEMP_DIR + '/' + sanitizeSerial(serial)
}

/** 回退落点下同样按设备分目录。 */
export function deviceFallbackShotDir(serial: string): string {
  return SHOT_FALLBACK_DIR + '/' + sanitizeSerial(serial)
}

/** 截图在设备上的临时文件名。 */
export function screenshotFileName(stamp: number, serial: string): string {
  return SHOT_PREFIX + String(stamp) + '-' + sanitizeSerial(serial) + '.png'
}

/** 录屏在设备上的临时文件名。 */
export function recordFileName(stamp: number, serial: string): string {
  return RECORD_PREFIX + String(stamp) + '-' + sanitizeSerial(serial) + '.mp4'
}

/** 从远程路径里取文件名（主进程算「最终落在本地哪儿」用）。 */
export function baseNameOf(targetPath: string): string {
  const normalized = targetPath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index < 0 ? normalized : normalized.slice(index + 1)
}

/**
 * 把设备侧 stderr 归类成错误码。
 *
 * 与 batch/service.ts 的 classifyShellFailure 同一套判据（同样的设备、同样的
 * toybox 文案），但**不共用**那一个：批量层的那个函数服务于「命令数组」语义，
 * 它的调用点与文案耦合在批量结果矩阵里；截图层只需要「这一次成败」。
 * 两处判据一旦分叉，测试会同时红 —— 这是可接受的重复，
 * 而把批量层整个 import 进来只为一个 if 链才是真的耦合。
 */
export function classifyCaptureFailure(stderr: string, code: number | null): ErrorCode {
  const text = (stderr ?? '').toLowerCase()
  if (text.includes('permission denied')) return E_NO_PERMISSION
  if (text.includes('no such file or directory')) return E_NOT_FOUND
  if (text.includes('no space left')) return E_NO_SPACE
  if (text.includes('read-only file system')) return E_PROTECTED_PATH
  if (text.includes('timeout') || code === null) return E_TIMEOUT
  return E_SYNC_FAILED
}

/** 截图 / 录屏一次成功的产物（IPC 出参）。 */
export interface CaptureResult {
  /** 设备序列号。 */
  serial: string
  /** 传输任务 id：真正的下载在队列里跑，进度见底栏。 */
  taskId: string
  /** 设备上的临时路径（拉取完成后会被清理）。 */
  remotePath: string
  /** 预期的本地落点（用户要复制的就是它）。 */
  localPath: string
}

/** 开始录屏的返回值（此时文件还没生成，只告诉界面「落到哪儿、最长多久」）。 */
export interface RecordStarted {
  serial: string
  /** 预期的本地落点。 */
  localPath: string
  /** 服务端的硬上限（秒）。 */
  maxSeconds: number
}
