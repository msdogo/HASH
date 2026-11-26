import type { AppsController } from '../electron/ipc/handlers'
import type { AppDetail, AppEntry } from '../src/shared/apps'

/**
 * 假应用管理控制器：只为满足 HandlerDeps。
 *
 * 与 fake-batch / fake-capture 同一手法 —— 它不实现任何业务规则：
 * 解析、命令构造、包名闸门都是被测对象（src/shared/apps.ts 与 electron/apps/service.ts，
 * 各自有用例）。这里只让 IPC 层的用例能跑起来：记录入参，返回可预测的结果。
 */
export function fakeApps(): AppsController & {
  calls: Array<{ method: string; args: unknown[] }>
} {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const record = (method: string, args: unknown[]): void => { calls.push({ method, args }) }
  const entry = (packageName: string): AppEntry => ({ packageName, versionCode: 1 })
  const detail = (packageName: string): AppDetail => ({
    packageName,
    versionName: '1.0',
    versionCode: 1,
    firstInstallMs: undefined,
    lastUpdateMs: undefined,
    allowClearData: true,
  })
  return {
    calls,
    listApps: async (serial) => { record('listApps', [serial]); return [entry('com.example.a')] },
    appDetail: async (serial, pkg) => { record('appDetail', [serial, pkg]); return detail(pkg) },
    pullApk: async (serial, pkg, dstDir) => {
      record('pullApk', [serial, pkg, dstDir])
      return { packageName: pkg, files: ['C:/dl/' + pkg + '.apk'] }
    },
    /*
     * 安装是唯一会推进度的动作：IPC 层要证明「service 的 onProgress 被接到了
     * deps.emitInstallProgress」，所以这里必须真的调一次回调 ——
     * 不推的话那条用例就算通过也什么都没验证。
     */
    installApk: async (serial, apkPath, onProgress) => {
      record('installApk', [serial, apkPath])
      onProgress?.({ serial, phase: 'installing', apkName: 'a.apk', doneBytes: 10, totalBytes: 10, percent: 90 })
    },
    forceStop: async (serial, pkg) => { record('forceStop', [serial, pkg]) },
    clearData: async (serial, pkg) => { record('clearData', [serial, pkg]) },
    uninstall: async (serial, pkg) => { record('uninstall', [serial, pkg]) },
    launch: async (serial, pkg) => { record('launch', [serial, pkg]) },
  }
}
