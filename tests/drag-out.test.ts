import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DragOutService, DRAG_TEMP_DIR_NAME } from '../electron/drag/service'
import {
  E_DEVICE_OFFLINE,
  E_INVALID_PATH,
  E_NO_PERMISSION,
  E_PROTECTED_PATH,
  E_SYNC_FAILED,
} from '../src/shared/errors'
import type { TransferTask } from '../src/shared/transfer'
import { isInsideRoot } from '../src/shared/path-guard'
import { TransferService } from '../electron/transfer/service'

/*
 * 拖出（设备 → 资源管理器）的**行为**测试。
 *
 * 全部门禁都是行为断言：
 *   - startDrag 收到的 item 逐字段比对；
 *   - 失败时 startDrag **零调用**（toHaveLength(0)，等价于 not.toHaveBeenCalled）；
 *   - 「所有任务终态后才 resolve」用**慢任务**验证（只测快路径等于没测时序）；
 *   - 连续两次拖拽，第一次的残留必须被清掉（真实文件系统断言）。
 *
 * 为什么这里能测：编排逻辑在 electron/drag/service.ts，依赖全部注入
 * （enqueue / getTask / startDrag / tick），不需要 Electron、不需要 adb。
 */

/** 假队列：把「入队」「任务终态」这两件事做成可控的。 */
interface FakeQueue {
  tasks: Map<string, TransferTask>
  enqueued: Array<{ serial: string; direction: string; src: string; dstDir: string }>
  enqueue: (input: { serial: string; direction: 'push' | 'pull'; src: string; dstDir: string }) => Promise<TransferTask>
  getTask: (id: string) => TransferTask | undefined
  /** 把每个 queued 任务写一个真文件并置 done（模拟下载完成）。 */
  finish: () => void
  fail: (index: number, code: string) => void
}

function fakeQueue(): FakeQueue {
  const tasks = new Map<string, TransferTask>()
  const enqueued: FakeQueue['enqueued'] = []
  let seq = 0
  return {
    tasks,
    enqueued,
    enqueue: async (input) => {
      enqueued.push({ serial: input.serial, direction: input.direction, src: input.src, dstDir: input.dstDir })
      seq += 1
      const id = 'task-' + seq
      const name = input.src.split('/').pop() ?? 'file'
      const task: TransferTask = {
        id,
        serial: input.serial,
        direction: 'pull',
        src: input.src,
        dst: path.join(input.dstDir, name),
        totalBytes: 1,
        doneBytes: 0,
        status: 'queued',
        attempt: 0,
        createdAt: 0,
      }
      tasks.set(id, task)
      return task
    },
    getTask: (id) => tasks.get(id),
    finish: () => {
      for (const task of tasks.values()) {
        if (task.status !== 'queued') continue
        writeFileSync(task.dst, 'content:' + task.src)
        task.status = 'done'
        task.doneBytes = task.totalBytes ?? 0
        task.finishedAt = 1
      }
    },
    fail: (index, code) => {
      const task = [...tasks.values()][index]
      if (task === undefined) return
      task.status = 'failed'
      task.error = code
    },
  }
}

interface Harness {
  dir: string
  service: DragOutService
  queue: FakeQueue
  starts: Array<{ file: string; files: string[]; icon: string }>
  progress: Array<{ total: number; done: number }>
  /** 每条进度事件发生时 startDrag 的调用次数（证明「拖之前确实在等」）。 */
  startsDuringProgress: number[]
  failures: Array<{ total: number; done: number; error: string }>
  ticks: () => number
  /** 让任务在「第 n 次 tick 之后」才完成：n=0 表示第一次 tick 就完成。 */
  setSlowTicks: (n: number) => void
  /** 在第一次 tick 时额外注入的行为（例如把某个任务判失败）。 */
  onTick: (fn: (queue: FakeQueue, tick: number) => void) => void
}

function harness(): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), 'adbfm-drag-test-'))
  const queue = fakeQueue()
  const starts: Harness['starts'] = []
  const progress: Harness['progress'] = []
  const startsDuringProgress: number[] = []
  const failures: Harness['failures'] = []
  let tickCount = 0
  let slowTicks = 0
  let onTick: (queue: FakeQueue, tick: number) => void = () => undefined

  const service = new DragOutService({
    // 临时根：拖拽落点就是 <TEMP>/adbfm-drag（与生产同构）
    tempRoot: () => dir,
    enqueue: queue.enqueue,
    getTask: queue.getTask,
    emitProgress: (payload) => {
      progress.push(payload)
      startsDuringProgress.push(starts.length)
    },
    emitFailed: (payload) => { failures.push(payload) },
    /*
     * 慢任务的核心：前 slowTicks 次 tick 不动任务 —— 用它证明
     * 「必须等所有任务终态」，而不是「碰巧第一批就完了」。
     */
    tick: async () => {
      tickCount += 1
      onTick(queue, tickCount)
      if (tickCount >= slowTicks) queue.finish()
    },
    pollMs: 0,
    startDrag: (item) => { starts.push(item) },
  })
  return {
    dir,
    service,
    queue,
    starts,
    progress,
    failures,
    startsDuringProgress,
    ticks: () => tickCount,
    setSlowTicks: (n) => { slowTicks = n },
    onTick: (fn) => { onTick = fn },
  }
}

/** realpathSync.native 的别名：Windows 上只有它会展开 8.3 短名。 */
function realpathSyncNative(target: string): string {
  return realpathSync.native(target)
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

describe('拖出：成功路径', () => {
  it('所有任务完成后 startDrag 只调用一次，item 的 file/files 逐字段正确', async () => {
    const h = harness()
    try {
      const result = await h.service.dragOut({ serial: 'SERIAL1', paths: ['/sdcard/a.txt', '/sdcard/b.txt'] })
      expect(result).toEqual({ ok: true })

      // 入队入参：direction 固定 pull，dstDir 必须是临时目录（绝不来自渲染层）
      expect(h.queue.enqueued).toHaveLength(2)
      expect(h.queue.enqueued[0]).toEqual({
        serial: 'SERIAL1', direction: 'pull', src: '/sdcard/a.txt', dstDir: h.service.tempDir(),
      })

      expect(h.starts).toHaveLength(1)
      const item = h.starts[0]
      expect(item.file).toBe(path.join(h.service.tempDir(), 'a.txt'))
      expect(item.files).toEqual([
        path.join(h.service.tempDir(), 'a.txt'),
        path.join(h.service.tempDir(), 'b.txt'),
      ])
      // 图标必须是一张合法的 PNG data URL（macOS 要求非空，内联保证跨平台都有）
      expect(item.icon.startsWith('data:image/png;base64,')).toBe(true)
      expect(item.icon.length).toBeGreaterThan(40)
    } finally {
      cleanup(h.dir)
    }
  })

  it('快路径也推进进度：最后一次进度是 done === total', async () => {
    const h = harness()
    try {
      await h.service.dragOut({ serial: 'S', paths: ['/sdcard/a.txt'] })
      expect(h.progress.at(-1)).toEqual({ total: 1, done: 1 })
      expect(h.failures).toEqual([])
    } finally {
      cleanup(h.dir)
    }
  })
})

describe('拖出：时序（慢任务必须被等到）', () => {
  it('任务在前几次 tick 还没结束 → 期间 startDrag 零调用，最终才调用一次', async () => {
    const h = harness()
    h.setSlowTicks(3)
    try {
      const result = await h.service.dragOut({ serial: 'S', paths: ['/sdcard/slow.bin'] })
      expect(result).toEqual({ ok: true })

      // 慢路径确实发生了：至少 3 轮 tick 才完成（只测快路径等于没测时序）
      expect(h.ticks()).toBeGreaterThanOrEqual(3)

      /*
       * 关键断言：**每一条「还没完成」的进度事件发生时，startDrag 都还没被调用过**。
       *
       * 用「事件发生时快照」而不是「隔一会儿再看一眼」：
       * 后者取决于宿主机调度（tick 是微任务，20ms 内可能已经跑完），
       * 那种写法会间歇性地假绿 —— 等于把门禁建在计时器上。
       */
      const preparing = h.progress
        .map((payload, index) => ({ payload, startsAt: h.startsDuringProgress[index] }))
        .filter((row) => row.payload.done < row.payload.total)
      expect(preparing.length).toBeGreaterThan(0)
      for (const row of preparing) expect(row.startsAt).toBe(0)

      // 完成之后才拖，且只拖一次
      expect(h.starts).toHaveLength(1)
      expect(h.progress.at(-1)).toEqual({ total: 1, done: 1 })
      expect(h.startsDuringProgress.at(-1)).toBe(1)
    } finally {
      cleanup(h.dir)
    }
  })

  it('多任务必须等到全部终态，不是第一个完成就拖', async () => {
    const h = harness()
    h.setSlowTicks(2)
    try {
      const result = await h.service.dragOut({ serial: 'S', paths: ['/sdcard/a.txt', '/sdcard/b.txt'] })
      expect(result).toEqual({ ok: true })
      expect(h.starts[0].files).toHaveLength(2)
      expect(h.ticks()).toBeGreaterThanOrEqual(2)
    } finally {
      cleanup(h.dir)
    }
  })
})

describe('拖出：失败路径（startDrag 必须零调用）', () => {
  it('一个任务失败 → startDrag 零调用，失败事件带错误码被推送', async () => {
    const h = harness()
    // 第一次 tick 时把第一个任务判失败、第二个置 done（模拟「其中一个没下下来」）
    h.onTick((queue, tick) => {
      if (tick !== 1) return
      const second = [...queue.tasks.values()][1]
      if (second !== undefined) {
        writeFileSync(second.dst, 'x')
        second.status = 'done'
      }
      queue.fail(0, E_NO_PERMISSION)
    })
    try {
      const result = await h.service.dragOut({ serial: 'S', paths: ['/sdcard/a.txt', '/sdcard/b.txt'] })
      expect(result).toEqual({ ok: false, code: E_NO_PERMISSION })
      expect(h.starts).toHaveLength(0)
      expect(h.failures).toHaveLength(1)
      expect(h.failures[0]).toEqual({ total: 2, done: 2, error: E_NO_PERMISSION })
    } finally {
      cleanup(h.dir)
    }
  })

  it('设备掉线的错误码原样透传（不吞成笼统的失败）', async () => {
    const h = harness()
    h.onTick((queue, tick) => { if (tick === 1) queue.fail(0, E_DEVICE_OFFLINE) })
    try {
      const result = await h.service.dragOut({ serial: 'S', paths: ['/sdcard/a.txt'] })
      expect(result).toEqual({ ok: false, code: E_DEVICE_OFFLINE })
      expect(h.starts).toHaveLength(0)
    } finally {
      cleanup(h.dir)
    }
  })

  it('入队就抛错（例如本地目录不可写）→ startDrag 零调用，错误码透传', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adbfm-drag-test-'))
    const starts: Array<{ file: string; files: string[]; icon: string }> = []
    const failures: Array<{ total: number; done: number; error: string }> = []
    const service = new DragOutService({
      tempRoot: () => dir,
      enqueue: async () => { throw new Error(E_SYNC_FAILED) },
      getTask: () => undefined,
      emitProgress: () => undefined,
      emitFailed: (payload) => { failures.push(payload) },
      startDrag: (item) => { starts.push(item) },
    })
    try {
      const result = await service.dragOut({ serial: 'S', paths: ['/sdcard/a.txt'] })
      expect(result).toEqual({ ok: false, code: E_SYNC_FAILED })
      expect(starts).toHaveLength(0)
      expect(failures).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('受保护路径（/sdcard 本身）直接拒：零入队、零拖拽', async () => {
    const h = harness()
    try {
      const result = await h.service.dragOut({ serial: 'S', paths: ['/sdcard'] })
      expect(result).toEqual({ ok: false, code: E_PROTECTED_PATH })
      expect(h.queue.enqueued).toEqual([])
      expect(h.starts).toHaveLength(0)
      expect(h.failures).toHaveLength(1)
    } finally {
      cleanup(h.dir)
    }
  })

  it('路径含 .. → 拒绝（与 pull 的入参同一条闸门）', async () => {
    const h = harness()
    try {
      const result = await h.service.dragOut({ serial: 'S', paths: ['/sdcard/../data/x'] })
      expect(result.ok).toBe(false)
      expect(h.queue.enqueued).toEqual([])
      expect(h.starts).toHaveLength(0)
    } finally {
      cleanup(h.dir)
    }
  })

  it('空路径列表 → E_INVALID_PATH，且一条命令都不发', async () => {
    const h = harness()
    try {
      const result = await h.service.dragOut({ serial: 'S', paths: [] })
      expect(result).toEqual({ ok: false, code: E_INVALID_PATH })
      expect(h.queue.enqueued).toEqual([])
      expect(h.starts).toHaveLength(0)
    } finally {
      cleanup(h.dir)
    }
  })
})

describe('临时目录清理（硬性要求：连续两次拖拽，第一次的残留被清掉）', () => {
  it('第二次拖拽开始前，第一次留下（以及上次残留）的文件必须消失', async () => {
    const h = harness()
    const tempDir = h.service.tempDir()
    try {
      // 第一次拖拽
      expect(await h.service.dragOut({ serial: 'S', paths: ['/sdcard/first.txt'] })).toEqual({ ok: true })
      expect(readdirSync(tempDir)).toEqual(['first.txt'])

      // 再放一个「上次残留」：模拟上一次拖到一半失败/用户放弃后留在盘上的大文件
      writeFileSync(path.join(tempDir, 'stale-500mb.bin'), 'stale')
      expect(readdirSync(tempDir).sort()).toEqual(['first.txt', 'stale-500mb.bin'])

      // 第二次拖拽：开始前必须清空（否则临时目录只增不减）
      expect(await h.service.dragOut({ serial: 'S', paths: ['/sdcard/second.txt'] })).toEqual({ ok: true })
      const afterSecond = readdirSync(tempDir)
      expect(afterSecond).toEqual(['second.txt'])
      expect(afterSecond).not.toContain('stale-500mb.bin')
      expect(afterSecond).not.toContain('first.txt')
    } finally {
      cleanup(h.dir)
    }
  })

  it('cleanup() 删掉整个目录并返回删掉的条目数（进程退出兜底用它）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adbfm-drag-test-'))
    try {
      const service = new DragOutService({
        tempRoot: () => dir,
        enqueue: async () => { throw new Error('unused') },
        getTask: () => undefined,
        emitProgress: () => undefined,
        emitFailed: () => undefined,
        startDrag: () => undefined,
      })
      mkdirSync(path.join(dir, DRAG_TEMP_DIR_NAME), { recursive: true })
      writeFileSync(path.join(dir, DRAG_TEMP_DIR_NAME, 'a.bin'), 'x')
      writeFileSync(path.join(dir, DRAG_TEMP_DIR_NAME, 'b.bin'), 'x')
      expect(service.cleanup()).toBe(2)
      // 整目录被删掉（不是只删文件）
      expect(readdirSync(dir)).toEqual([])

      // 目录不存在时必须返回 0 而不抛（退出路径上会调它）
      expect(service.cleanup()).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('拖出：调用次数（不重复拖、不多入队）', () => {
  it('单文件拖出：入队一次、startDrag 一次', async () => {
    const h = harness()
    try {
      await h.service.dragOut({ serial: 'S', paths: ['/sdcard/one.txt'] })
      expect(h.queue.enqueued).toHaveLength(1)
      expect(h.starts).toHaveLength(1)
    } finally {
      cleanup(h.dir)
    }
  })

  it('startDrag 收到的 files 与 enqueue 的条数严格一致（不丢不重）', async () => {
    const h = harness()
    try {
      await h.service.dragOut({ serial: 'S', paths: ['/sdcard/a.txt', '/sdcard/b.txt', '/sdcard/c.txt'] })
      expect(h.queue.enqueued).toHaveLength(3)
      expect(h.starts).toHaveLength(1)
      expect(h.starts[0].files).toHaveLength(3)
      expect(new Set(h.starts[0].files).size).toBe(3)
    } finally {
      cleanup(h.dir)
    }
  })
})

/*
 * 【R2-1】本地根目录沙箱已移除。这一段原先断言「落点必须在本地根之内，
 * 否则 pull 会被 E_OUTSIDE_ROOT 拒」，于是失败时会把落点退回 <根>/adbfm-drag。
 * 沙箱移除后那个退回逻辑连同它的理由一起消失：系统临时目录在哪都能作为
 * pull 的目标，落点恒为 <系统临时目录>/adbfm-drag。断言改为**现在就是如此**。
 */
describe('临时目录的落点（R2-1 之后恒为系统临时目录，不再受本地根限制）', () => {
  /** 造一个只有 tempDir() 关心的最小服务。 */
  function serviceWith(tempRoot: string): DragOutService {
    return new DragOutService({
      tempRoot: () => tempRoot,
      enqueue: async () => { throw new Error('unused') },
      getTask: () => undefined,
      emitProgress: () => undefined,
      emitFailed: () => undefined,
      startDrag: () => undefined,
    })
  }

  it('落点是 <系统临时目录>/adbfm-drag（规范形式，8.3 短名会被展开）', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'adbfm-drag-root-'))
    try {
      const service = serviceWith(tempDir)
      expect(service.tempDir()).toBe(path.join(realpathSyncNative(tempDir), DRAG_TEMP_DIR_NAME))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('本地栏的起始目录与系统临时目录无关时，落点仍然在系统临时目录里（不再退回）', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'adbfm-drag-system-'))
    const otherDir = mkdtempSync(path.join(tmpdir(), 'adbfm-drag-user-'))
    try {
      const picked = serviceWith(tempRoot).tempDir()
      expect(picked).toBe(path.join(realpathSyncNative(tempRoot), DRAG_TEMP_DIR_NAME))
      /*
       * 反向自证：旧实现的「退回 <本地根>/adbfm-drag」在同样输入下会给出
       * 另一个位置。若谁把那段逻辑加回来，这一条立刻红。
       */
      expect(picked).not.toBe(path.join(realpathSyncNative(otherDir), DRAG_TEMP_DIR_NAME))
      expect(isInsideRoot(realpathSyncNative(otherDir), picked)).toBe(false)
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
      rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('落点能作为 TransferService 的 pull 目标目录（行为级：真的入队一次）', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'adbfm-drag-system-'))
    try {
      const picked = serviceWith(tempRoot).tempDir()
      mkdirSync(picked, { recursive: true })
      const svc = new TransferService({
        adbPath: () => 'C:/adb.exe',
        clientFor: () => ({ serial: 'S1' }) as never,
        emit: () => undefined,
        runner: () => ({
          resolveTotalBytes: async () => null,
          run: async () => ({ ok: true as const, bytes: 0, overwrote: false }),
          deviceOf: async () => 1,
        }) as never,
      })
      const task = await svc.enqueue({
        serial: 'S1', direction: 'pull', src: '/sdcard/a.bin', dstDir: picked,
      })
      // 落盘位置就是拖拽目录内部（文件名来自远程路径）
      expect(task.dst).toBe(path.join(realpathSyncNative(picked), 'a.bin'))
      svc.dispose()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})

describe('落点防御：任务的目标不在拖拽临时目录里 → 拒绝拖（verifyLocal）', () => {
  it('任务 done 但 dst 落在临时目录之外 → startDrag 零调用且报 E_INVALID_PATH', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adbfm-drag-guard-'))
    const outside = mkdtempSync(path.join(tmpdir(), 'adbfm-drag-outside-'))
    const starts: Array<{ file: string; files: string[]; icon: string }> = []
    const failures: Array<{ total: number; done: number; error: string }> = []
    const tasks = new Map<string, TransferTask>()

    const service = new DragOutService({
      tempRoot: () => dir,
      enqueue: async (input) => {
        // 故意把落点放到临时目录之外（模拟「服务被改坏 / 落点被换掉」）
        const task: TransferTask = {
          id: 'rogue', serial: input.serial, direction: 'pull', src: input.src,
          dst: path.join(outside, 'rogue.bin'),
          totalBytes: 1, doneBytes: 0, status: 'queued', attempt: 0, createdAt: 0,
        }
        tasks.set('rogue', task)
        return task
      },
      getTask: (id) => tasks.get(id),
      emitProgress: () => undefined,
      emitFailed: (payload) => { failures.push(payload) },
      tick: async () => { tasks.get('rogue')!.status = 'done' },
      pollMs: 0,
      startDrag: (item) => { starts.push(item) },
    })
    try {
      const result = await service.dragOut({ serial: 'S', paths: ['/sdcard/a.txt'] })
      expect(result).toEqual({ ok: false, code: E_INVALID_PATH })
      // 关键：绝不把一个来路不明的本地路径交给资源管理器
      expect(starts).toHaveLength(0)
      expect(failures).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
