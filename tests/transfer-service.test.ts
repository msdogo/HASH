import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TransferService, fileNameOf, resolveTargetPath, listLocalFiles } from '../electron/transfer/service'
import {
  E_CROSS_DEVICE,
  E_INVALID_PATH,
  E_OUTSIDE_ROOT,
  E_PATH_UNSAFE,
  E_PROTECTED_PATH,
} from '../src/shared/errors'
import type { TransferEvent } from '../electron/transfer/manager'

/*
 * 生产装配层：把「渲染层意图」翻成完整路径 + 取 totalBytes（裁决 5）。
 * 执行器用假 runner，只验证路径与总量，不碰真 adb。
 *
 * ===== 复审 C1 / C2 之后这一层多了两道闸门 =====
 * 原来 enqueue 只做「本地文件存不存在」和「目标目录是不是目录」，
 * 于是传输通道成了整个应用里唯一**不过任何路径闸门**的写入口：
 *   - C1：pull 可以落到用户选定根目录之外的任何位置（且默认覆盖）；
 *   - C2：push 能写进 /data（真机验证过），pull 能拉走 /data 下任何 shell 可读文件。
 * 下面的用例全部是**行为级**的（真的调 enqueue 看它返回什么/抛什么），
 * 不是对源码做正则匹配 —— 本项目已经栽在两条空转的静态断言上了（审查 I1/I2）。
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

/** 本地根目录：默认用第一个临时目录，测试里可以换。 */
let localRoot = ''
beforeAll(() => {
  localRoot = realpathSync.native(tmpDir())
})
afterAll(() => {
  rmSync(localRoot, { recursive: true, force: true })
})

function service(over: { files?: Record<string, number>; events?: TransferEvent[]; root?: string } = {}): TransferService {
  const files = over.files ?? {}
  const events = over.events ?? []
  return new TransferService({
    adbPath: () => 'C:/adb.exe',
    clientFor: () => ({ serial: 'S1' }) as never,
    // C1：本地根目录必须注入（生产里是用户选定的目录，缺省家目录）
    localRoot: () => over.root ?? localRoot,
    emit: (event) => { events.push(event) },
    runner: () => ({
      resolveTotalBytes: async (_d: string, src: string) => files[src] ?? null,
      run: async () => ({ ok: true as const, bytes: 0, overwrote: false }),
      deviceOf: async () => 1,
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

  it('【C2】resolveTargetPath 走严格闸门：含 .. 一律 E_PATH_UNSAFE（不再容错折叠）', () => {
    expect(() => resolveTargetPath('/sdcard/../data', 'x.bin')).toThrow(E_PATH_UNSAFE)
    expect(() => resolveTargetPath('/sdcard/Download/../DCIM', 'x.bin')).toThrow(E_PATH_UNSAFE)
    // 受保护根被拒
    expect(() => resolveTargetPath('/data', 'x.bin')).toThrow(E_PROTECTED_PATH)
    expect(() => resolveTargetPath('/system/bin', 'x')).toThrow(E_PROTECTED_PATH)
  })
})

describe('裁决 5 / C1：本地写入必须落在用户选定的根目录内', () => {
  it('根内的目标目录 → 接受（正常路径不能误杀）', async () => {
    const dir = path.join(localRoot, '下载')
    mkdirSync(dir, { recursive: true })
    const svc = service()
    const task = await svc.enqueue({ serial: 'S1', direction: 'pull', src: '/sdcard/Download/a.bin', dstDir: dir })
    expect(task.dst).toBe(path.join(dir, 'a.bin'))
  })

  /*
   * 裁决记要（与复审建议的偏差，需在报告里说明）：
   * 复审建议「根内中间目录不存在时仍放行」，这里**选择拒绝**。
   * 理由：pull 要写到 <dir>/<name>.adbfm-part，父目录不存在时 adb pull 会失败，
   * 错误码是笼统的 E_SYNC_FAILED，用户看到「传输没有完成」而不是「目录不存在」。
   * 在入队时拒绝，错误落在正确的位置，且界面（本地栏）本来就是从真实存在的目录发起下载的。
   */
  it('根内的目标目录不存在 → 拒绝（错误必须落在入队，而不是执行阶段的笼统 E_SYNC_FAILED）', async () => {
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/sdcard/a.bin',
      dstDir: path.join(localRoot, '还不存在的子目录'),
    })).rejects.toThrow(E_INVALID_PATH)
  })

  it('完全在根外的 dstDir → E_OUTSIDE_ROOT（不复审那次「根外临时目录被接受」）', async () => {
    const outside = tmpDir()
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/sdcard/a.bin', dstDir: outside,
    })).rejects.toThrow(E_OUTSIDE_ROOT)
  })

  it('用 .. 逃出根 → E_OUTSIDE_ROOT', async () => {
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/sdcard/a.bin',
      dstDir: path.join(localRoot, '..', 'outside'),
    })).rejects.toThrow(E_OUTSIDE_ROOT)
  })

  it('符号链接逃逸 → E_OUTSIDE_ROOT（词法看不出来的那条）', async () => {
    const outside = tmpDir()
    const linkPath = path.join(localRoot, '逃逸链接')
    try {
      symlinkSync(outside, linkPath, 'dir')
    } catch {
      symlinkSync(outside, linkPath, 'junction')
    }
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/sdcard/a.bin', dstDir: linkPath,
    })).rejects.toThrow(E_OUTSIDE_ROOT)
  })

  it('【C1(b)】push 的本地源同样要过根目录闸门（读也要限制）', async () => {
    const outsideFile = path.join(tmpDir(), 'secret.bin')
    writeFileSync(outsideFile, 'x')
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'push', src: outsideFile, dstDir: '/sdcard/Download',
    })).rejects.toThrow(E_OUTSIDE_ROOT)
  })

  it('【C1(c)】pull 的 src 以 .. 结尾时被拒，dstDir 不会被上跳（真实漏洞形态）', async () => {
    const dir = path.join(localRoot, 'sub')
    mkdirSync(dir, { recursive: true })
    const svc = service()
    /*
     * 修前：fileNameOf('/sdcard/Download/..') === '..'，path.join(dir, '..') 直接上跳一级。
     * 修后名字在**第一道** assertPlainName 就被拒（E_INVALID_PATH）——
     * 比 E_PATH_UNSAFE 更早、更准确：问题出在「这个名字不是文件」，不是「路径含 ..」。
     */
    await expect(svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/sdcard/Download/..', dstDir: dir,
    })).rejects.toThrow(E_INVALID_PATH)
  })

  it('pull 的 src 以 . 或空名结尾时被拒', async () => {
    const dir = path.join(localRoot, 'sub2')
    mkdirSync(dir, { recursive: true })
    const svc = service()
    await expect(svc.enqueue({ serial: 'S1', direction: 'pull', src: '/sdcard/Download/.', dstDir: dir })).rejects.toThrow()
  })
})

describe('裁决 2 / C2：传输的远程路径同样过统一闸门', () => {
  it('push 到含 .. 的设备目录 → E_PATH_UNSAFE（不复审那次的容错折叠）', async () => {
    const local = path.join(localRoot, 'a.bin')
    writeFileSync(local, Buffer.alloc(4))
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'push', src: local, dstDir: '/sdcard/../data/local/tmp',
    })).rejects.toThrow(E_PATH_UNSAFE)
  })

  it('push 到受保护的 /data → E_PROTECTED_PATH（真机曾可写入）', async () => {
    const local = path.join(localRoot, 'b.bin')
    writeFileSync(local, Buffer.alloc(4))
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'push', src: local, dstDir: '/data/local/tmp',
    })).rejects.toThrow(E_PROTECTED_PATH)
    await expect(svc.enqueue({
      serial: 'S1', direction: 'push', src: local, dstDir: '/data',
    })).rejects.toThrow(E_PROTECTED_PATH)
  })

  it('从受保护目录 pull → E_PROTECTED_PATH（真机曾能拉走 /data 下任何可读文件）', async () => {
    const dir = path.join(localRoot, 'dl')
    mkdirSync(dir, { recursive: true })
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/data/local/tmp/secret.txt', dstDir: dir,
    })).rejects.toThrow(E_PROTECTED_PATH)
    await expect(svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/system/build.prop', dstDir: dir,
    })).rejects.toThrow(E_PROTECTED_PATH)
  })

  it('pull 的 src 含 .. → E_PATH_UNSAFE（原样零校验的那条）', async () => {
    const dir = path.join(localRoot, 'dl2')
    mkdirSync(dir, { recursive: true })
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/sdcard/../data/x.txt', dstDir: dir,
    })).rejects.toThrow(E_PATH_UNSAFE)
  })

  it('正常的 /sdcard 目录仍然能传（不误杀）', async () => {
    const local = path.join(localRoot, 'c.bin')
    writeFileSync(local, Buffer.alloc(4))
    const svc = service()
    const push = await svc.enqueue({ serial: 'S1', direction: 'push', src: local, dstDir: '/sdcard/Download' })
    expect(push.dst).toBe('/sdcard/Download/c.bin')
    const dir = path.join(localRoot, 'dl3')
    mkdirSync(dir, { recursive: true })
    const pull = await svc.enqueue({ serial: 'S1', direction: 'pull', src: '/sdcard/Download/x.bin', dstDir: dir })
    expect(pull.dst).toBe(path.join(dir, 'x.bin'))
  })
})

describe('upload：totalBytes 用本地 stat（裁决 5）', () => {
  it('push 入队时总量已知，且目标路径是设备目录 + 文件名', async () => {
    const local = path.join(localRoot, '中文 文件.bin')
    writeFileSync(local, Buffer.alloc(2048))
    const svc = service()
    const task = await svc.enqueue({ serial: 'S1', direction: 'push', src: local, dstDir: '/sdcard/Download' })
    expect(task.totalBytes).toBe(2048)
    expect(task.dst).toBe('/sdcard/Download/中文 文件.bin')
  })

  it('本地文件不存在 → 抛错（不静默入队一个注定失败的任务）', async () => {
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'push', src: path.join(localRoot, 'nope.bin'), dstDir: '/sdcard',
    })).rejects.toThrow()
  })
})

describe('download：totalBytes 未知时走不确定态（裁决 5）', () => {
  it('pull 入队时 totalBytes 为 null，随后由 resolveTotal 异步补齐', async () => {
    const dir = path.join(localRoot, 'p1')
    mkdirSync(dir, { recursive: true })
    const svc = service({ files: { '/sdcard/Download/a.bin': 12345 } })
    const task = await svc.enqueue({ serial: 'S1', direction: 'pull', src: '/sdcard/Download/a.bin', dstDir: dir })
    // 入队瞬间还不知道总量 → 界面显示不确定态，而不是 0%
    expect(task.totalBytes).toBeNull()
    expect(task.dst).toBe(path.join(dir, 'a.bin'))
    // 异步探测补齐（allow a couple of ticks）
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(svc.manager.get(task.id)?.totalBytes).toBe(12345)
  })

  it('远程总量探测不到时永远保持 null（不确定态），不会编一个 0', async () => {
    const dir = path.join(localRoot, 'p2')
    mkdirSync(dir, { recursive: true })
    const svc = service({ files: {} })
    const task = await svc.enqueue({ serial: 'S1', direction: 'pull', src: '/sdcard/x.bin', dstDir: dir })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(svc.manager.get(task.id)?.totalBytes).toBeNull()
  })

  it('本地目标目录不存在 → 抛错', async () => {
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/sdcard/a.bin', dstDir: path.join(localRoot, 'missing'),
    })).rejects.toThrow()
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

/*
 * 【审查 I4】跨文件系统移动：显式拒绝，而不是让 toybox 退化成不可回滚的「复制+删除」。
 *
 * 这一组只用纯函数判定（deviceOf 注入），真机证据见报告 I4 章节。
 */
describe('审查 I4：跨文件系统移动必须显式拒绝', () => {
  it('设备号不同 → E_CROSS_DEVICE（不执行任何命令）', async () => {
    const { assertSameDevice } = await import('../electron/transfer/service')
    // 假 runner 提供 deviceOf：源在 /data（dev 2），目标在 /sdcard（dev 1）
    const fake = async (p: string): Promise<number> => (p.startsWith('/data') ? 2 : 1)
    await expect(assertSameDevice(fake, '/data/local/tmp/a', '/sdcard/Download/a')).rejects.toThrow(E_CROSS_DEVICE)
  })

  it('设备号相同 → 放行（同 FS 的 mv 是内核 rename，原子）', async () => {
    const { assertSameDevice } = await import('../electron/transfer/service')
    const fake = async (): Promise<number> => 7
    await expect(assertSameDevice(fake, '/sdcard/A', '/sdcard/B')).resolves.toBeUndefined()
  })

  it('探测不到设备号时保守放行（取不到不构成本次操作的新风险）', async () => {
    const { assertSameDevice } = await import('../electron/transfer/service')
    const fake = async (): Promise<number | undefined> => undefined
    await expect(assertSameDevice(fake, '/sdcard/A', '/sdcard/B')).resolves.toBeUndefined()
  })
})
