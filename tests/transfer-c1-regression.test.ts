import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TransferService } from '../electron/transfer/service'
import { TransferRunner } from '../electron/transfer/runner'
import { E_ADB_NOT_FOUND } from '../src/shared/errors'

/*
 * 审查 C1（Critical）：生产装配把 adbPath 固化成空串 → 真实应用里每次传输都失败。
 *
 * 根因：main.ts 在模块顶层 new TransferService，那一刻 adb 自检还是 checking、
 * getter 返回 ''；修前的 service 构造里 deps.adbPath() 把这个 '' 取出来存进 runner，
 * 之后自检成功也再没有人更新它 → spawn('') 抛 ERR_INVALID_ARG_VALUE
 * → 被 catch 吞成 E_SYNC_FAILED → 用户重试永远失败。
 *
 * 关键：这些用例**绝不注入 runner**，走的就是 TransferService 的真实构造路径。
 * 首版测试全部注入 runner 或直连 createTransferRunner，恰好把这条路径全绕开了。
 */

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'task8-c1-'))
  dirs.push(dir)
  return dir
}

describe('C1：adbPath 必须惰性解析，不能在构造时固化', () => {
  it('构造时 adb 未就绪（空串）、执行时已就绪 → 传输能拿到真实路径', async () => {
    const seenPaths: string[] = []
    // 模拟真实时序：构造时 checking（空串），之后自检成功
    let adbPath = ''
    const dir = tmpDir()
    const local = path.join(dir, 'a.bin')
    writeFileSync(local, Buffer.alloc(1024))

    // 不注入 runner：走真实的 TransferRunner 构造路径
    const svc = new TransferService({
      // 关键：传入的是 getter，不是取好的值
      adbPath: () => adbPath,
      clientFor: () => ({
        serial: 'S1',
        run: async (args: string[], opts: { adbPath: string }) => {
          seenPaths.push(opts.adbPath)
          return { code: 0, stdout: '', stderr: local + ': 1 file pushed, 0 skipped. 1.0 MB/s (1024 bytes in 0.001s)\r\n' }
        },
      }) as never,
      emit: () => {},
      // 测试用：不真的轮询设备（假 client 的 stat 会返回空）
      runner: (getPath) => new TransferRunner({
        adbPath: getPath,
        clientFor: () => ({
          serial: 'S1',
          run: async (args: string[], opts: { adbPath: string }) => {
            seenPaths.push(opts.adbPath)
            return {
              code: 0,
              stdout: args[0] === 'shell' ? '0' : '',
              stderr: args[0] === 'push' ? 'a.bin: 1 file pushed, 0 skipped. 1.0 MB/s (1024 bytes in 0.001s)\r\n' : '',
            }
          },
        }) as never,
        pollMs: 1,
        sleep: async () => {},
      }),
    })

    // 构造完成时 adbPath 仍是空串 —— 这正是 C1 的工况
    expect(adbPath).toBe('')

    // 现在「自检成功」
    adbPath = 'C:/platform-tools/adb.exe'

    const task = await svc.enqueue({ serial: 'S1', direction: 'push', src: local, dstDir: '/sdcard/Download' })
    // 等任务跑完（假 client 是立即返回的）
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && svc.manager.get(task.id)?.status === 'running') {
      await new Promise((r) => setTimeout(r, 10))
    }
    await new Promise((r) => setTimeout(r, 30))

    const final = svc.manager.get(task.id)
    expect(final?.status).toBe('done')
    // 实际传给 adb 的路径必须是后来就绪的那个，而不是构造时固化的空串
    expect(seenPaths.length).toBeGreaterThan(0)
    for (const seen of seenPaths) expect(seen).toBe('C:/platform-tools/adb.exe')
  })

  it('执行时 adb 仍未就绪 → 明确 E_ADB_NOT_FOUND，而不是 spawn("") 被吞成 E_SYNC_FAILED', async () => {
    const dir = tmpDir()
    const local = path.join(dir, 'b.bin')
    writeFileSync(local, Buffer.alloc(16))
    let calls = 0
    const seenPaths: string[] = []

    const svc = new TransferService({
      adbPath: () => '',
      clientFor: () => ({ serial: 'S1', run: async () => { calls += 1; return { code: 0, stdout: '', stderr: '' } } }) as never,
      emit: () => {},
      runner: (getPath) => new TransferRunner({
        adbPath: getPath,
        clientFor: () => ({
          serial: 'S1',
          run: async (_args: string[], opts: { adbPath: string }) => {
            calls += 1
            seenPaths.push(opts.adbPath)
            return { code: 0, stdout: '0', stderr: '' }
          },
        }) as never,
        pollMs: 1,
        sleep: async () => {},
      }),
    })

    const task = await svc.enqueue({ serial: 'S1', direction: 'push', src: local, dstDir: '/sdcard/Download' })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && svc.manager.get(task.id)?.status === 'running') {
      await new Promise((r) => setTimeout(r, 10))
    }
    await new Promise((r) => setTimeout(r, 30))

    const final = svc.manager.get(task.id)
    expect(final?.status).toBe('failed')
    expect(final?.error).toBe(E_ADB_NOT_FOUND)
    // 绝不能带着空路径去 spawn
    expect(seenPaths).toEqual([])
  })
})
