import type { BatchController } from '../electron/ipc/handlers'
import type { BatchRunData } from '../src/shared/batch'

/**
 * 假批量控制器：只为满足 HandlerDeps。
 *
 * 它**不实现任何业务规则** —— 那正是被测对象（electron/batch/service.ts，
 * 由 tests/batch-service.test.ts 用假 client 逐条断言）。
 * 这里只让 IPC 层的用例能跑起来：每次调用记录入参，返回可预测的空结果。
 *
 * 单独一个文件而不是每个测试各写一份空壳：三处手写的空壳会在 BatchController
 * 加方法时同时编译失败，而它们各自只需要「补一个返回值」这种机械修改。
 */
export function fakeBatch(): BatchController & {
  calls: Array<{ method: string; args: unknown[] }>
} {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const record = (method: string, args: unknown[]): void => { calls.push({ method, args }) }
  const empty = (): BatchRunData => ({ results: [] })
  return {
    calls,
    screenshot: async (input) => { record('screenshot', [input]); return empty() },
    install: async (input, apkPath) => { record('install', [input, apkPath]); return empty() },
    push: async (input) => { record('push', [input]); return empty() },
    shell: async (input, command) => { record('shell', [input, command]); return empty() },
    pickScreenshotDir: async () => { record('pickScreenshotDir', []); return '' },
    pickApk: async () => { record('pickApk', []); return '' },
  }
}
