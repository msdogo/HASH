import { describe, it, expect, vi } from 'vitest'
import {
  collectDroppedPaths,
  dragOutTargets,
  dropNotice,
  enqueueDroppedFiles,
  prepareDropTarget,
  readDroppedFiles,
  type DragEventLike,
} from '../src/shared/drag'
import { E_NOT_A_DIRECTORY, E_PROTECTED_PATH } from '../src/shared/errors'
import { errorText } from '../src/shared/i18n'
import type { FileEntry, IpcResult } from '../src/shared/types'
import type { TransferTask } from '../src/shared/transfer'

/*
 * 简报 C 的拖入纯逻辑。
 *
 * 全部是**行为断言**：入参逐字段、调用次数、零调用用 not.toHaveBeenCalled()。
 * 一条 toContain(源码文本) 都没有 —— 本项目已经在这上面吃过 14 次亏。
 */

function entry(name: string, over: Partial<FileEntry> = {}): FileEntry {
  return { name, isDir: false, isLink: false, size: 1, mtime: 0, mode: '', owner: '', group: '', ...over }
}

function task(src: string): TransferTask {
  return {
    id: 't-' + src, serial: 'S1', direction: 'push', src, dst: '/sdcard/x',
    totalBytes: 1, doneBytes: 0, status: 'queued', attempt: 0, createdAt: 0,
  }
}

/** 把路径映射成「File」的假 getPath：不认识的返回空串（=不是磁盘文件）。 */
function fakeGetPath(map: Record<string, string>): (file: unknown) => string {
  return (file) => map[String(file)] ?? ''
}

describe('collectDroppedPaths：File → 磁盘路径', () => {
  it('拿到绝对路径，保持 drop 顺序，空串被跳过并计数', () => {
    const scan = collectDroppedPaths(
      ['a', 'web', 'b'],
      fakeGetPath({ a: 'C:/a.txt', b: 'C:/b.txt' }),
    )
    expect(scan.paths).toEqual(['C:/a.txt', 'C:/b.txt'])
    expect(scan.skipped).toBe(1)
    expect(scan.duplicates).toBe(0)
  })

  it('同一批里的重复路径只留一条并计数（否则第二条会撞「目标已存在」）', () => {
    const scan = collectDroppedPaths(
      ['a', 'a', 'b'],
      fakeGetPath({ a: 'C:/a.txt', b: 'C:/b.txt' }),
    )
    expect(scan.paths).toEqual(['C:/a.txt', 'C:/b.txt'])
    expect(scan.duplicates).toBe(1)
  })

  it('全部不是磁盘文件时 paths 为空（绝不能把空串交给入队）', () => {
    const scan = collectDroppedPaths(['web', 'web2'], fakeGetPath({}))
    expect(scan.paths).toEqual([])
    expect(scan.skipped).toBe(2)
  })
})

describe('enqueueDroppedFiles：入队入参逐字段 + 次数', () => {
  it('每个有效路径各入队一次，direction 固定 push，dstDir 是当前目录', async () => {
    const enqueue = vi.fn(async (input: { src: string }): Promise<IpcResult<TransferTask>> =>
      ({ ok: true, data: task(input.src) }))
    const result = await enqueueDroppedFiles(
      { getPath: fakeGetPath({ a: 'C:/a.txt', b: 'C:/b.txt' }), enqueue },
      'SERIAL1',
      ['a', 'b'],
      '/sdcard/Download',
    )

    expect(result).toEqual({ queued: 2, skipped: 0, duplicates: 0, firstError: null })
    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(enqueue).toHaveBeenNthCalledWith(1, {
      serial: 'SERIAL1', direction: 'push', src: 'C:/a.txt', dstDir: '/sdcard/Download',
    })
    expect(enqueue).toHaveBeenNthCalledWith(2, {
      serial: 'SERIAL1', direction: 'push', src: 'C:/b.txt', dstDir: '/sdcard/Download',
    })
  })

  it('空串路径一次都不入队（零调用），但计入 skipped', async () => {
    const enqueue = vi.fn(async (): Promise<IpcResult<TransferTask>> => ({ ok: true, data: task('x') }))
    const result = await enqueueDroppedFiles(
      { getPath: fakeGetPath({}), enqueue }, 'SERIAL1', ['web', 'web2'], '/sdcard',
    )
    expect(enqueue).not.toHaveBeenCalled()
    expect(result.queued).toBe(0)
    expect(result.skipped).toBe(2)
  })

  it('一项失败不中断其余项（逐项收集），并记住首个错误码', async () => {
    let call = 0
    const enqueue = vi.fn(async (input: { src: string }): Promise<IpcResult<TransferTask>> => {
      call += 1
      return call === 1 ? { ok: false, error: E_PROTECTED_PATH } : { ok: true, data: task(input.src) }
    })
    const result = await enqueueDroppedFiles(
      { getPath: fakeGetPath({ a: 'C:/a.txt', b: 'C:/b.txt' }), enqueue },
      'SERIAL1', ['a', 'b'], '/sdcard',
    )
    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(result.queued).toBe(1)
    expect(result.firstError).toBe(E_PROTECTED_PATH)
  })

  it('入队抛异常也被收敛成错误码，其余文件照常入队', async () => {
    let call = 0
    const enqueue = vi.fn(async (input: { src: string }): Promise<IpcResult<TransferTask>> => {
      call += 1
      if (call === 1) throw new Error(E_NOT_A_DIRECTORY)
      return { ok: true, data: task(input.src) }
    })
    const result = await enqueueDroppedFiles(
      { getPath: fakeGetPath({ a: 'C:/a.txt', b: 'C:/b.txt' }), enqueue },
      'SERIAL1', ['a', 'b'], '/sdcard',
    )
    expect(result.firstError).toBe(E_NOT_A_DIRECTORY)
    expect(result.queued).toBe(1)
  })
})

describe('dragOutTargets：拖出该带哪些路径', () => {
  it('拖的行未被选中 → 先选中它，只拖它自己', () => {
    const targets = dragOutTargets(entry('b.txt'), ['a.txt'], '/sdcard/Download')
    expect(targets.selectFirst).toBe(true)
    expect(targets.paths).toEqual(['/sdcard/Download/b.txt'])
  })

  it('拖的行已在选中集里 → 不改变选中，拖整个选中集（顺序按选中集）', () => {
    const targets = dragOutTargets(entry('b.txt'), ['a.txt', 'b.txt', 'c.txt'], '/sdcard')
    expect(targets.selectFirst).toBe(false)
    expect(targets.paths).toEqual(['/sdcard/a.txt', '/sdcard/b.txt', '/sdcard/c.txt'])
  })

  it('路径用设备侧正斜杠拼接（不会出现反斜杠）', () => {
    const targets = dragOutTargets(entry('中文 名.txt'), [], '/sdcard/Download')
    expect(targets.paths).toEqual(['/sdcard/Download/中文 名.txt'])
    expect(targets.paths[0]).not.toContain('\\')
  })
})

describe('dropNotice：结果 → 一句话（走 i18n）', () => {
  it('全部成功 → 报数量', () => {
    const text = dropNotice({ queued: 3, skipped: 0, duplicates: 0, firstError: null })
    expect(text).not.toBeNull()
    expect(text).toContain('3')
  })

  it('有失败 → 报错误码对应的中文（不是数量）', () => {
    /*
     * 【R2-1】这里原来用 E_OUTSIDE_ROOT 当「入队失败」的样例。该码随本地根沙箱一起移除，
     * 换成 E_PROTECTED_PATH（仍然存在的真实入队失败原因）——
     * 本用例测的是「错误码 → 中文文案」的透传，与具体是哪个码无关。
     */
    const text = dropNotice({ queued: 1, skipped: 0, duplicates: 0, firstError: E_PROTECTED_PATH })
    expect(text).not.toBeNull()
    expect(text).not.toContain('E_PROTECTED_PATH')
    // 与 i18n 表的映射直接比（文案改了也不会误判）
    expect(text).toBe(errorText(E_PROTECTED_PATH))
  })

  it('全部被跳过 → 说明「不是本机磁盘文件」，不是静默', () => {
    const text = dropNotice({ queued: 0, skipped: 2, duplicates: 0, firstError: null })
    expect(text).not.toBeNull()
    expect(text).toMatch(/跳过|无法上传/)
  })

  it('什么都没发生（空 drop）→ null（不打扰用户）', () => {
    expect(dropNotice({ queued: 0, skipped: 0, duplicates: 0, firstError: null })).toBeNull()
  })
})

describe('DOM 事件 → 纯判断', () => {
  function fakeEvent(files: unknown[] | null): DragEventLike & { defaults: number; effect: string | undefined } {
    const state = {
      defaults: 0,
      effect: undefined as string | undefined,
      preventDefault: () => { state.defaults += 1 },
      dataTransfer: files === null ? null : { files, dropEffect: undefined as string | undefined },
    }
    return state as unknown as DragEventLike & { defaults: number; effect: string | undefined }
  }

  it('dragover 必须 preventDefault 并标 copy（否则 drop 永远不触发 / 光标显示禁止）', () => {
    const event = fakeEvent(null)
    const dataTransfer = { files: [], dropEffect: undefined as string | undefined }
    const withTransfer = { ...event, dataTransfer } as unknown as DragEventLike
    prepareDropTarget(withTransfer)
    expect(event.defaults).toBe(1)
    expect(dataTransfer.dropEffect).toBe('copy')
  })

  it('dataTransfer 为 null 时不抛错（拖的是文本/什么都没拖）', () => {
    const event = fakeEvent(null)
    expect(() => prepareDropTarget(event)).not.toThrow()
    expect(event.defaults).toBe(1)
    expect(readDroppedFiles(event)).toEqual([])
  })

  it('readDroppedFiles 原样取出 File 列表（顺序不变）', () => {
    const files = ['f1', 'f2']
    expect(readDroppedFiles(fakeEvent(files))).toEqual(files)
  })
})
