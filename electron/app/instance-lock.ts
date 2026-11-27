/**
 * 全局单实例锁（跨 user-data-dir）。
 *
 * ===== 为什么 Electron 自带的锁不够 =====
 * `app.requestSingleInstanceLock()` 在 Windows 上把互斥体绑在 **userData 目录** 上。
 * 两个进程只要 `--user-data-dir` 不同，就都认为自己应该是唯一实例 —— 实测现场：
 *   C:\Program Files\HASH\HASH.exe                                   （默认 userData）
 *   E:\...\release\win-unpacked\HASH.exe --user-data-dir=...\sdd\udd6 （独立 userData）
 * 两个同时活着，任务栏出现 4 个图标（两个窗口按钮 + 两个托盘图标）。
 * 双击桌面图标的正常路径不会走到这里，但「装了正式版 + 同时跑构建产物联调」时必然发生，
 * 而这两个实例会各起一套 adb 子进程抢同一台设备 —— 正是单实例锁要防的事。
 *
 * ===== 为什么用 CreateMutexW 而不是再叠一层文件锁 =====
 * 命名互斥体由内核持有：进程被 kill（包括 taskkill /F）时内核自动释放，
 * 不会留下「上次崩溃残留一个锁文件，应用再也打不开」这种死局。文件锁做不到这一点。
 *
 * ===== 为什么探测失败必须放行（fail-open）=====
 * koffi 的 .node 打包后在 asar.unpacked 下，加载失败是可能的（embed.ts 里投屏就为此
 * 降级成「不可用」而不是让应用起不来）。这里在**启动路径**上：一旦把「探测失败」
 * 当成「没拿到锁」，用户看到的是双击图标毫无反应、且没有任何提示 ——
 * 比多开一个实例严重得多。所以探测失败返回 null，由调用方按放行处理。
 */
import { createRequire } from 'node:module'

/** 互斥体名。Local\ = 当前登录会话内可见（不需要特权），正是桌面应用要的范围。 */
export const GLOBAL_MUTEX_NAME = 'Local\\HASH-com.msdogo.hash'

/** ERROR_ALREADY_EXISTS：命名对象在本次调用之前就存在 → 已有实例在跑。 */
const ERROR_ALREADY_EXISTS = 183

export interface GlobalInstanceLock {
  /**
   * true  = 拿到了（本进程是唯一实例）
   * false = 已有实例在跑
   * null  = 探测失败（非 Windows / koffi 加载失败），调用方应**放行**
   */
  held: boolean | null
  /** 释放句柄。进程退出时内核会自动回收，这里只是让语义完整。 */
  release: () => void
}

/** kernel32 里用到的四个函数（可注入，便于在测试里模拟三种结局）。 */
export interface Kernel32 {
  CreateMutexW: (attrs: unknown, initialOwner: number, name: string) => unknown
  GetLastError: () => number
  SetLastError: (code: number) => void
  CloseHandle: (handle: unknown) => number
}

/**
 * 惰性加载 kernel32。
 *
 * 与 embed.ts 的 `lib()` 同一套路：失败收敛成 null，绝不抛到启动路径上。
 */
function loadKernel32(): Kernel32 | null {
  try {
    const require = createRequire(import.meta.url)
    const koffi = require('koffi') as {
      load: (name: string) => { func: (definition: string) => (...args: never[]) => unknown }
    }
    const k32 = koffi.load('kernel32.dll')
    return {
      CreateMutexW:
        k32.func('void *__stdcall CreateMutexW(void *attrs, int32_t initialOwner, str16 name)') as never,
      GetLastError: k32.func('uint32_t __stdcall GetLastError()') as never,
      SetLastError: k32.func('void __stdcall SetLastError(uint32_t code)') as never,
      CloseHandle: k32.func('int32_t __stdcall CloseHandle(void *handle)') as never,
    }
  } catch {
    return null
  }
}

export interface AcquireDeps {
  /** 覆盖平台判定（测试用）。 */
  platform?: NodeJS.Platform
  /** 覆盖 kernel32 加载（测试用）。 */
  load?: () => Kernel32 | null
  /** 覆盖互斥体名（测试用，避免与真实运行中的实例互相干扰）。 */
  name?: string
}

/**
 * 尝试获取全局单实例锁。
 *
 * 必须先 `SetLastError(0)`：CreateMutexW 成功且是**新建**时并不保证清掉上一次的
 * 错误码，残留的 183 会让第一个实例把自己误判成「第二个」。
 */
export function acquireGlobalInstanceLock(deps: AcquireDeps = {}): GlobalInstanceLock {
  const idle: GlobalInstanceLock = { held: null, release: () => {} }
  const platform = deps.platform ?? process.platform
  // 只有 Windows 有这套 API；其它平台没有多开问题（Electron 的锁已够），一律放行。
  if (platform !== 'win32') return idle

  const k32 = (deps.load ?? loadKernel32)()
  if (k32 === null) return idle

  let handle: unknown
  try {
    k32.SetLastError(0)
    handle = k32.CreateMutexW(null, 0, deps.name ?? GLOBAL_MUTEX_NAME)
    if (handle === null || handle === undefined) return idle
    if (k32.GetLastError() === ERROR_ALREADY_EXISTS) {
      // 已有实例：句柄是我们开的，必须关掉，否则这个「引用」会让对方也释放不掉。
      k32.CloseHandle(handle)
      return { held: false, release: () => {} }
    }
  } catch {
    return idle
  }

  let released = false
  return {
    held: true,
    release: () => {
      if (released) return
      released = true
      try {
        k32.CloseHandle(handle)
      } catch {
        // 已释放 / 进程正在退出：不影响任何事
      }
    },
  }
}
