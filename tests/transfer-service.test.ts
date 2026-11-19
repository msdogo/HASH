import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TransferService, fileNameOf, resolveTargetPath, listLocalFiles } from '../electron/transfer/service'
import { E_INVALID_PATH } from '../src/shared/errors'
import type { TransferEvent } from '../electron/transfer/manager'

/*
 * 生产装配层：把「渲染层意图」翻成完整路径 + 取 totalBytes（裁决 5）。
 * 执行器用假 runner，只验证路径与总量，不碰真 adb。
 */

const dirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'task8-svc-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function service(over: { files?: Record<string, number>; events?: TransferEvent[] } = {}): TransferService {
  const files = over.files ?? {}
  const events = over.events ?? []
  return new TransferService({
    adbPath: () => 'C:/adb.exe',
    clientFor: () => ({ serial: 'S1' }) as never,
    emit: (event) => { events.push(event) },
    runner: () => ({
      resolveTotalBytes: async (_d: string, src: string) => files[src] ?? null,
      run: async () => ({ ok: true as const, bytes: 0, overwrote: false }),
    }) as never,
  })
}

describe('路径解析', () => {
  it('fileNameOf 同时认 / 与 \\', () => {
    expect(fileNameOf('/sdcard/Download/中文 文件.bin')).toBe('中文 文件.bin')
    expect(fileNameOf('C:\\Users\\u\\照片 1.jpg')).toBe('照片 1.jpg')
  })

  it('resolveTargetPath 拼接并归一化；含分隔符的名字被拒（防目录穿越）', () => {
    expect(resolveTargetPath('/sdcard/Download', 'a.bin')).toBe('/sdcard/Download/a.bin')
    expect(resolveTargetPath('/sdcard/Download/', 'a.bin')).toBe('/sdcard/Download/a.bin')
    // 名字里带分隔符 = 试图改变目标目录，必须拒掉
    expect(() => resolveTargetPath('/sdcard/Download', '../etc/passwd')).toThrow(E_INVALID_PATH)
    expect(() => resolveTargetPath('/sdcard/Download', 'sub/a.bin')).toThrow(E_INVALID_PATH)
    expect(() => resolveTargetPath('/sdcard/Download', '..')).toThrow(E_INVALID_PATH)
    expect(() => resolveTargetPath('/sdcard/Download', '')).toThrow(E_INVALID_PATH)
  })

  it('根目录下的目标是 /name 而不是 //name', () => {
    expect(resolveTargetPath('/', 'a.bin')).toBe('/a.bin')
  })
})

describe('upload：totalBytes 用本地 stat（裁决 5）', () => {
  it('push 入队时总量已知，且目标路径是设备目录 + 文件名', async () => {
    const dir = tmpDir()
    const local = path.join(dir, '中文 文件.bin')
    writeFileSync(local, Buffer.alloc(2048))
    const svc = service()
    const task = svc.enqueue({ serial: 'S1', direction: 'push', src: local, dstDir: '/sdcard/Download' })
    expect(task.totalBytes).toBe(2048)
    expect(task.dst).toBe('/sdcard/Download/中文 文件.bin')
  })

  it('本地文件不存在 → 抛错（不静默入队一个注定失败的任务）', () => {
    const svc = service()
    expect(() => svc.enqueue({
      serial: 'S1', direction: 'push', src: path.join(tmpDir(), 'nope.bin'), dstDir: '/sdcard',
    })).toThrow()
  })
})

describe('download：totalBytes 未知时走不确定态（裁决 5）', () => {
  it('pull 入队时 totalBytes 为 null，随后由 resolveTotal 异步补齐', async () => {
    const dir = tmpDir()
    const svc = service({ files: { '/sdcard/Download/a.bin': 12345 } })
    const task = svc.enqueue({ serial: 'S1', direction: 'pull', src: '/sdcard/Download/a.bin', dstDir: dir })
    // 入队瞬间还不知道总量 → 界面显示不确定态，而不是 0%
    expect(task.totalBytes).toBeNull()
    expect(task.dst).toBe(path.join(dir, 'a.bin'))
    // 异步探测补齐（allow a couple of ticks）
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(svc.manager.get(task.id)?.totalBytes).toBe(12345)
  })

  it('远程总量探测不到时永远保持 null（不确定态），不会编一个 0', async () => {
    const dir = tmpDir()
    const svc = service({ files: {} })
    const task = svc.enqueue({ serial: 'S1', direction: 'pull', src: '/sdcard/x.bin', dstDir: dir })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(svc.manager.get(task.id)?.totalBytes).toBeNull()
  })

  it('本地目标目录不存在 → 抛错', () => {
    const svc = service()
    expect(() => svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/sdcard/a.bin', dstDir: path.join(tmpDir(), 'missing'),
    })).toThrow()
  })
})

describe('listLocalFiles', () => {
  it('只列普通文件，跳过子目录；不存在目录返回空数组', () => {
    const dir = tmpDir()
    writeFileSync(path.join(dir, 'a.txt'), 'aa')
    mkdirSync(path.join(dir, 'sub'))
    const files = listLocalFiles(dir)
    expect(files.map((f) => f.name)).toEqual(['a.txt'])
    expect(files[0].size).toBe(2)
    expect(listLocalFiles(path.join(dir, 'nope'))).toEqual([])
  })
})
