import { spawn } from 'node:child_process'

export const E_NO_SERIAL = 'E_NO_SERIAL'
export const E_TIMEOUT = 'E_TIMEOUT'

/** adb 命令的完整执行结果。code 为 null 表示进程被信号终止（例如超时/中断后 kill）。 */
export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface RunOptions {
  /** 超时毫秒数，默认 30000；超时后真的 kill 子进程并以 E_TIMEOUT reject。 */
  timeoutMs?: number
  /** 外部取消信号；触发后 kill 子进程。 */
  signal?: AbortSignal
  /** 流式 stdout 回调（每收到一个 chunk 调一次）。 */
  onStdout?: (chunk: string) => void
}

export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 单设备 adb 命令封装。
 * 红线：所有动态值（路径、文件名）都只作为 argv 数组元素传给 spawn，
 * 绝不拼进 shell 字符串；需要 shell 解释的值必须先经 shellQuote()。
 */
export class AdbClient {
  readonly serial: string

  constructor(serial: string) {
    if (!serial) throw new Error(E_NO_SERIAL)
    this.serial = serial
  }

  /** 每条命令都强制带 -s serial，杜绝多设备下命令打到错误设备。 */
  buildArgs(args: string[]): string[] {
    return ['-s', this.serial, ...args]
  }

  run(args: string[], opts: RunOptions & { adbPath: string }): Promise<RunResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return new Promise<RunResult>((resolve, reject) => {
      let child
      try {
        child = spawn(opts.adbPath, this.buildArgs(args), { windowsHide: true })
      } catch (err) {
        reject(err)
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }

      const timer = setTimeout(() => {
        if (settled) return
        child.kill()
        reject(new Error(E_TIMEOUT))
      }, timeoutMs)

      child.stdout?.on('data', (buf: Buffer) => {
        const text = buf.toString('utf8')
        stdout += text
        opts.onStdout?.(text)
      })
      child.stderr?.on('data', (buf: Buffer) => { stderr += buf.toString('utf8') })

      opts.signal?.addEventListener(
        'abort',
        () => { child.kill() },
        { once: true },
      )

      child.on('error', (err) => finish(() => { reject(err) }))
      child.on('close', (code) => finish(() => { resolve({ code, stdout, stderr }) }))
    })
  }
}
