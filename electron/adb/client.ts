import { type ChildProcess } from 'node:child_process'
import { killTree, spawnTracked, untrackChild, adbChildCount, killAllAdbChildren } from './children'

export const E_NO_SERIAL = 'E_NO_SERIAL'
export const E_TIMEOUT = 'E_TIMEOUT'
export const E_ABORTED = 'E_ABORTED'
/** 应用正在退出，子进程闸门已关闭：命令没有执行。 */
export const E_SHUTDOWN = 'E_SHUTDOWN'

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

      let child: ChildProcess | null
      try {
        // 统一出入口（I5）：闸门已关闭时 spawnTracked 返回 null 且【不 spawn】，
        // 因此「退出过程中迟到的命令」不会留下孤儿进程。
        child = spawnTracked(opts.adbPath, this.buildArgs(args), {
          windowsHide: true,
          // POSIX 建独立进程组，超时/取消时能整组终结；Windows 用 taskkill /T 走进程树。
          detached: process.platform !== 'win32',
        })
      } catch (err) {
        reject(err)
        return
      }
      if (child === null) {
        // 进程闸门已关闭：明确失败，绝不让调用方误以为命令执行了
        reject(new Error(E_SHUTDOWN))
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      /**
       * 【审查 I1（第 2 轮）】超时定时器。
       *
       * 修前这里有两个变量共用一个名字的问题（一次改动留下了两段 setTimeout 赋值），
       * 后一段把前一段覆盖掉 → 前一个定时器永远不会被 clearTimeout、也从未 unref，
       * 于是**每条 adb 命令泄漏一个定时器**（复审实测 HANDLES 单调增长）。
       * 现在只有一个变量、一个赋值点，且统一在 finish 单一出口清掉。
       *
       * 关于 unref：这个定时器的语义就是「等超时」，它**必须**让事件循环保持存活，
       * 否则一条长时间运行的 adb 命令会在定时器到期前被进程退出打断。
       * 真正的退出安全由 before-quit 的 shutdownChildren 负责（那里会 kill 全部子进程，
       * child 的 close 会立刻走 finish 把定时器清掉），所以这里刻意不 unref。
       */
      let timer: ReturnType<typeof setTimeout> | undefined

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

      /**
       * 【审查 I】先标记 settled（挡住迟到的 close/error），再杀进程树，
       * **等 taskkill 真正退出之后**才 reject。
       *
       * 为什么要等到杀完：killTree 在 Windows 上是 taskkill /T /F，异步的。
       * 修前是 fire-and-forget，于是「取消 Promise 返回时进程已死」只是概率性成立 ——
       * 审查实测：机器一忙，调用方数进程时 taskkill 还在排队。
       * 现在 reject 与「进程树确实死透」是同一个时刻，调用方可以**立刻**查进程表。
       *
       * 为什么仍要先把 settled 置位：如果等杀完再置位，子进程的 close 事件可能先到，
       * 走进 resolve({code}) 分支 —— 那正是本任务修掉的「取消被当成成功」的老 bug。
       * 所以顺序必须是：先封口（settled），再杀，最后 reject。
       */
      const abortOrTimeout = (code: string): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        untrackChild(child)
        const killed = killTree(child)
        const fail = (): void => { reject(new Error(code)) }
        killed.then(fail, fail)
      }

      /**
       * 【裁决 2 / 任务 2 遗留债】取消必须 reject E_ABORTED。
       *
       * 修前的 bug：onAbort 只 killTree 不 settle。子进程被杀后照常触发 close，
       * 走的是 child.on('close') → resolve({ code: null }) ——
       * 「被用户取消的命令」在调用方看来是**成功返回**。
       * 传输调度器据此把任务判成完成、把 doneBytes 写满，进度条直接跳到 100%。
       */
      const onAbort = (): void => { abortOrTimeout(E_ABORTED) }

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
        abortOrTimeout(E_ABORTED)
        return
      }

      // 唯一的定时器赋值点。超时统一走 abortOrTimeout（先封口、再杀进程树、等杀完才 reject）。
      timer = setTimeout(() => { abortOrTimeout(E_TIMEOUT) }, timeoutMs)
    })
  }
}