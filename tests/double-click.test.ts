import { describe, it, expect, vi } from 'vitest'
import {
  decideDoubleClick,
  makeSingleFileDownload,
  openFile,
  remoteSizeTrustworthy,
  type OpenFileDeps,
} from '../src/shared/double-click'
import type { LocalFileStat } from '../src/shared/file-ops'
import type { FileEntry, IpcResult } from '../src/shared/types'
import { t } from '../src/shared/i18n'

/*
 * R10：双击文件自动下载的判定与编排。
 *
 * 本文件**不读源码文本**：所有断言都是喂输入、看输出（返回值 / 注入的假实现被怎么调用）。
 * 每条都用变异验证过（改坏实现 → 对应用例必须红，数字记录在 r10-dblclick-report.md）。
 */

function entry(over: Partial<FileEntry> = {}): FileEntry {
  return {
    name: 'a.txt',
    isDir: false,
    isLink: false,
    size: 100,
    mtime: 1_700_000_000_000,
    mode: '-rw-rw----',
    owner: 'u0_a1',
    group: 'u0_a1',
    ...over,
  }
}

const EXISTS_SAME: LocalFileStat = { exists: true, size: 100 }
const EXISTS_DIFF: LocalFileStat = { exists: true, size: 200 }
const ABSENT: LocalFileStat = { exists: false }

describe('R10 判定真值表（六行全覆盖）', () => {
  it('目录 + 任意本地状态 → enter（双击目录仍然进目录）', () => {
    for (const local of [ABSENT, EXISTS_SAME, EXISTS_DIFF, null]) {
      expect(decideDoubleClick(entry({ isDir: true }), local)).toBe('enter')
    }
  })

  it('文件 + 本地不存在 → download', () => {
    expect(decideDoubleClick(entry(), ABSENT)).toBe('download')
  })

  it('文件 + 本地存在且大小相同 → skip-exists（不下载）', () => {
    expect(decideDoubleClick(entry({ size: 100 }), EXISTS_SAME)).toBe('skip-exists')
  })

  it('文件 + 本地存在但大小不同 → download（覆盖，用户裁决）', () => {
    expect(decideDoubleClick(entry({ size: 100 }), EXISTS_DIFF)).toBe('download')
  })

  it('文件 + 查询失败（null）→ download（查不了也照常下，绝不拦）', () => {
    expect(decideDoubleClick(entry(), null)).toBe('download')
  })

  it('文件 + 远端 size 不可信 → download（metaKnown=false 时本地哪怕同名同 size 也不跳过）', () => {
    // 这一行是最容易被写错的边界：本地正好有 0 字节同名文件时，若拿不可信的 0 去比，
    // 用户会看到「文件已存在」而永远拿不到真正的内容。
    expect(decideDoubleClick(entry({ size: 0, metaKnown: false }), { exists: true, size: 0 })).toBe('download')
    expect(decideDoubleClick(entry({ size: 0 }), { exists: true, size: 0 })).toBe('download')
    expect(decideDoubleClick(entry({ size: Number.NaN }), { exists: true, size: Number.NaN })).toBe('download')
    expect(decideDoubleClick(entry({ size: -1 }), { exists: true, size: -1 })).toBe('download')
  })
})

describe('R10 远端 size 可信度（isMetaKnown 的对应物）', () => {
  it('缺省 metaKnown 视为可信；显式 false 视为不可信', () => {
    expect(remoteSizeTrustworthy({ isDir: false, size: 10 })).toBe(true)
    expect(remoteSizeTrustworthy({ isDir: false, size: 10, metaKnown: true })).toBe(true)
    expect(remoteSizeTrustworthy({ isDir: false, size: 10, metaKnown: false })).toBe(false)
  })

  it('size <= 0 / 非有限数一律不可信（0 与「没读到」数值重合）', () => {
    expect(remoteSizeTrustworthy({ isDir: false, size: 0 })).toBe(false)
    expect(remoteSizeTrustworthy({ isDir: false, size: 0, metaKnown: true })).toBe(false)
    expect(remoteSizeTrustworthy({ isDir: false, size: -5 })).toBe(false)
    expect(remoteSizeTrustworthy({ isDir: false, size: Number.NaN })).toBe(false)
    expect(remoteSizeTrustworthy({ isDir: false, size: Number.POSITIVE_INFINITY })).toBe(false)
  })
})

describe('R10 双击只入队 1 个任务（不走向选中集合）', () => {
  it('makeSingleFileDownload 交给 run 的源数组长度恒为 1，且就是那一个文件', async () => {
    const run = vi.fn(async () => null)
    const download = makeSingleFileDownload({
      serial: 'S1',
      run,
      localDir: () => 'C:/Users/me/Downloads',
      notify: () => undefined,
    })
    const code = await download('/sdcard/DCIM/one.jpg')
    expect(code).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
    const args = run.mock.calls[0] as unknown as [string, string[], string]
    expect(args[0]).toBe('S1')
    expect(args[1]).toEqual(['/sdcard/DCIM/one.jpg'])
    expect(args[2]).toBe('C:/Users/me/Downloads')
  })

  it('连续双击两个不同文件 → 两次各自 1 项（不会合并成一批）', async () => {
    // 形参写全（而不是 () => null）：否则 mock.calls 的元素类型是空元组，取不到 [1]
    const run = vi.fn(async (_serial: string, _sources: string[], _localDir: string) => null)
    const download = makeSingleFileDownload({ serial: 'S1', run, localDir: () => 'C:/d', notify: () => undefined })
    await download('/sdcard/a.txt')
    await download('/sdcard/b.txt')
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[0]?.[1]).toEqual(['/sdcard/a.txt'])
    expect(run.mock.calls[1]?.[1]).toEqual(['/sdcard/b.txt'])
  })

  it('没有本地目录时 run 零调用，只提示 op.needLocalDir（复用既有流程）', async () => {
    const run = vi.fn(async () => null)
    const notify = vi.fn()
    const download = makeSingleFileDownload({ serial: 'S1', run, localDir: () => undefined, notify })
    await download('/sdcard/a.txt')
    expect(run).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(t('op.needLocalDir'))
  })
})

describe('R10 openFile 编排：预检 → 判定 → 跳过或入队', () => {
  function deps(over: Partial<OpenFileDeps> = {}): OpenFileDeps & {
    notified: Array<string | null>
    enqueued: string[]
    prechecked: Array<{ dir: string; name: string }>
  } {
    const notified: Array<string | null> = []
    const enqueued: string[] = []
    const prechecked: Array<{ dir: string; name: string }> = []
    return {
      serial: 'S1',
      cwd: '/sdcard/DCIM',
      localDir: () => 'C:/Users/me/Downloads',
      precheck: async (input): Promise<IpcResult<LocalFileStat>> => {
        prechecked.push(input)
        return { ok: true, data: ABSENT }
      },
      downloadOne: async (target) => {
        enqueued.push(target)
        return null
      },
      notify: (text) => { notified.push(text) },
      ...over,
      notified,
      enqueued,
      prechecked,
    }
  }

  it('同名同大小 → skip-exists：不入队、队列长度不变、提示「文件已存在」', async () => {
    const d = deps({ precheck: async () => ({ ok: true, data: EXISTS_SAME }) })
    const outcome = await openFile(d, entry({ size: 100 }))
    expect(outcome).toEqual({ kind: 'skipped-exists' })
    expect(d.enqueued).toEqual([])
    expect(d.notified).toEqual([t('transfer.existsSkipped')])
  })

  it('同名不同大小 → 入队（覆盖），不提示「已存在」', async () => {
    const d = deps({ precheck: async () => ({ ok: true, data: EXISTS_DIFF }) })
    const outcome = await openFile(d, entry({ size: 100 }))
    expect(outcome).toEqual({ kind: 'queued', code: null })
    expect(d.enqueued).toEqual(['/sdcard/DCIM/a.txt'])
    expect(d.notified).toEqual([])
  })

  it('预检失败（ok:false / 抛错）→ 照常下载，不拦', async () => {
    const failed = deps({ precheck: async () => ({ ok: false, error: 'E_NO_PERMISSION' }) })
    expect(await openFile(failed, entry())).toEqual({ kind: 'queued', code: null })
    expect(failed.enqueued).toEqual(['/sdcard/DCIM/a.txt'])

    const throwing = deps({
      precheck: async () => { throw new Error('boom') },
    })
    // openFile 不自己 catch：抛错会把异常交给调用方（FilesPage 的 void 调用不会崩页面，
    // 但这里要保证「预检是实现方的事，不是拦路条件」—— FilesPage 注入的是 window.api 调用，
    // IPC 层已经把异常收敛成 { ok:false }，见 electron/ipc/handlers.ts 的 try/catch）
    await expect(openFile(throwing, entry())).rejects.toThrow('boom')
    expect(throwing.enqueued).toEqual([])
  })

  it('远端 size 不可信 → 即使本地同名同 size 也入队（不误判成已存在）', async () => {
    const d = deps({ precheck: async () => ({ ok: true, data: { exists: true, size: 0 } }) })
    const outcome = await openFile(d, entry({ size: 0, metaKnown: false }))
    expect(outcome).toEqual({ kind: 'queued', code: null })
    expect(d.enqueued).toEqual(['/sdcard/DCIM/a.txt'])
  })

  it('没有本地目录 → 提示 op.needLocalDir，不入队、连预检都不发', async () => {
    const d = deps({ localDir: () => undefined })
    const outcome = await openFile(d, entry())
    expect(outcome).toEqual({ kind: 'no-local-dir' })
    expect(d.enqueued).toEqual([])
    expect(d.prechecked).toEqual([])
    expect(d.notified).toEqual([t('op.needLocalDir')])
  })

  it('没有设备（serial=null）→ 什么都不做', async () => {
    const d = deps({ serial: null })
    const outcome = await openFile(d, entry())
    expect(outcome).toEqual({ kind: 'not-a-file' })
    expect(d.enqueued).toEqual([])
    expect(d.notified).toEqual([])
  })

  it('目录进到这个函数也不会被下载（防御：目录永远是 enter）', async () => {
    const d = deps()
    const outcome = await openFile(d, entry({ isDir: true }))
    expect(outcome).toEqual({ kind: 'not-a-file' })
    expect(d.enqueued).toEqual([])
  })

  it('预检拿到的是「设置里的下载目录 + 远端文件名」，不是自己拼的完整路径', async () => {
    const d = deps()
    await openFile(d, entry({ name: 'IMG 001.jpg' }))
    expect(d.prechecked).toEqual([{ dir: 'C:/Users/me/Downloads', name: 'IMG 001.jpg' }])
  })

  it('设备侧源路径走 joinEntryPath（含空格与中文的名字原样保留）', async () => {
    const d = deps()
    await openFile(d, entry({ name: '我的 照片.jpg' }))
    expect(d.enqueued).toEqual(['/sdcard/DCIM/我的 照片.jpg'])
  })
})
