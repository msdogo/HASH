import path from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import type { AdbClient } from '../adb/client'
import type { TransferTask } from '../../src/shared/transfer'
import { E_DEVICE_OFFLINE, E_INVALID_PATH, E_NOT_A_DIRECTORY } from '../../src/shared/errors'
import { normalizeDir } from '../fs/remote'
import { TransferManager, type TransferEvent } from './manager'
import { TransferRunner, type RunContext, type TransferRun } from './runner'

/**
 * 生产装配层：把「渲染层的意图」翻译成「完整的源/目标路径」，再交给调度器。
 *
 * 为什么要多这一层，而不是让 IPC handler 直接拼路径：
 *   1. 方向不同、路径语义完全相反（push 的 src 在本地、dst 在设备；pull 反过来），
 *      拼错了不会报错，只会往错误的位置传文件；把它收在一个地方才好测。
 *   2. 目标目录必须归一化（normalizeDir）、文件名必须与目录分开校验，
 *      否则 `/sdcard/DCIM/../x` 这种路径会绕过目录穿越防护。
 *   3. 总量探测（裁决 5）依赖 runner，而 runner 需要 adb client —— 都在这一层装配。
 */

/** 目录 + 文件名 → 完整路径（本地用 path.join，远程用正斜杠）。 */
export function fileNameOf(targetPath: string): string {
  // 远程路径一律正斜杠；本地路径在 Windows 上可能带反斜杠
  const normalized = targetPath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index < 0 ? normalized : normalized.slice(index + 1)
}

/** 校验并拼出一个完整目标路径。非法输入抛 E_INVALID_PATH。 */
export function resolveTargetPath(dir: string, name: string): string {
  if (name === '' || name === '.' || name === '..') throw new Error(E_INVALID_PATH)
  if (name.includes('/') || name.includes('\\')) throw new Error(E_INVALID_PATH)
  const normalized = normalizeDir(dir)
  return normalized === '/' ? '/' + name : normalized + '/' + name
}

/** 传输服务依赖。 */
export interface TransferServiceDeps {
  /** 当前 adb 路径；空串表示还没定位到。 */
  adbPath: () => string
  /** 按 serial 造 AdbClient。 */
  clientFor: (serial: string) => AdbClient
  /** 事件出口（main.ts 里转成 webContents.send）。 */
  emit: (event: TransferEvent) => void
  /** 单设备 / 全局并发。 */
  maxPerDevice?: number
  maxGlobal?: number
  /** 仅测试注入。 */
  runner?: (adbPath: string) => TransferRunner
}

export class TransferService {
  readonly manager: TransferManager
  private readonly runner: TransferRunner
  /**
   * 给 IPC 层用的控制器形状（enqueue 直接吃渲染层意图）。
   *
   * 与 manager 分开：manager.enqueue 吃的是「已解析好的完整 src/dst」，
   * 而渲染层只知道「用户选了哪个本地文件、当前在哪个目录」。
   * 让它俩用同一个签名，必然有一方要假装自己知道对方的事。
   */
  readonly controller: {
    enqueue: (input: { serial: string; direction: 'push' | 'pull'; src: string; dstDir: string }) => TransferTask
    cancel: (id: string) => boolean
    retry: (id: string) => boolean
    get: (id: string) => TransferTask | undefined
    snapshot: () => ReturnType<TransferManager['snapshot']>
    clearFinished: () => number
  }

  constructor(private readonly deps: TransferServiceDeps) {
    this.runner = deps.runner !== undefined
      ? deps.runner(deps.adbPath())
      : new TransferRunner({
          adbPath: deps.adbPath(),
          clientFor: deps.clientFor,
        })

    this.manager = new TransferManager({
      maxPerDevice: deps.maxPerDevice,
      maxGlobal: deps.maxGlobal,
      emit: deps.emit,
      execute: (task, ctx) => this.execute(task, ctx),
      resolveTotalBytes: async (task) => {
        return this.runner.resolveTotalBytes(task.direction, task.src, task.serial)
      },
    })

    this.controller = {
      enqueue: (input) => this.enqueue(input),
      cancel: (id) => this.manager.cancel(id),
      retry: (id) => this.manager.retry(id),
      get: (id) => this.manager.get(id),
      snapshot: () => this.manager.snapshot(),
      clearFinished: () => this.manager.clearFinished(),
    }
  }

  /** 执行一个任务（调度器回调）。 */
  private async execute(
    task: TransferRun,
    ctx: RunContext,
  ): Promise<{ ok: true; bytes?: number; overwrote?: boolean } | { ok: false; code: string }> {
    return this.runner.run(task, ctx)
  }

  /**
   * 渲染层入队。
   *
   * push: src 是本地文件（必须存在且是普通文件），dstDir 是设备上的目录。
   * pull: src 是设备上的文件，dstDir 是本地目录。
   * 本地文件的 totalBytes 立刻可知（本地 stat），远程的总量由调度器异步补。
   */
  enqueue(input: { serial: string; direction: 'push' | 'pull'; src: string; dstDir: string }): TransferTask {
    const name = fileNameOf(input.src)
    if (name === '') throw new Error(E_INVALID_PATH)

    if (input.direction === 'push') {
      const info = statSync(input.src)
      if (!info.isFile()) throw new Error(E_NOT_A_DIRECTORY)
      const dst = resolveTargetPath(input.dstDir, name)
      return this.manager.enqueue({
        serial: input.serial,
        direction: 'push',
        src: input.src,
        dst,
        // push 的总量用本地 stat（裁决 5：push 用本地）
        totalBytes: info.size,
      })
    }

    // pull：目标是本地目录，先保证目录存在（用户可能是手输的路径）
    const localDir = input.dstDir
    try {
      if (!statSync(localDir).isDirectory()) throw new Error(E_NOT_A_DIRECTORY)
    } catch {
      throw new Error(E_INVALID_PATH)
    }
    const dst = path.join(localDir, name)
    // pull 的总量由远程 stat 异步补（resolveTotalBytes 的 resolveTotal 钩子）
    return this.manager.enqueue({
      serial: input.serial,
      direction: 'pull',
      src: input.src,
      dst,
      totalBytes: null,
    })
  }

  /** 设备上下线（由设备跟踪器调用）。 */
  setDeviceOnline(serial: string, online: boolean): void {
    this.manager.setDeviceOnline(serial, online)
  }

  /** 退出时收尾。 */
  dispose(): void {
    this.manager.dispose()
  }
}

/**
 * 本地目录里可以选来上传的文件（渲染层只给「用户选了哪些」，校验在这里做）。
 * 单独导出便于测试；空目录/不存在目录返回空数组而不是抛错 ——
 * 「没有可选文件」是正常的空状态，不是异常。
 */
export function listLocalFiles(dir: string): Array<{ name: string; path: string; size: number }> {
  try {
    const names = readdirSync(dir, { withFileTypes: true })
    const out: Array<{ name: string; path: string; size: number }> = []
    for (const entry of names) {
      if (!entry.isFile()) continue
      const full = path.join(dir, entry.name)
      try {
        out.push({ name: entry.name, path: full, size: statSync(full).size })
      } catch {
        // 单个文件 stat 失败不影响整批（权限/竞态）
      }
    }
    return out
  } catch {
    return []
  }
}

/** 供 main.ts 用的错误码小工具：把异常翻成已知错误码。 */
export function isOfflineCode(code: string): boolean {
  return code === E_DEVICE_OFFLINE
}
