import { describe, it, expect } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { AdbClient, E_NO_SERIAL, E_TIMEOUT } from '../electron/adb/client'

const isWin = process.platform === 'win32'

// 用系统自带解释器充当「假 adb」：它必须能容忍命令行前缀 -s <serial>。
// Windows 的 cmd 会忽略 /c 之前的参数，因此行为可预测。
const SHELL = isWin ? 'cmd' : 'bash'

function echoArgs(word: string): string[] {
  return isWin ? ['/c', 'echo', word] : ['-c', `echo ${word}`]
}

function stderrArgs(): string[] {
  return isWin ? ['/c', 'type', 'no-such-file-task2-probe.txt'] : ['-c', 'cat /no-such-file-task2-probe.txt']
}

// 先挂起约 1 秒，再写标记文件。若子进程真被 kill，标记文件永远不会出现。
function hangThenWriteArgs(marker: string): string[] {
  return isWin
    ? ['/c', 'ping', '-n', '2', '127.0.0.1', '>nul', '&', 'echo', `alive>${marker}`]
    : ['-c', `sleep 1; echo alive > ${marker}`]
}

function markerPath(): string {
  return `task2-proc-marker-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('AdbClient', () => {
  it('缺少 serial 直接抛错', () => {
    expect(() => new AdbClient('')).toThrow(E_NO_SERIAL)
  })

  it('命令自动带 -s serial', () => {
    const client = new AdbClient('ABC123')
    expect(client.buildArgs(['shell', 'ls'])).toEqual(['-s', 'ABC123', 'shell', 'ls'])
  })

  it('serial 含空格、中文、单引号、分号也原样透传（serial 走参数数组，不经 shell）', () => {
    const serial = "ABC 123 中文'; rm -rf /; echo '"
    const client = new AdbClient(serial)
    expect(client.serial).toBe(serial)
    expect(client.buildArgs(['shell', 'ls'])).toEqual(['-s', serial, 'shell', 'ls'])
  })

  it('run 返回退出码与 stdout', async () => {
    const client = new AdbClient('ABC123')
    const result = await client.run(echoArgs('hello'), { adbPath: SHELL })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('hello')
  })

  it('run 收集 stderr 与非零退出码', async () => {
    const client = new AdbClient('ABC123')
    const result = await client.run(stderrArgs(), { adbPath: SHELL })
    expect(result.code).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('run 通过 onStdout 流式回调', async () => {
    const chunks: string[] = []
    const client = new AdbClient('ABC123')
    const result = await client.run(echoArgs('streamed'), {
      adbPath: SHELL,
      onStdout: (chunk) => { chunks.push(chunk) },
    })
    expect(result.stdout.trim()).toBe('streamed')
    expect(chunks.join('').trim()).toBe('streamed')
  })

  it('超时后真的 kill 子进程并 reject E_TIMEOUT', async () => {
    const marker = markerPath()
    try {
      const client = new AdbClient('ABC123')
      const startedAt = Date.now()
      await expect(
        client.run(hangThenWriteArgs(marker), { adbPath: SHELL, timeoutMs: 100 }),
      ).rejects.toThrow(E_TIMEOUT)
      // 必须很快 reject，而不是等子进程自己结束
      expect(Date.now() - startedAt).toBeLessThan(900)
      // 等过子进程原本要写标记的时刻，标记仍不存在 => 进程确实被杀了
      await wait(1600)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(marker, { force: true })
    }
  }, 10_000)

  it('abort 信号会 kill 子进程', async () => {
    const marker = markerPath()
    const controller = new AbortController()
    try {
      const client = new AdbClient('ABC123')
      const pending = client.run(hangThenWriteArgs(marker), {
        adbPath: SHELL,
        timeoutMs: 20_000,
        signal: controller.signal,
      })
      setTimeout(() => controller.abort(), 100)
      await expect(pending).resolves.toBeDefined()
      await wait(1600)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(marker, { force: true })
    }
  }, 10_000)
})
