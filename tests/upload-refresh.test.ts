import { describe, it, expect } from 'vitest'
import type { TransferTask } from '../src/shared/transfer'
import {
  TERMINAL_REFRESH_QUIET_MS,
  TerminalRefreshCoalescer,
  createTerminalRefreshWatcher,
  newlyDoneUploads,
  shouldRefreshAfterTask,
  type RefreshContext,
} from '../src/shared/upload-refresh'

/*
 * R4 事项 1 的门禁：**上传真正传完之后要不要自动刷新**。
 *
 * 修前的现象是「底栏显示已完成，但文件列表里没有这个文件，要手动按刷新」——
 * 因为刷新只发生在入队成功那一刻。这条判断有 5 个条件，每一条都能单独写错，
 * 所以这里逐条喂输入：方向、终态、设备、目录、别名归一。
 */

const SERIAL = 'SERIAL-A'
const OTHER = 'SERIAL-B'
const CWD = '/sdcard/Download'

function task(over: Partial<TransferTask> = {}): TransferTask {
  return {
    id: 't1',
    serial: SERIAL,
    direction: 'push',
    src: 'D:/local/a.txt',
    dst: CWD + '/a.txt',
    totalBytes: 10,
    doneBytes: 10,
    status: 'done',
    attempt: 0,
    createdAt: 1,
    finishedAt: 2,
    ...over,
  }
}

describe('R4-1 shouldRefreshAfterTask：五个条件缺一不可', () => {
  it('全满足 → true（对照组，防止下面所有 false 是「永远返回 false」）', () => {
    expect(shouldRefreshAfterTask(task(), SERIAL, CWD)).toBe(true)
  })

  it('方向是 pull（下载）→ false：刷的是远程列表，下载不改变它', () => {
    expect(shouldRefreshAfterTask(task({ direction: 'pull' }), SERIAL, CWD)).toBe(false)
  })

  it('失败 / 取消 / 还在跑 / 还在排队 → 全 false（只有成功才刷）', () => {
    // 失败时设备上**没有**新文件，刷新会误导用户以为传进去了
    expect(shouldRefreshAfterTask(task({ status: 'failed', error: 'E_TIMEOUT' }), SERIAL, CWD)).toBe(false)
    expect(shouldRefreshAfterTask(task({ status: 'canceled' }), SERIAL, CWD)).toBe(false)
    expect(shouldRefreshAfterTask(task({ status: 'running' }), SERIAL, CWD)).toBe(false)
    expect(shouldRefreshAfterTask(task({ status: 'queued' }), SERIAL, CWD)).toBe(false)
  })

  it('任务属于别的设备 → false；当前没有选中设备 → false', () => {
    expect(shouldRefreshAfterTask(task({ serial: OTHER }), SERIAL, CWD)).toBe(false)
    expect(shouldRefreshAfterTask(task(), null, CWD)).toBe(false)
  })

  it('文件落在别的目录 → false（仅父目录匹配，不做前缀/包含判断）', () => {
    // 落在子目录：我们不能因为「看起来相关」就刷当前目录
    expect(shouldRefreshAfterTask(task({ dst: CWD + '/inner/a.txt' }), SERIAL, CWD)).toBe(false)
    // 落在父目录
    expect(shouldRefreshAfterTask(task({ dst: '/sdcard/a.txt' }), SERIAL, CWD)).toBe(false)
    // 前缀相同的另一个目录（/sdcard/Download2 不是 /sdcard/Download）
    expect(shouldRefreshAfterTask(task({ dst: '/sdcard/Download2/a.txt' }), SERIAL, CWD)).toBe(false)
  })

  it('当前目录为空串 → false（切设备瞬间 cwd 还没落地的中间态）', () => {
    expect(shouldRefreshAfterTask(task(), SERIAL, '')).toBe(false)
  })
})

describe('R4-1 别名归一：/sdcard 与 /storage/emulated/0 是同一批 inode', () => {
  it('任务 dst 用 /sdcard，当前目录是 /storage/emulated/0 → 仍然要刷', () => {
    expect(shouldRefreshAfterTask(
      task({ dst: '/sdcard/Download/a.txt' }),
      SERIAL,
      '/storage/emulated/0/Download',
    )).toBe(true)
  })

  it('反方向同样成立（当前目录 /sdcard，任务落在 /storage/emulated/0）', () => {
    expect(shouldRefreshAfterTask(
      task({ dst: '/storage/emulated/0/Download/a.txt' }),
      SERIAL,
      '/sdcard/Download',
    )).toBe(true)
  })

  it('/mnt/sdcard 与 /mnt/user/0/primary 这一族别名同样归一', () => {
    expect(shouldRefreshAfterTask(task({ dst: '/mnt/sdcard/Download/a.txt' }), SERIAL, CWD)).toBe(true)
    expect(shouldRefreshAfterTask(
      task({ dst: '/mnt/user/0/primary/Download/a.txt' }),
      SERIAL,
      '/storage/emulated/0/Download',
    )).toBe(true)
  })

  it('归一**只**处理别名，不会把不同目录抹成一个（避免归一过头）', () => {
    expect(shouldRefreshAfterTask(task({ dst: '/sdcard/DCIM/a.txt' }), SERIAL, CWD)).toBe(false)
    expect(shouldRefreshAfterTask(
      task({ dst: '/storage/emulated/0/DCIM/a.txt' }),
      SERIAL,
      '/sdcard/Download',
    )).toBe(false)
  })

  it('目录写法带重复斜杠 / 尾斜杠 / . 段时也能对上（用户可能从地址栏进来）', () => {
    expect(shouldRefreshAfterTask(task({ dst: '//sdcard//Download//a.txt' }), SERIAL, '/sdcard/./Download/'))
      .toBe(true)
  })

  it('用户存储根目录本身也成立（首屏默认目录就是 /sdcard）', () => {
    expect(shouldRefreshAfterTask(task({ dst: '/sdcard/a.txt' }), SERIAL, '/sdcard')).toBe(true)
    expect(shouldRefreshAfterTask(task({ dst: '/sdcard/a.txt' }), SERIAL, '/storage/emulated/0')).toBe(true)
  })
})

describe('R4-1 newlyDoneUploads：只认「这一份快照里刚变成 done」的', () => {
  it('上一份还在 running、这一份 done → 命中', () => {
    const running = task({ status: 'running' })
    const done = task()
    expect(newlyDoneUploads([running], [done], SERIAL, CWD).map((t) => t.id)).toEqual(['t1'])
  })

  it('上一份就已经是 done → **不**命中（否则每次进度推送都刷一次）', () => {
    // 主进程是整份快照推送，已完成的任务会一直留在列表里
    expect(newlyDoneUploads([task()], [task()], SERIAL, CWD)).toEqual([])
  })

  it('首次出现的任务（上一份里没有）若已是 done → 命中（订阅晚于完成也能刷）', () => {
    expect(newlyDoneUploads([], [task()], SERIAL, CWD).map((t) => t.id)).toEqual(['t1'])
  })

  it('失败 → 重试 → 成功 也会命中（上一份是 failed 不是 done）', () => {
    const failed = task({ status: 'failed', error: 'E_TIMEOUT' })
    expect(newlyDoneUploads([failed], [task()], SERIAL, CWD).map((t) => t.id)).toEqual(['t1'])
  })

  it('一批任务里只挑符合条件的那几个（混入下载 / 别的设备 / 别的目录）', () => {
    const previous: TransferTask[] = [
      task({ id: 'up-ok', status: 'running' }),
      task({ id: 'down', status: 'running', direction: 'pull', dst: 'D:/local/a.txt' }),
      task({ id: 'other-device', status: 'running', serial: OTHER }),
      task({ id: 'other-dir', status: 'running', dst: '/sdcard/DCIM/a.txt' }),
    ]
    const next: TransferTask[] = previous.map((t) => ({ ...t, status: 'done' as const }))
    expect(newlyDoneUploads(previous, next, SERIAL, CWD).map((t) => t.id)).toEqual(['up-ok'])
  })
})

describe('R4-1 TerminalRefreshCoalescer：一次上传多个文件只刷一次', () => {
  it('默认静默窗口是 300ms（写死在这里，改动会让本用例红）', () => {
    expect(TERMINAL_REFRESH_QUIET_MS).toBe(300)
  })

  it('还没到点 → take 返回 false；到点 → 返回 true 并清空挂起', () => {
    const coalescer = new TerminalRefreshCoalescer(300)
    coalescer.note(1000)
    expect(coalescer.pending).toBe(true)
    expect(coalescer.take(1299)).toBe(false)
    expect(coalescer.pending).toBe(true)
    expect(coalescer.take(1300)).toBe(true)
    expect(coalescer.pending).toBe(false)
    // 已经取走，再取一次不会重复刷
    expect(coalescer.take(2000)).toBe(false)
  })

  it('静默期内又来一条 → 到期时刻**续期**（尾沿防抖，不丢最后几个文件）', () => {
    const coalescer = new TerminalRefreshCoalescer(300)
    coalescer.note(0)
    coalescer.note(100)
    coalescer.note(200)
    // 原始到期时刻 300 已经被续期到 500
    expect(coalescer.take(300)).toBe(false)
    expect(coalescer.take(499)).toBe(false)
    expect(coalescer.take(500)).toBe(true)
  })

  it('没有挂起时 take 永远 false（不会凭空刷）', () => {
    expect(new TerminalRefreshCoalescer(300).take(1e12)).toBe(false)
  })

  it('reset 后挂起被清掉（卸载时不会再刷）', () => {
    const coalescer = new TerminalRefreshCoalescer(300)
    coalescer.note(0)
    coalescer.reset()
    expect(coalescer.pending).toBe(false)
    expect(coalescer.take(10_000)).toBe(false)
  })
})

/* ===== 看门狗：注入假时钟，断言「到底刷了几次、刷的哪台设备」 ===== */

function makeClock(): {
  now: () => number
  schedule: (delayMs: number, run: () => void) => () => void
  advance: (ms: number) => void
  /** 仍然挂着的定时器数（已取消/已执行的不算）—— 用来钉住「卸载后不留悬挂定时器」 */
  live: () => number
} {
  let current = 0
  let seq = 0
  const timers: Array<{ id: number; due: number; run: () => void; canceled: boolean }> = []
  return {
    now: () => current,
    schedule: (delayMs, run) => {
      seq += 1
      const id = seq
      timers.push({ id, due: current + delayMs, run, canceled: false })
      return () => {
        const timer = timers.find((entry) => entry.id === id)
        if (timer !== undefined) timer.canceled = true
      }
    },
    advance: (ms) => {
      current += ms
      for (const timer of timers) {
        if (timer.canceled || timer.due > current) continue
        timer.canceled = true
        timer.run()
      }
    },
    live: () => timers.filter((timer) => !timer.canceled).length,
  }
}

function harness(options: { quietMs?: number } = {}): {
  feed: (tasks: readonly TransferTask[]) => void
  advance: (ms: number) => void
  refreshes: string[]
  context: RefreshContext
  dispose: () => void
  liveTimers: () => number
} {
  const clock = makeClock()
  const refreshes: string[] = []
  const context: RefreshContext = { serial: SERIAL, cwd: CWD }
  const watcher = createTerminalRefreshWatcher(
    {
      readContext: () => ({ ...context }),
      refresh: (serial) => { refreshes.push(serial) },
      schedule: clock.schedule,
      now: clock.now,
      ...(options.quietMs === undefined ? {} : { quietMs: options.quietMs }),
    },
    [],
  )
  return {
    feed: (tasks) => { watcher.onSnapshot(tasks) },
    advance: clock.advance,
    refreshes,
    context,
    dispose: () => { watcher.dispose() },
    liveTimers: clock.live,
  }
}

describe('R4-1 看门狗：整条判断链（假时钟）', () => {
  it('一条上传真正完成 → 静默窗口过后刷新一次，且刷的是该任务那台设备', () => {
    const h = harness()
    h.feed([task({ status: 'running' })])
    h.advance(100)
    h.feed([task()])
    // 还没到静默窗口，不能刷（否则一次多文件上传会刷成连击）
    expect(h.refreshes).toEqual([])
    h.advance(300)
    expect(h.refreshes).toEqual([SERIAL])
  })

  it('一次上传 3 个文件连续完成 → 只刷一次，而且在最后一个之后', () => {
    const h = harness()
    const running = [
      task({ id: 'a', status: 'running', dst: CWD + '/a.txt' }),
      task({ id: 'b', status: 'running', dst: CWD + '/b.txt' }),
      task({ id: 'c', status: 'running', dst: CWD + '/c.txt' }),
    ]
    h.feed(running)
    h.advance(10)
    h.feed([{ ...running[0] as TransferTask, status: 'done' }])
    h.advance(10)
    h.feed([{ ...running[0] as TransferTask, status: 'done' }, { ...running[1] as TransferTask, status: 'done' }])
    h.advance(10)
    const allDone = running.map((t) => ({ ...t, status: 'done' as const }))
    h.feed(allDone)
    // 三条终态事件之后仍然一次都没刷（都在续期静默窗口）
    expect(h.refreshes).toEqual([])
    h.advance(300)
    expect(h.refreshes).toEqual([SERIAL])
  })

  it('失败的任务不触发刷新（设备上没有新文件）', () => {
    const h = harness()
    h.feed([task({ status: 'running' })])
    h.advance(10)
    h.feed([task({ status: 'failed', error: 'E_TIMEOUT' })])
    h.advance(1000)
    expect(h.refreshes).toEqual([])
  })

  it('任务属于别的设备 → 不刷（多设备并发时不能串台）', () => {
    const h = harness()
    h.feed([task({ status: 'running', serial: OTHER })])
    h.advance(10)
    h.feed([task({ serial: OTHER })])
    h.advance(1000)
    expect(h.refreshes).toEqual([])
  })

  it('任务落在别的目录 → 不刷（用户正在看的是当前目录）', () => {
    const h = harness()
    h.feed([task({ status: 'running', dst: '/sdcard/DCIM/a.txt' })])
    h.advance(10)
    h.feed([task({ dst: '/sdcard/DCIM/a.txt' })])
    h.advance(1000)
    expect(h.refreshes).toEqual([])
  })

  it('起始快照里遗留的已完成任务不触发刷新（进页面不白刷一次）', () => {
    const clock = makeClock()
    const refreshes: string[] = []
    const watcher = createTerminalRefreshWatcher(
      {
        readContext: () => ({ serial: SERIAL, cwd: CWD }),
        refresh: (serial) => { refreshes.push(serial) },
        schedule: clock.schedule,
        now: clock.now,
      },
      [task()],
    )
    // 同样的内容又推一次（主进程会周期性整份重推）
    watcher.onSnapshot([task()])
    clock.advance(1000)
    expect(refreshes).toEqual([])
  })

  it('静默窗口内用户切走设备 → 到点复查时放弃（不刷用户已经不看的那台）', () => {
    const h = harness()
    h.feed([task({ status: 'running' })])
    h.advance(10)
    h.feed([task()])
    h.context.serial = OTHER
    h.advance(300)
    expect(h.refreshes).toEqual([])
  })

  it('静默窗口内用户切走目录 → 同样放弃（省一次无意义的 adb ls）', () => {
    const h = harness()
    h.feed([task({ status: 'running' })])
    h.advance(10)
    h.feed([task()])
    h.context.cwd = '/sdcard/DCIM'
    h.advance(300)
    expect(h.refreshes).toEqual([])
  })

  it('dispose 之后挂起的刷新被取消，也不再响应新快照', () => {
    const h = harness()
    h.feed([task({ status: 'running' })])
    h.advance(10)
    h.feed([task()])
    // 此刻有 1 个挂起的定时器
    expect(h.liveTimers()).toBe(1)
    h.dispose()
    // 卸载必须**真的取消**定时器，不能只靠 disposed 标志挡一下 ——
    // 留着悬挂定时器在真实 Electron 里就是「页面已卸载仍在跑回调」的泄漏形态
    expect(h.liveTimers()).toBe(0)
    h.advance(1000)
    expect(h.refreshes).toEqual([])
    h.feed([task({ id: 't2', status: 'running' })])
    h.feed([task({ id: 't2' })])
    h.advance(1000)
    expect(h.refreshes).toEqual([])
    expect(h.liveTimers()).toBe(0)
  })

  it('重复 note 只保留一个在途定时器（不堆积）', () => {
    const h = harness()
    h.feed([task({ id: 'a', status: 'running' })])
    h.advance(5)
    h.feed([task({ id: 'a' })])
    expect(h.liveTimers()).toBe(1)
    h.advance(5)
    h.feed([task({ id: 'a' }), task({ id: 'b', status: 'running' })])
    h.advance(5)
    h.feed([task({ id: 'a' }), task({ id: 'b' })])
    // 三条终态事件 → 仍然只有一个在途定时器（每次续期前先 cancel 掉旧的）
    expect(h.liveTimers()).toBe(1)
    h.advance(300)
    expect(h.liveTimers()).toBe(0)
    expect(h.refreshes).toEqual([SERIAL])
  })

  it('两轮独立的上传 → 各刷一次（防抖不跨轮吞掉后面的）', () => {
    const h = harness()
    h.feed([task({ id: 'x', status: 'running' })])
    h.advance(10)
    h.feed([task({ id: 'x' })])
    h.advance(300)
    expect(h.refreshes).toEqual([SERIAL])
    h.feed([task({ id: 'x' }), task({ id: 'y', status: 'running' })])
    h.advance(10)
    h.feed([task({ id: 'x' }), task({ id: 'y' })])
    h.advance(300)
    expect(h.refreshes).toEqual([SERIAL, SERIAL])
  })
})
