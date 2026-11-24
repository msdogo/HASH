import type { CaptureController } from '../electron/ipc/handlers'
import type { CaptureResult, RecordStarted } from '../src/shared/capture'

/**
 * 假截图 / 录屏控制器：只为满足 HandlerDeps。
 *
 * 与 tests/fake-batch.ts / fake-drag.ts / fake-settings.ts 同一手法 —— 它**不实现
 * 任何业务规则**：临目录怎么建、录屏怎么收尾、临时文件什么时候删，都是被测对象
 * （electron/capture/service.ts，由 tests/capture-service.test.ts 用假 client 逐条断言）。
 * 这里只让 IPC 层的用例能跑起来：记录入参，返回可预测的结果。
 */
export function fakeCapture(): CaptureController & {
  calls: Array<{ method: string; args: unknown[] }>
} {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const record = (method: string, args: unknown[]): void => { calls.push({ method, args }) }
  return {
    calls,
    screenshot: async (serial, dstDir): Promise<CaptureResult> => {
      record('screenshot', [serial, dstDir])
      return { serial, taskId: 'T-' + serial, remotePath: '/sdcard/.adbfm/x.png', localPath: 'C:/dl/x.png' }
    },
    startRecord: async (serial, dstDir): Promise<RecordStarted> => {
      record('startRecord', [serial, dstDir])
      return { serial, localPath: 'C:/dl/x.mp4', maxSeconds: 180 }
    },
    stopRecord: async (serial): Promise<CaptureResult> => {
      record('stopRecord', [serial])
      return { serial, taskId: 'T-' + serial, remotePath: '/sdcard/.adbfm/x.mp4', localPath: 'C:/dl/x.mp4' }
    },
  }
}
