import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TransferService, fileNameOf, resolveTargetPath, listLocalFiles } from '../electron/transfer/service'
import {
  E_INVALID_PATH,
  E_NOT_A_DIRECTORY,
  E_NOT_FOUND,
  E_PATH_UNSAFE,
  E_PROTECTED_PATH,
} from '../src/shared/errors'
import type { TransferEvent } from '../electron/transfer/manager'
import { isInsideRoot } from '../src/shared/path-guard'
import { makeOutsideHomeDir, realHome } from './outside-home'

/*
 * 生产装配层：把「渲染层意图」翻成完整路径 + 取 totalBytes（裁决 5）。
 * 执行器用假 runner，只验证路径与总量，不碰真 adb。
 *
 * ===== 复审 C1 / C2 之后这一层多了两道闸门 =====
 * 原来 enqueue 只做「本地文件存不存在」和「目标目录是不是目录」，
 * 于是传输通道成了整个应用里唯一**不过任何路径闸门**的写入口：
 *   - C1：pull 可以落到任意位置（且默认覆盖）；
 *   - C2：push 能写进 /data（真机验证过），pull 能拉走 /data 下任何 shell 可读文件。
 * 下面的用例全部是**行为级**的（真的调 enqueue 看它返回什么/抛什么），
 * 不是对源码做正则匹配 —— 本项目已经栽在两条空转的静态断言上了（审查 I1/I2）。
 *
 * ===== R2-1：C1 的**本地根目录**部分已由用户裁决移除 =====
 * 用户要求「彻底移除本地根目录限制」，所以原先「根外 dstDir/src → E_OUTSIDE_ROOT」
 * 那一组断言已改写为「根外位置现在必须能用」。
 * **C2（设备侧远程闸门）一个字都没动** —— 那与本地沙箱无关，是真机验证过的安全边界，
 * 对应用例（E_PATH_UNSAFE / E_PROTECTED_PATH）仍然逐条保留。
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

/** 本地工作目录：默认用第一个临时目录。R2-1 之后它只是「测试自己的目录」，不再是边界。 */
let workDir = ''
/**
 * 「主目录之外」的样本目录（R2-1 的核心场景）。第一次用到时创建，afterEach 里清。
 * 理由见 tests/outside-home.ts：os.tmpdir() 在 Windows 上就在主目录里。
 */
let outsideDir: string | null = null
function outsideHome(): string {
  if (outsideDir === null) {
    outsideDir = makeOutsideHomeDir()
    if (outsideDir === null) throw new Error('本机找不到主目录之外的可写目录，无法验证 R2-1')
  }
  mkdirSync(outsideDir, { recursive: true })
  return outsideDir
}
beforeAll(() => {
  workDir = realpathSync.native(tmpDir())
})
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
  if (outsideDir !== null) rmSync(outsideDir, { recursive: true, force: true })
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

  /*
   * 【第 2 轮复审 N3】这里原来断言「根目录下的目标是 /name 而不是 //name」，
   * 也就是把「往设备根写文件」当成合法路径来测。
   * 但同一份代码又拒绝 /sdcard（用户存储根）—— 两个判定自相矛盾，
   * 而真正危险的那一侧（/）反而是放行的。往设备根写文件没有任何合理场景，
   * 现在显式拒绝；用例改为断言拒绝。
   */
  it('往设备根目录写文件 → E_PROTECTED_PATH（不再为 / 开特例）', () => {
    expect(() => resolveTargetPath('/', 'a.bin')).toThrow(E_PROTECTED_PATH)
  })

  /*
   * 【第 2 轮复审 N2】用户存储根必须可写：它是首屏默认目录（file-view.ts 的
   * DEFAULT_CWD='/sdcard'），往里放文件是完全正常的操作。
   * 修前它被 isProtectedTransferPath 判成受保护对象而拒绝，
   * 结果是「打开应用第一屏就上传不了文件」。
   */
  it('用户存储根 /sdcard 可以作为上传目标目录（N2：首屏默认目录必须能传）', () => {
    expect(resolveTargetPath('/sdcard', 'a.bin')).toBe('/sdcard/a.bin')
    expect(resolveTargetPath('/storage/emulated/0', 'a.bin')).toBe('/storage/emulated/0/a.bin')
    expect(resolveTargetPath('/sdcard/Download', 'a.bin')).toBe('/sdcard/Download/a.bin')
  })

  it('【C2】resolveTargetPath 走严格闸门：含 .. 一律 E_PATH_UNSAFE（不再容错折叠）', () => {
    expect(() => resolveTargetPath('/sdcard/../data', 'x.bin')).toThrow(E_PATH_UNSAFE)
    expect(() => resolveTargetPath('/sdcard/Download/../DCIM', 'x.bin')).toThrow(E_PATH_UNSAFE)
    // 受保护根被拒
    expect(() => resolveTargetPath('/data', 'x.bin')).toThrow(E_PROTECTED_PATH)
    expect(() => resolveTargetPath('/system/bin', 'x')).toThrow(E_PROTECTED_PATH)
  })
})

/*
 * 【R2-1】这一组原来叫「裁决 5 / C1：本地写入必须落在用户选定的根目录内」，
 * 六条里有五条断言 E_OUTSIDE_ROOT。本地根沙箱被用户裁决移除后，
 * 那五条改成**行为证据**：根外位置现在真的能作为传输目标/来源。
 *
 * 刻意保留（与本地沙箱无关、修过的真实缺陷）：
 *   - 目标目录不存在 → E_NOT_FOUND（不是 E_INVALID_PATH）；
 *   - pull 的 src 以 .. 结尾时 dstDir 不得上跳。
 */
describe('R2-1：本地源与目标不再有根目录限制（任意位置都能传）', () => {
  it('目录里的目标目录 → 接受（正常路径不能误杀）', async () => {
    const dir = path.join(workDir, '下载')
    mkdirSync(dir, { recursive: true })
    const svc = service()
    const task = await svc.enqueue({ serial: 'S1', direction: 'pull', src: '/sdcard/Download/a.bin', dstDir: dir })
    expect(task.dst).toBe(path.join(dir, 'a.bin'))
  })

  /*
   * 裁决记要：复审曾建议「中间目录不存在时仍放行」，这里**选择拒绝**。
   * 理由：pull 要写到 <dir>/<name>.adbfm-part，父目录不存在时 adb pull 会失败，
   * 错误码是笼统的 E_SYNC_FAILED，用户看到「传输没有完成」而不是「目录不存在」。
   * 这条与根目录无关，R2-1 之后**仍然成立**（下面两条各测一个层次）。
   */
  it('目标目录不存在 → E_NOT_FOUND（错误必须落在入队，且文案要说「不存在」）', async () => {
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/sdcard/a.bin',
      dstDir: path.join(workDir, '还不存在的子目录'),
    // 【第 2 轮复审 C1】原来断言 E_INVALID_PATH（文案「路径含非法字符」），
    // 但真实语义是「这个目录不存在」。用户看到「路径不合法」会去检查拼写，
    // 而正确的动作是「先建这个目录」。
    })).rejects.toThrow(E_NOT_FOUND)
  })

  it('目标是一个普通文件而不是目录 → E_NOT_A_DIRECTORY（存在的对象也要判类型）', async () => {
    const file = path.join(workDir, 'not-a-dir.txt')
    writeFileSync(file, 'x')
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/sdcard/a.bin', dstDir: file,
    })).rejects.toThrow(E_NOT_A_DIRECTORY)
  })

  it('主目录之外的 dstDir → 成功入队，落盘路径就是那个目录 + 远程文件名', async () => {
    const outside = outsideHome()
    const svc = service()
    const task = await svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/sdcard/a.bin', dstDir: outside,
    })
    expect(task.dst).toBe(path.join(outside, 'a.bin'))
    expect(task.direction).toBe('pull')
  })

  it('用 .. 走出起始目录 → 成功，dst 落在归一化后的真实父目录下', async () => {
    const parent = realpathSync.native(path.dirname(workDir))
    const svc = service()
    const task = await svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/sdcard/a.bin',
      dstDir: path.join(workDir, '..'),
    })
    expect(task.dst).toBe(path.join(parent, 'a.bin'))
  })

  it('dstDir 是起始目录里的符号链接（指向主目录之外）→ 成功，dst 落在链接**指向**的真实目录', async () => {
    const outside = outsideHome()
    const linkPath = path.join(workDir, '外部链接')
    try {
      symlinkSync(outside, linkPath, 'dir')
    } catch {
      symlinkSync(outside, linkPath, 'junction')
    }
    const svc = service()
    const task = await svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/sdcard/a.bin', dstDir: linkPath,
    })
    // 判定路径 = 执行路径：链接被 realpath 展开，落盘位置就是目标目录
    expect(task.dst).toBe(path.join(outside, 'a.bin'))
  })

  it('【C1(b)】push 的本地源可以在主目录之外（拖入/上传不再受目录限制）', async () => {
    const outsideFile = path.join(outsideHome(), 'secret.bin')
    writeFileSync(outsideFile, 'x')
    // 前提：它真的在主目录之外（否则这条用例在根判定加回去时也不会红）
    expect(isInsideRoot(realHome(), outsideFile)).toBe(false)
    const svc = service()
    const task = await svc.enqueue({
      serial: 'S1', direction: 'push', src: outsideFile, dstDir: '/sdcard/Download',
    })
    expect(task.src).toBe(outsideFile)
    expect(task.dst).toBe('/sdcard/Download/secret.bin')
    expect(task.totalBytes).toBe(1)
  })

  it('【C1(c)】pull 的 src 以 .. 结尾时被拒，dstDir 不会被上跳（真实漏洞形态）', async () => {
    const dir = path.join(workDir, 'sub')
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
    const dir = path.join(workDir, 'sub2')
    mkdirSync(dir, { recursive: true })
    const svc = service()
    await expect(svc.enqueue({ serial: 'S1', direction: 'pull', src: '/sdcard/Download/.', dstDir: dir })).rejects.toThrow()
  })
})

describe('裁决 2 / C2：传输的远程路径同样过统一闸门', () => {
  it('push 到含 .. 的设备目录 → E_PATH_UNSAFE（不复审那次的容错折叠）', async () => {
    const local = path.join(workDir, 'a.bin')
    writeFileSync(local, Buffer.alloc(4))
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'push', src: local, dstDir: '/sdcard/../data/local/tmp',
    })).rejects.toThrow(E_PATH_UNSAFE)
  })

  it('push 到受保护的 /data → E_PROTECTED_PATH（真机曾可写入）', async () => {
    const local = path.join(workDir, 'b.bin')
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
    const dir = path.join(workDir, 'dl')
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
    const dir = path.join(workDir, 'dl2')
    mkdirSync(dir, { recursive: true })
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/sdcard/../data/x.txt', dstDir: dir,
    })).rejects.toThrow(E_PATH_UNSAFE)
  })

  it('正常的 /sdcard 目录仍然能传（不误杀）', async () => {
    const local = path.join(workDir, 'c.bin')
    writeFileSync(local, Buffer.alloc(4))
    const svc = service()
    const push = await svc.enqueue({ serial: 'S1', direction: 'push', src: local, dstDir: '/sdcard/Download' })
    expect(push.dst).toBe('/sdcard/Download/c.bin')
    const dir = path.join(workDir, 'dl3')
    mkdirSync(dir, { recursive: true })
    const pull = await svc.enqueue({ serial: 'S1', direction: 'pull', src: '/sdcard/Download/x.bin', dstDir: dir })
    expect(pull.dst).toBe(path.join(dir, 'x.bin'))
  })
})

describe('upload：totalBytes 用本地 stat（裁决 5）', () => {
  it('push 入队时总量已知，且目标路径是设备目录 + 文件名', async () => {
    const local = path.join(workDir, '中文 文件.bin')
    writeFileSync(local, Buffer.alloc(2048))
    const svc = service()
    const task = await svc.enqueue({ serial: 'S1', direction: 'push', src: local, dstDir: '/sdcard/Download' })
    expect(task.totalBytes).toBe(2048)
    expect(task.dst).toBe('/sdcard/Download/中文 文件.bin')
  })

  it('本地文件不存在 → 抛错（不静默入队一个注定失败的任务）', async () => {
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'push', src: path.join(workDir, 'nope.bin'), dstDir: '/sdcard',
    })).rejects.toThrow()
  })
})

describe('download：totalBytes 未知时走不确定态（裁决 5）', () => {
  it('pull 入队时 totalBytes 为 null，随后由 resolveTotal 异步补齐', async () => {
    const dir = path.join(workDir, 'p1')
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
    const dir = path.join(workDir, 'p2')
    mkdirSync(dir, { recursive: true })
    const svc = service({ files: {} })
    const task = await svc.enqueue({ serial: 'S1', direction: 'pull', src: '/sdcard/x.bin', dstDir: dir })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(svc.manager.get(task.id)?.totalBytes).toBeNull()
  })

  it('本地目标目录不存在 → 抛错', async () => {
    const svc = service()
    await expect(svc.enqueue({
      serial: 'S1', direction: 'pull', src: '/sdcard/a.bin', dstDir: path.join(workDir, 'missing'),
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
 * 【第 2 轮复审】这里原本有一组针对 assertSameDevice 的用例。
 * 那个函数生产代码一次都没调用（真正生效的跨 FS 判定在 RemoteOps.move 内部，
 * 那里能拿到 client、也在同一次 shell 往返里做判定），属于只被测试调用的死代码，
 * 已删除。
 *
 * I4 的行为断言仍然在：`tests/operations.test.ts` 的
 * `describe('审查 I4：跨文件系统移动必须拒绝（不可回滚）')` 走的是真实的
 * RemoteOps.move（假 fs 提供 stat -c %d），真机证据见 tests/ops-real.test.ts。
 */
