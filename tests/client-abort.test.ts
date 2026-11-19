import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AdbClient, E_ABORTED, adbChildCount, killAllAdbChildren } from '../electron/adb/client'

/*
 * 裁决 2（任务 2 遗留债）：运行中 abort 必须 reject E_ABORTED。
 *
 * 修前的 bug：onAbort 只 killTree，不 settle；子进程随后 close，走的是
 * child.on('close') → resolve({ code: null })。于是「被用户取消的命令」
 * 在调用方看来是**成功返回**，传输调度器会把它当完成、把 doneBytes 写满。
 *
 * 这里同时做系统层验证（wmic 数进程），不看自己的登记表 —— 登记表清空
 * 不代表进程真死，这正是任务 2/6 已经反复踩过的坑。
 */

const isWin = process.platform === 'win32'
const SHELL = isWin ? 'cmd' : 'bash'

const dirs: string[] = []
afterEach(() => {
  killAllAdbChildren()
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function scriptDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'task8-abort-'))
  dirs.push(dir)
  return dir
}

function nodeAdbArgs(scriptPath: string): string[] {
  return isWin
    ? ['/c', process.execPath, scriptPath]
    : ['-c', 'exec "' + process.execPath + '" "' + scriptPath + '"']
}

/*
 * 唯一标记：用它到系统进程表里找「本次测试起的进程」。
 *
 * 【踩过的坑】最初把标记写成脚本文件里的注释，结果 waitUntil 永远等不到 ——
 * 注释只存在于磁盘上的文件内容里，**不会出现在进程的 CommandLine**，
 * 而 wmic / pgrep 看的是 CommandLine。现在标记出现在【脚本文件名】上，
 * 文件名一定在命令行里，所以系统层一定能看到它。
 */
function uniqueTag(): string {
  return 'task8abort' + process.pid + 'x' + Math.floor(Math.random() * 1e9)
}

/** 用标记命名脚本文件（保证标记出现在进程 CommandLine 上）。 */
function taggedScript(dir: string, tag: string, name: string): string {
  const file = path.join(dir, name + '-' + tag + '.mjs')
  writeFileSync(file, 'setInterval(() => {}, 1000)\n')
  return file
}

/** 系统层面数一下命令行里带该标记的 node 进程有多少个（Windows 用 wmic）。 */
function liveProcessesWithTag(tag: string): number {
  if (!isWin) {
    const r = spawnSync('pgrep', ['-af', tag], { encoding: 'utf8' })
    return (r.stdout ?? '').trim() === '' ? 0 : (r.stdout ?? '').trim().split('\n').length
  }
  const r = spawnSync('wmic', ['process', 'where', "name='node.exe'", 'get', 'CommandLine'], {
    windowsHide: true, encoding: 'utf8',
  })
  return (r.stdout ?? '')
    .split('\n')
    .filter((line) => line.includes(tag))
    .length
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await wait(50)
  }
  return predicate()
}

describe('裁决 2：运行中 abort 的语义', () => {
  it('abort 后 reject E_ABORTED（绝不能被当成成功返回）', async () => {
    const dir = scriptDir()
    const tag = uniqueTag()
    const script = taggedScript(dir, tag, 'long')

    const controller = new AbortController()
    const client = new AdbClient('ABC123')
    const pending = client.run(nodeAdbArgs(script), {
      adbPath: SHELL,
      signal: controller.signal,
      timeoutMs: 60_000,
    })

    // 等进程真的起来再取消，否则测的是 pre-abort 路径
    expect(await waitUntil(() => liveProcessesWithTag(tag) > 0, 8000)).toBe(true)
    controller.abort()

    await expect(pending).rejects.toThrow(E_ABORTED)
  }, 30_000)

  it('abort 被当成 E_ABORTED 而不是 code 0/1：错误消息里精确是本码', async () => {
    const dir = scriptDir()
    const tag = uniqueTag()
    const script = taggedScript(dir, tag, 'long2')

    const controller = new AbortController()
    const client = new AdbClient('ABC123')
    const pending = client.run(nodeAdbArgs(script), {
      adbPath: SHELL, signal: controller.signal, timeoutMs: 60_000,
    })
    expect(await waitUntil(() => liveProcessesWithTag(tag) > 0, 8000)).toBe(true)
    controller.abort()

    let caught: unknown
    try { await pending } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(E_ABORTED)
  }, 30_000)

  it('取消后 500ms 系统层进程计数为 0（裁决 3：真杀进程树，不看登记表）', async () => {
    const dir = scriptDir()
    const tag = uniqueTag()
    const script = taggedScript(dir, tag, 'tree')

    const controller = new AbortController()
    const client = new AdbClient('ABC123')
    const pending = client.run(nodeAdbArgs(script), {
      adbPath: SHELL, signal: controller.signal, timeoutMs: 60_000,
    })
    expect(await waitUntil(() => liveProcessesWithTag(tag) > 0, 8000)).toBe(true)
    controller.abort()
    await expect(pending).rejects.toThrow(E_ABORTED)

    /*
     * 【审查 I】更强断言：reject 返回的那一刻就查进程表，不 sleep。
     *
     * 修前 killTree 是 fire-and-forget，所以「取消后 500ms 归零」是概率性的 ——
     * 机器一忙，taskkill 还在排队。现在 killTree 返回 Promise 且 abort 路径
     * 等它完成才 reject，于是「reject 已返回 ⇒ 进程树已死」应当是**确定性**的。
     *
     * 保留 500ms 那条作为兜底（防止将来又退回 fire-and-forget 时这里偶然变绿）。
     */
    expect(liveProcessesWithTag(tag)).toBe(0)
    expect(adbChildCount()).toBe(0)

    await wait(500)
    expect(liveProcessesWithTag(tag)).toBe(0)
  }, 30_000)

  it('abort 之后不会因为 close 迟到而 resolve（settle 只发生一次）', async () => {
    const dir = scriptDir()
    const tag = uniqueTag()
    const script = taggedScript(dir, tag, 'late')

    const controller = new AbortController()
    const client = new AdbClient('ABC123')
    const pending = client.run(nodeAdbArgs(script), {
      adbPath: SHELL, signal: controller.signal, timeoutMs: 60_000,
    })
    expect(await waitUntil(() => liveProcessesWithTag(tag) > 0, 8000)).toBe(true)
    controller.abort()

    let resolvedValue: unknown = 'NEVER'
    let rejected = false
    try {
      resolvedValue = await pending
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
    expect(resolvedValue).toBe('NEVER')
  }, 30_000)

  it('正常结束（未 abort）仍然 resolve 结果，语义没有被弄坏', async () => {
    const client = new AdbClient('ABC123')
    const args = isWin ? ['/c', 'echo', 'done'] : ['-c', 'echo done']
    const result = await client.run(args, { adbPath: SHELL, timeoutMs: 10_000 })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('done')
  }, 20_000)
})
