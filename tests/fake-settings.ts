import type { SettingsController } from '../electron/ipc/handlers'
import type { SettingsData } from '../src/shared/settings'

/**
 * 假设置控制器：只为满足 HandlerDeps。
 *
 * 与 tests/fake-batch.ts / fake-drag.ts 同一手法 —— 它**不实现任何业务规则**：
 * 「坏值降级」「绝对路径 + 目录存在性校验」那部分是被测对象
 * （electron/settings/store.ts，由 tests/settings-store.test.ts 用临时目录真读写断言）。
 * 这里只让 IPC 层的用例能跑起来：四个方法返回可预测的值，且记录调用。
 *
 * 单独一个文件而不是每个测试各写一份空壳：五处手写的空壳会在 SettingsController
 * 加方法时同时编译失败，而它们各自只需要「补一个返回值」这种机械修改。
 */
export function fakeSettings(over: {
  downloadDir?: string
  defaultDownloadDir?: string
  /** R9：预置的设备目录记录（serial → cwd）。 */
  deviceCwds?: Record<string, string>
  /** 写入时抛出的错误码（模拟非法路径 / 目录不存在）。 */
  setError?: string
  resetError?: string
  /**
   * 应用版本号（R7）。
   *
   * 缺省值刻意**不是** package.json 的真实版本（0.1.0）：用例要能证明
   * 「版本是控制器透传的」，若默认值恰好等于真实版本，实现里写死成真实版本也能过。
   */
  appVersion?: string
} = {}): SettingsController & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = []
  // R9：设备目录表（fake 只做「存进去读出来」，不做校验 —— 校验是存储层的被测对象）
  const deviceCwds: Record<string, string> = { ...(over.deviceCwds ?? {}) }
  let current = over.downloadDir ?? 'C:/Users/me/Downloads'
  const defaultDir = over.defaultDownloadDir ?? 'C:/Users/me/Downloads'
  const appVersion = over.appVersion ?? '9.9.9-fixture'
  return {
    calls,
    getAppVersion: () => { calls.push({ method: 'getAppVersion', args: [] }); return appVersion },
    getDownloadDir: () => { calls.push({ method: 'getDownloadDir', args: [] }); return current },
    getDefaultDownloadDir: () => defaultDir,
    setDownloadDir: (dir) => {
      calls.push({ method: 'setDownloadDir', args: [dir] })
      if (over.setError !== undefined) throw new Error(over.setError)
      current = dir
      return dir
    },
    resetDownloadDir: () => {
      calls.push({ method: 'resetDownloadDir', args: [] })
      if (over.resetError !== undefined) throw new Error(over.resetError)
      current = defaultDir
      return defaultDir
    },
    getDeviceCwd: (serial) => {
      calls.push({ method: 'getDeviceCwd', args: [serial] })
      return deviceCwds[serial]
    },
    setDeviceCwd: (serial, cwd) => {
      calls.push({ method: 'setDeviceCwd', args: [serial, cwd] })
      deviceCwds[serial] = cwd
    },
  }
}

/** 一份可预期的设置快照（默认实现下 get / set / reset 都会返回它）。 */
export function fakeSettingsData(over: Partial<SettingsData> = {}): SettingsData {
  return {
    downloadDir: 'C:/Users/me/Downloads',
    defaultDownloadDir: 'C:/Users/me/Downloads',
    appVersion: '9.9.9-fixture',
    adb: { state: 'ok', source: 'path', path: 'C:/platform-tools/adb.exe', version: '1.0.41' },
    ...over,
  }
}
