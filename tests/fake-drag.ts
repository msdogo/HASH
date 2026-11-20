import type { DragController } from '../electron/ipc/handlers'

/**
 * 假拖拽控制器：只为满足 HandlerDeps。
 *
 * 与 tests/fake-batch.ts 同一手法 —— 本文件不测拖拽本身
 * （拖拽有 tests/drag-out.test.ts / tests/drag-ipc.test.ts），
 * 其它用例只需要一个能注册进 registerHandlers 的空壳。
 * 默认返回成功；需要失败路径的用例自己传 result。
 */
export function fakeDrag(result: { ok: true } | { ok: false; code: string } = { ok: true }): DragController & {
  calls: Array<{ serial: string; paths: string[] }>
} {
  const calls: Array<{ serial: string; paths: string[] }> = []
  return {
    calls,
    dragOut: async (input) => {
      calls.push({ serial: input.serial, paths: [...input.paths] })
      return result
    },
  }
}
