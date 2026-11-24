import type { LocalController } from '../electron/ipc/handlers'

/**
 * 假本地目录访问（IPC 层只需要「有没有把参数透传下去」）。
 *
 * 为什么抽成共享文件：LocalController 每加一个方法，原先 6 个测试文件里各自的
 * 内联空壳都要同时补一遍（同一处改动分散在 6 个地方），而它们的语义完全一样 ——
 * 「只满足接口，行为由真实现 electron/fs/local.ts 的专门用例负责」。
 * R10 新增 fileStat 时正是这种情况。
 *
 * fileStat 的默认实现返回「不存在」：IPC 层的用例不关心预检结果，
 * 需要特定结果的用例自己传 over.fileStat。
 */
export function fakeLocalController(
  cwd = 'C:/Users/me',
  over: { fileStat?: (dir: string, name: string) => Promise<{ exists: false } | { exists: true; size: number }> } = {},
): LocalController {
  return {
    list: async () => ({ cwd, parent: null, items: [], startDir: cwd }),
    fileStat: over.fileStat ?? (async () => ({ exists: false })),
  }
}
