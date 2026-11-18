import { spawn, type ChildProcess } from 'node:child_process'
import { killTree, trackChild, untrackChild, adbChildCount, killAllAdbChildren } from './children'

export const E_NO_SERIAL = 'E_NO_SERIAL'
export const E_TIMEOUT = 'E_TIMEOUT'
export const E_ABORTED = 'E_ABORTED'

/** adb 命令的完整执行结果。code 为 null 表示进程被信号终止（例如超时/中断后 kill）。 */
export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface RunOptions {
  /** 超时毫秒数，默认 30000；超时后终结整棵进程树并以 E_TIMEOUT reject。 */
  timeoutMs?: number
  /** 外部取消信号；已 abort 时命令不执行，运行中 abort 会终结整棵进程树。 */
  signal?: AbortSignal
  /** 流式 stdout 回调（每收到一个 chunk 调一次）。 */
  onStdout?: (chunk: string) => void
}

export const DEFAULT_TIMEOUT_MS = 30_000

// 子进程登记表与 killTree 的实现统一在 ./children（probe 也要登记，见 binary.ts）。
// 这里转发导出，保持任务 2 已验收的对外接口不变。
export { adbChildCount, killAllAdbChildren }

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
      // 已取消就先退出，不得 spawn：进程一旦起来，命令就已经在设备上跑了一遍，
      // 事后 kill 只能止损、不能撤销副作用。所有检查必须先于产生副作用的那一步。
      if (opts.signal?.aborted) {
        reject(new Error(E_ABORTED))
        return
      }

      let child: ChildProcess
      try {
        child = spawn(opts.adbPath, this.buildArgs(args), {
          windowsHide: true,
          // POSIX 建独立进程组，超时/取消时能整组终结；Windows 用 taskkill /T 走进程树。
          detached: process.platform !== 'win32',
        })
      } catch (err) {
        reject(err)
        return
      }

      trackChild(child)

      let stdout = ''
      let stderr = ''
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const onAbort = (): void => { killTree(child) }

      // 单一出口：所有 settle 路径（close / error / 超时 / 预取消）必须经过这里，
      // 清理逻辑（定时器、abort 监听器、在手登记）只写在这一处。
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        untrackChild(child)
        fn()
      }

      // setEncoding 走 StringDecoder，多字节字符跨 chunk 时自动拼接，
      // 不会像 buf.toString('utf8') 那样把半个汉字变成 U+FFFD 且无法回补。
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')

      child.stdout?.on('data', (text: string) => {
        stdout += text
        opts.onStdout?.(text)
      })
      child.stderr?.on('data', (text: string) => { stderr += text })

      child.on('error', (err) => finish(() => { reject(err) }))
      child.on('close', (code) => finish(() => { resolve({ code, stdout, stderr }) }))

      // 入口已查过一次 aborted。这里再补一次，覆盖「入口检查通过、spawn 期间被 abort」的窗口；
      // 此时进程已存在，只能 kill 止损。必须先挂监听再查状态：已 abort 的 signal 不会再派发事件，
      // 只挂监听不会误触发，而反过来的顺序会漏掉「检查通过、挂监听之前」那次 abort。
      opts.signal?.addEventListener('abort', onAbort)
      if (opts.signal?.aborted) {
        finish(() => { killTree(child); reject(new Error(E_ABORTED)) })
        return
      }

      timer = setTimeout(() => {
        finish(() => { killTree(child); reject(new Error(E_TIMEOUT)) })
      }, timeoutMs)
    })
  }
}
