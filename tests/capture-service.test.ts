import { describe, it, expect } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CaptureService, type CaptureDeps, type RecordHandle } from '../electron/capture/service'
import type { DeviceSession } from '../src/shared/types'
import type { RunResult } from '../electron/adb/client'
import type { EnqueueIntent } from '../electron/transfer/service'
import type { TransferTask } from '../src/shared/transfer'

/*
 * 截图 / 录屏的编排（P1 第一批）。
 *
 * 被测对象是「一次意图 → 一串 adb 命令 + 一次入队 + 一次清理」这条链路。
 * 全部用假 client / 假录屏句柄，断言的是**命令序列**与**清理时机**：
 * 这两件事真机上出错都是「用户看不见的垃圾文件」或「拉回来的是半截文件」。
 */

interface Call { args: string[]; }

/*
 * 目标目录必须是**真实存在**的目录。
 *
 * 服务对 dstDir 做的是「解析 + stat 确认是目录」（与传输队列同一条规矩：
 * 落盘前就判掉不存在的目录，否则失败会发生在执行阶段、错误码笼统成 E_SYNC_FAILED）。
 * 所以测试不能塞一个不存在的假目录 —— 那测的就不是真实判定了。
 */
const LOCAL_DIR = mkdtempSync(path.join(tmpdir(), 'adbfm-capture-'))

function fakeClient(result: (args: string[]) => RunResult | Promise<RunResult> = () => ({ code: 0, stdout: '', stderr: '' })) {
  const calls: Call[] = []
  return {
    calls,
    args: () => calls.map((c) => c.args.join(' ')),
    run: async (args: string[]): Promise<RunResult> => {
      calls.push({ args })
      return result(args)
    },
  }
}

function online(serial: string): DeviceSession {
  return {
    serial,
    status: 'device',
    transport: 'usb',
    model: 'Pixel',
    android: '14',
    lastSeenAt: Date.now(),
  } as DeviceSession
}

function task(input: EnqueueIntent): TransferTask {
  return {
    id: 'T' + Math.random().toString(36).slice(2, 8),
    serial: input.serial,
    direction: input.direction,
    src: input.src,
    dst: input.dstDir + '/' + input.src.split('/').pop(),
    totalBytes: 100,
    doneBytes: 0,
    status: 'queued',
    attempt: 0,
    createdAt: Date.now(),
  }
}

function harness(over: Partial<CaptureDeps> & { enqueueError?: string } = {}) {
  const client = fakeClient(() => ({ code: 0, stdout: '', stderr: '' }))
  const enqueued: EnqueueIntent[] = []
  const settled = new Map<string, () => void>()
  const handles: Array<RecordHandle & { stopped: number; killed: number; fire: (code: number | null) => void }> = []
  const deps: CaptureDeps = {
    devices: { get: (serial) => (serial === 'GONE' ? undefined : online(serial)) },
    clientFor: () => client,
    transfer: {
      enqueue: async (input) => {
        if (over.enqueueError !== undefined) throw new Error(over.enqueueError)
        enqueued.push(input)
        const created = task(input)
        settled.set(created.id, () => undefined)
        return created
      },
    },
    adbPath: () => 'C:/adb.exe',
    defaultDstDir: () => LOCAL_DIR,
    startRecording: () => {
      const callbacks: Array<(info: { code: number | null }) => void> = []
      const handle = {
        stopped: 0,
        killed: 0,
        onExit: (cb: (info: { code: number | null }) => void) => { callbacks.push(cb) },
        requestStop: async () => { handle.stopped += 1 },
        kill: async () => { handle.killed += 1 },
        fire: (code: number | null) => { for (const cb of callbacks) cb({ code }) },
      }
      handles.push(handle)
      return handle
    },
    onTaskSettled: (taskId, callback) => { settled.set(taskId, callback) },
    now: () => 1700000000000,
    ...over,
  }
  return { service: new CaptureService(deps), client, enqueued, settled, handles }
}

describe('截图：命令序列与入队', () => {
  it('先 mkdir -p 再 screencap，最后入队 pull（二进制绝不走 stdout）', async () => {
    const { service, client, enqueued } = harness()
    const result = await service.screenshot('S1', LOCAL_DIR)

    const args = client.args()
    expect(args[0]).toContain('mkdir -p')
    expect(args.some((a) => a.includes('screencap -p'))).toBe(true)
    /*
     * 截图用的是「写设备文件」而不是读 stdout；路径经 shellQuote 加了单引号
     * （设备侧路径来自拼串，必须按单词转义）。这里按「前缀 + 引号」断言，
     * 而不是强求某一种引号写法 —— 断言的是落点，不是转义风格。
     */
    expect(args.some((a) => a.includes('screencap -p') && a.includes('/sdcard/.adbfm/S1/'))).toBe(true)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].direction).toBe('pull')
    expect(enqueued[0].src).toContain('/sdcard/.adbfm/S1/')
    expect(result.localPath).toContain('adbfm-shot-')
    expect(result.serial).toBe('S1')
  })

  it('截图前先扫掉这台设备的陈旧残留（唯一能覆盖「进程被强杀」的出口）', async () => {
    const { service, client } = harness()
    await service.screenshot('S1', LOCAL_DIR)
    const args = client.args()
    const sweepIndex = args.findIndex((a) => a.includes('rm -f') && a.includes('*.png'))
    const shotIndex = args.findIndex((a) => a.includes('screencap'))
    expect(sweepIndex).toBeGreaterThanOrEqual(0)
    expect(sweepIndex).toBeLessThan(shotIndex)
    /*
     * 清扫范围严格限制在本机子目录内，不会碰别的设备的在途文件。
     * 注意实际命令形如 rm -f '/sdcard/.adbfm/S1'/*.png —— 目录被引号包住、
     * 通配符裸露在外（加上引号通配符就成了字面量，什么也删不掉）。
     */
    expect(args[sweepIndex]).toContain('/sdcard/.adbfm/S1')
    expect(args[sweepIndex]).not.toContain('/sdcard/.adbfm/*.png')
  })

  it('screencap 非零退出 → 抛对应错误码，且不入队', async () => {
    const client = fakeClient((args) =>
      args.join(' ').includes('screencap')
        ? { code: 1, stdout: '', stderr: 'Permission denied' }
        : { code: 0, stdout: '', stderr: '' },
    )
    const enqueued: EnqueueIntent[] = []
    const service = new CaptureService({
      devices: { get: () => online('S1') },
      clientFor: () => client,
      transfer: { enqueue: async (input) => { enqueued.push(input); return task(input) } },
      adbPath: () => 'C:/adb.exe',
      defaultDstDir: () => LOCAL_DIR,
      startRecording: () => null,
      onTaskSettled: () => undefined,
      now: () => 1,
    })
    await expect(service.screenshot('S1', LOCAL_DIR)).rejects.toThrow('E_NO_PERMISSION')
    expect(enqueued).toHaveLength(0)
  })

  it('入队失败时立即清掉设备上的临时文件（否则那张 png 永久留下）', async () => {
    const { service, client } = harness({ enqueueError: 'E_SYNC_FAILED' })
    await expect(service.screenshot('S1', LOCAL_DIR)).rejects.toThrow('E_SYNC_FAILED')
    const args = client.args()
    const shotIndex = args.findIndex((a) => a.includes('screencap'))
    const cleanupIndex = args.map((a, i) => ({ a, i })).filter((x) => x.a.includes('rm -f') && x.i > shotIndex)
    expect(cleanupIndex.length).toBeGreaterThan(0)
    expect(cleanupIndex[0].a).toContain('/sdcard/.adbfm/S1/')
  })

  it('离线 / 未授权设备在发命令之前就失败（零 adb 命令）', async () => {
    const { service, client } = harness()
    await expect(service.screenshot('GONE', LOCAL_DIR)).rejects.toThrow('E_NO_SERIAL')
    expect(client.calls).toHaveLength(0)
  })

  it('dstDir 传空串 = 用默认下载路径（渲染层不抄一份设置值）', async () => {
    const { service, enqueued } = harness()
    const result = await service.screenshot('S1', '')
    /*
     * 断言的是**三件事**，而不是「路径字符串相等」：
     *   1. 入队的落点就是那个默认目录（按目录名辨认）；
     *   2. 本地落点就在入队目录里；
     *   3. 返回的 localPath 与入队目录一致（用户要复制的是它）。
     *
     * 为什么不用 realpath 做字符串比较：Windows 临时目录同时存在长名
     * （Administrator）与 8.3 短名（ADMINI~1），而 Node 的 realpathSync 不会把
     * 短名展开成短名（两个方向不对称），字符串比较会把同一个目录判成两个 ——
     * 那是断言过严，不是实现有问题。
     */
    const expectedName = path.basename(LOCAL_DIR)
    expect(path.basename(enqueued[0].dstDir)).toBe(expectedName)
    expect(path.basename(path.dirname(result.localPath))).toBe(expectedName)
    expect(enqueued[0].dstDir).toBe(path.dirname(result.localPath))
  })
})

describe('录屏：会话生命周期', () => {
  it('开始录屏只起进程，不产生传输任务（文件在停止后才有）', async () => {
    const { service, enqueued, handles } = harness()
    const started = await service.startRecord('S1', LOCAL_DIR)
    expect(handles).toHaveLength(1)
    expect(enqueued).toHaveLength(0)
    expect(started.maxSeconds).toBeGreaterThan(0)
    expect(started.localPath).toContain('adbfm-rec-')
  })

  it('同一台设备不能开两条录制（会抢同一块编码器，且停止无法说清停哪条）', async () => {
    const { service } = harness()
    await service.startRecord('S1', LOCAL_DIR)
    await expect(service.startRecord('S1', LOCAL_DIR)).rejects.toThrow('E_RECORD_ACTIVE')
  })

  it('停止时先让设备侧收尾，再入队拉回（顺序颠倒会拿到半截文件）', async () => {
    const { service, enqueued, handles } = harness()
    await service.startRecord('S1', LOCAL_DIR)
    const handle = handles[0]

    const stopping = service.stopRecord('S1')
    // 手动触发「进程已退出」，stop 才会继续往下走
    handle.fire(0)
    const result = await stopping

    expect(handle.stopped).toBe(1)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].src).toContain('adbfm-rec-')
    expect(result.localPath).toContain('adbfm-rec-')
    expect(service.activeRecordings).toBe(0)
  })

  it('没有在录的时候停止 → E_NOT_RECORDING（不是静默成功）', async () => {
    const { service } = harness()
    await expect(service.stopRecord('S1')).rejects.toThrow('E_NOT_RECORDING')
  })

  it('自然退出（到时间上限）也会把文件拉回来，不需要用户再点一次停止', async () => {
    const { service, enqueued, handles } = harness()
    await service.startRecord('S1', LOCAL_DIR)
    handles[0].fire(0)
    // onExit 里的收尾是异步的：等一轮微任务
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(enqueued).toHaveLength(1)
    expect(service.activeRecordings).toBe(0)
  })

  it('stop 之后会话被摘掉，重复 stop 得到 E_NOT_RECORDING', async () => {
    const { service, handles } = harness()
    await service.startRecord('S1', LOCAL_DIR)
    const stopping = service.stopRecord('S1')
    handles[0].fire(0)
    await stopping
    await expect(service.stopRecord('S1')).rejects.toThrow('E_NOT_RECORDING')
  })
})

describe('退出收尾', () => {
  it('dispose 会逐台请求停止录制并清空会话表', async () => {
    const { service, handles } = harness()
    await service.startRecord('S1', LOCAL_DIR)
    await service.startRecord('S2', LOCAL_DIR)
    service.dispose()
    expect(handles.every((h) => h.stopped === 1)).toBe(true)
    expect(service.activeRecordings).toBe(0)
  })

  it('dispose 会兑现未结算的临时文件清理（否则设备上留 png）', async () => {
    const { service, client, settled } = harness()
    await service.screenshot('S1', LOCAL_DIR)
    expect(service.pendingCleanups).toBe(1)
    service.dispose()
    expect(service.pendingCleanups).toBe(0)
    // dispose 之后仍然发出了 rm
    expect(client.args().some((a) => a.includes('rm -f') && a.includes('.png'))).toBe(true)
    // 而且结算表里那条不会被再执行一次
    expect(settled.size).toBeGreaterThan(0)
  })

  it('dispose 之后登记的清理立即执行（退出竞态下不等待）', async () => {
    const { service, client } = harness()
    service.dispose()
    await service.screenshot('S1', LOCAL_DIR)
    expect(service.pendingCleanups).toBe(0)
    expect(client.args().some((a) => a.includes('rm -f'))).toBe(true)
  })
})
