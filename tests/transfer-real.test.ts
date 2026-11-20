import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TransferRunner } from '../electron/transfer/runner'
import { createTransferRunner } from '../electron/transfer/runner'
import { AdbClient } from '../electron/adb/client'
import { TransferService } from '../electron/transfer/service'
import { E_PROTECTED_PATH } from '../src/shared/errors'
import { isInsideRoot } from '../src/shared/path-guard'
import { acquireDeviceLock, deviceSkipMessage, resolveSerial } from './device-lock'
import { makeOutsideHomeDir, realHome } from './outside-home'

/*
 * 裁决 9：真机集成用例（1 条 push + 1 条 pull，文件名含中文与空格）。
 *
 * 跳过必须说话：模块顶层打印原因（不能放 beforeAll —— 全员 skip 时 beforeAll 不执行）。
 * 设备号绝不硬编码：先是 ADB_TEST_SERIAL，否则从 adb devices 自动取第一台在线设备。
 */

const ADB = process.env.ADB_PATH ?? 'adb'

/*
 * 设备锁（N17）：batch/drag/ops/transfer 四个真机文件共用同一把
 * `adbfm-device-<serial>.lock` —— 默认并行的 `npx vitest run` 里它们互斥，
 * 不再互相删对方的临时文件。
 *
 * 必须在**模块顶层**抢：放 beforeAll 就晚了（那时临时目录、service 都已建好）。
 */
const SERIAL = resolveSerial()
const lockRelease = SERIAL === null ? null : acquireDeviceLock(SERIAL, 'transfer-real')
const skip = SERIAL === null || lockRelease === null
if (skip) {
  // 三种原因（无设备 / serial 不在线 / 撞锁）必须能区分，且在模块顶层打印
  // （放 beforeAll 就晚了：全员 skip 时 beforeAll 根本不执行）
  console.log(deviceSkipMessage('transfer-real', SERIAL, lockRelease))
}

/** 设备侧临时目录（用例结束清理）。 */
const REMOTE_DIR = '/sdcard/Download/adb-fm-itest'

/*
 * R2-1 的「根外」样本目录（主目录之外，见 tests/outside-home.ts 的理由）。
 *
 * 这里只**探测**一次可用性就立刻删掉，目录本身在用例内部现造现清：
 * 本文件整组可能被 skip（没有设备 / 撞锁），若在模块顶层造目录就会留下垃圾。
 */
const OUTSIDE_HOME_AVAILABLE = (() => {
  const probe = makeOutsideHomeDir()
  if (probe === null) return false
  try { rmSync(probe, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ }
  return true
})()
if (!OUTSIDE_HOME_AVAILABLE) {
  console.log('[transfer-real] 跳过 R2-1 根外用例：本机找不到主目录之外的可写目录')
}

describe.skipIf(skip)('真机传输（裁决 9）', () => {
  let dir = ''
  let adb = ''
  let runner: TransferRunner

  function shell(command: string): string {
    return execFileSync(ADB, ['-s', SERIAL as string, 'shell', command], {
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
    })
  }

  beforeAll(() => {
    // 本地测试目录：走 mkdtemp 而不是项目里，避免污染仓库
    dir = mkdtempSync(path.join(tmpdir(), 'adb-fm-itest-'))
    adb = ADB
    runner = createTransferRunner({ adbPath: adb })
    try { shell('rm -rf ' + REMOTE_DIR) } catch { /* 目录不存在是常态 */ }
    shell('mkdir -p ' + REMOTE_DIR)
  }, 60_000)

  afterAll(() => {
    try { shell('rm -rf ' + REMOTE_DIR) } catch { /* 忽略清理失败 */ }
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
    // 释放设备锁（最后一个动作：确保设备侧清理已经跑完）
    lockRelease?.()
  })

  it('push：文件名含中文与空格，进度单调递增，完成后大小与内容一致', async () => {
    const name = '中文 文件名 测试.bin'
    const localPath = path.join(dir, name)
    // 8MB 可压缩内容，足够跑出多次轮询；不必 50MB 以免拖慢常规测试
    const payload = Buffer.alloc(8 * 1024 * 1024)
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251
    writeFileSync(localPath, payload)

    const remotePath = REMOTE_DIR + '/' + name
    const task = runner.createPush('itest-push', SERIAL as string, localPath, remotePath, payload.length)
    const progressSamples: Array<{ doneBytes: number; totalBytes: number | null }> = []
    const controller = new AbortController()
    const result = await runner.run(task, {
      signal: controller.signal,
      onProgress: (doneBytes, totalBytes) => { progressSamples.push({ doneBytes, totalBytes }) },
    })

    expect(result.ok).toBe(true)
    // 反向校验设备侧大小与内容（push 成功不代表内容对）
    const remoteSize = Number(shell('stat -c %s ' + JSON.stringify(remotePath)).trim())
    expect(remoteSize).toBe(payload.length)
    // 设备上取回校验和
    const remoteSum = shell('md5sum ' + JSON.stringify(remotePath)).trim().split(/\s+/)[0]
    const localSum = execFileSync('md5sum', [localPath], { encoding: 'utf8', windowsHide: true })
      .trim().split(/\s+/)[0]
    expect(remoteSum).toBe(localSum)
    // 进度必须单调递增（允许相等）
    for (let i = 1; i < progressSamples.length; i++) {
      expect(progressSamples[i].doneBytes).toBeGreaterThanOrEqual(progressSamples[i - 1].doneBytes)
    }
  }, 180_000)

  it('pull：文件名含中文与空格，拉回后大小与内容一致', async () => {
    const name = '下载 中文 文件.bin'
    const remotePath = REMOTE_DIR + '/' + name
    const source = Buffer.alloc(6 * 1024 * 1024)
    for (let i = 0; i < source.length; i++) source[i] = (i * 7) % 251
    const sourceLocal = path.join(dir, 'source-' + name)
    writeFileSync(sourceLocal, source)
    // 先用 adb 放上去（直接用 adb，不依赖被测代码）
    execFileSync(ADB, ['-s', SERIAL as string, 'push', sourceLocal, remotePath], {
      windowsHide: true, timeout: 120_000, stdio: 'ignore',
    })

    const localOut = path.join(dir, 'pulled-' + name)
    const task = runner.createPull('itest-pull', SERIAL as string, remotePath, localOut, source.length)
    const progressSamples: number[] = []
    const controller = new AbortController()
    const result = await runner.run(task, {
      signal: controller.signal,
      onProgress: (doneBytes) => { progressSamples.push(doneBytes) },
    })

    expect(result.ok).toBe(true)
    expect(existsSync(localOut)).toBe(true)
    expect(statSync(localOut).size).toBe(source.length)
    expect(readFileSync(localOut).equals(source)).toBe(true)
    for (let i = 1; i < progressSamples.length; i++) {
      expect(progressSamples[i]).toBeGreaterThanOrEqual(progressSamples[i - 1])
    }
  }, 180_000)

  /*
   * 审查 I2：取消一个「覆盖已有文件」的传输，**旧文件必须原样还在**。
   *
   * 这是复审实测抓到的数据丢失级缺陷：adb 会先截断目标再写，
   * 所以修前取消 = 既没传完、又把原有文件毁了。
   * 现在走临时名 + 原子改名，目标在成功前完全不被碰。
   */
  it('I2：覆盖传输中途取消后，设备上的旧文件内容与大小完全不变，且无 .adbfm-part 残留', async () => {
    const name = '覆盖 旧文件 测试.bin'
    const remotePath = REMOTE_DIR + '/' + name

    // 1) 在设备上造一个「宝贵旧文件」
    const oldLocal = path.join(dir, 'old-' + name)
    writeFileSync(oldLocal, 'PRECIOUS-OLD-' + 'A'.repeat(4096))
    execFileSync(ADB, ['-s', SERIAL as string, 'push', oldLocal, remotePath], {
      windowsHide: true, timeout: 120_000, stdio: 'ignore',
    })
    const beforeMd5 = shell('md5sum ' + JSON.stringify(remotePath)).trim().split(/\s+/)[0]
    const beforeSize = Number(shell('stat -c %s ' + JSON.stringify(remotePath)).trim())
    expect(beforeSize).toBeGreaterThan(0)

    // 2) 传一个不可压缩的大文件到同一目标，中途取消
    const bigLocal = path.join(dir, 'big-overwrite.bin')
    // 400MB：按实测 ~186MB/s，写盘阶段约 2s，400ms 的取消点确定落在写入途中
    const big = Buffer.alloc(400 * 1024 * 1024)
    // 伪随机，避免被 adb 压缩掉而瞬间传完
    let seed = 12345
    for (let i = 0; i < big.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      big[i] = seed & 0xff
    }
    writeFileSync(bigLocal, big)

    const controller = new AbortController()
    const task = runner.createPush('itest-overwrite', SERIAL as string, bigLocal, remotePath, big.length)
    /*
     * 【任务 9 复审 I3】取消必须发生在**传输中途**，而且这件事要被用例自己证实。
     *
     * 复审打回的事实：上一版用 250ms 定时取消，但把 discardPart 插桩后读到
     * 取消瞬间的 .adbfm-part 已经是 125829120 字节 —— **正好是完整的 120MB**。
     * 也就是说那次「中途取消」实际发生在「数据已全部落盘、只差改名」的窗口里，
     * 用例名不副实；而且原来的 onProgress 兜底会在「已经传完」时也 abort，
     * 把「传完了」伪装成「取消成功」。
     *
     * 这一版做三件事：
     *   1. 文件放大到 400MB —— 按实测 ~186MB/s，写盘阶段约 2s，
     *      400ms 时最多写进 ~75MB，取消点确定落在**数据仍在写入**的区间；
     *   2. 取消**之前**同步采一次临时文件的真实大小，并断言它 < 源文件大小 ——
     *      前提不成立就直接红，而不是继续跑一个名不副实的用例；
     *   3. 删掉 onProgress 兜底 abort：它会让「传完了」被当成「取消成功」。
     */
    const partRemote = remotePath + '.adbfm-part'
    let partSizeAtCancel: number | null = null
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return
      // 采样必须在 abort 之前：abort 会触发 discardPart 删掉临时文件
      try {
        const out = shell('stat -c %s ' + JSON.stringify(partRemote)).trim()
        partSizeAtCancel = /^\d+$/.test(out) ? Number(out) : null
      } catch {
        partSizeAtCancel = null
      }
      controller.abort()
    }, 400)
    // 这里是**故意**不接进度回调的：上一版用 onProgress 兜底 abort，
    // 会让「其实已经传完」也被当成「取消成功」（复审 I3 的第二个缺陷）。
    const running = runner.run(task, { signal: controller.signal, onProgress: () => {} })
    let result
    try {
      result = await running
    } finally {
      clearTimeout(timer)
    }
    expect(result.ok).toBe(false)

    /*
     * 【复审 I3 的核心】先把「这次取消真的发生在中途」证实，再验证数据安全。
     *
     * 上一版丢掉的正是这一条：取消点在 250ms，而临时文件已经是完整 120MB，
     * 用例照样全绿 —— 它测的是「传完之后取消」，不是「传输中途取消」。
     * 前提不成立时必须**直接红**，否则这个用例会一直给出虚假的安心。
     */
    const sizeAtCancel: number | null = partSizeAtCancel
    expect(sizeAtCancel, '取消瞬间没能读到临时文件大小，前提无法证实').not.toBeNull()
    expect(
      sizeAtCancel ?? 0,
      '取消瞬间临时文件已是完整大小：本次取消落在「数据已写完、只差改名」的窗口，不是传输中途',
    ).toBeLessThan(big.length)
    // 也不该是 0：那说明取消发生在 adb 还没开始写的时候，同样不算「中途」
    expect(sizeAtCancel ?? 0).toBeGreaterThan(0)

    // 3) 给清理一点时间（rm 是另一条 adb 命令）
    await new Promise((r) => setTimeout(r, 1500))

    // 核心断言：旧文件逐字节未变
    const afterMd5 = shell('md5sum ' + JSON.stringify(remotePath)).trim().split(/\s+/)[0]
    const afterSize = Number(shell('stat -c %s ' + JSON.stringify(remotePath)).trim())
    expect(afterSize).toBe(beforeSize)
    expect(afterMd5).toBe(beforeMd5)

    // 不得残留临时文件
    const listing = shell('ls -1 ' + JSON.stringify(REMOTE_DIR)).trim()
    expect(listing).not.toContain('.adbfm-part')
  }, 240_000)

  /*
   * 【第 2 轮复审 N2 / N3】传输通道的目标目录判定，真机验证两个方向：
   *
   *   - N2：/sdcard 是首屏默认目录（DEFAULT_CWD），往里上传必须**成功**。
   *     修前它被当成「受保护对象」一并拒绝，于是用户在默认目录里上传任何文件
   *     都得到 E_PROTECTED_PATH，文案还说「禁止删除或移动」—— 功能等于废掉。
   *   - N3：往设备根 / 上传必须**失败**。修前它给 / 开了特例，
   *     结果「往根写文件」放行、「往用户存储根写文件」被拒，判定自相矛盾。
   */
  it('N2：往 /sdcard（首屏默认目录）上传 → 成功落盘且内容一致', async () => {
    const svc = new TransferService({
      adbPath: () => ADB,
      clientFor: (serial) => new AdbClient(serial),
      emit: () => {},
    })
    const name = '上传到存储根 测试.txt'
    const localFile = path.join(dir, name)
    writeFileSync(localFile, 'N2-OK')
    const remote = '/sdcard/' + name
    try { shell('rm -f -- ' + JSON.stringify(remote)) } catch { /* 不存在是常态 */ }

    const task = await svc.controller.enqueue({ serial: SERIAL as string, direction: 'push', src: localFile, dstDir: '/sdcard' })
    expect(task.dst).toBe(remote)

    // 等到终态：真机 push 几毫秒就完成，但这里按状态轮询而不是盲目 sleep
    const deadline = Date.now() + 60_000
    let final = svc.controller.get(task.id)
    while (final !== undefined && final.status !== 'done' && final.status !== 'failed' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
      final = svc.controller.get(task.id)
    }
    expect(final?.status).toBe('done')
    // 设备侧复核：内容真的到了，而不是只报成功
    expect(shell('cat ' + JSON.stringify(remote)).trim()).toBe('N2-OK')

    shell('rm -f -- ' + JSON.stringify(remote))
    expect(shell('test -e ' + JSON.stringify(remote) + ' && echo yes || echo no').trim()).toBe('no')
    svc.dispose()
  }, 120_000)

  it('N3：往设备根 / 上传 → E_PROTECTED_PATH（不再给 / 开特例）', async () => {
    const svc = new TransferService({
      adbPath: () => ADB,
      clientFor: (serial) => new AdbClient(serial),
      emit: () => {},
    })
    const localFile = path.join(dir, 'root-upload.txt')
    writeFileSync(localFile, 'N3-MUST-NOT-LAND')
    await expect(
      svc.controller.enqueue({ serial: SERIAL as string, direction: 'push', src: localFile, dstDir: '/' }),
    ).rejects.toThrow(E_PROTECTED_PATH)
    // 设备根上不得出现同名文件
    expect(shell('test -e /root-upload.txt && echo yes || echo no').trim()).toBe('no')
    svc.dispose()
  }, 120_000)

  /*
   * 【R2-1】真机验证「本地根目录沙箱已移除」这件事本身：
   *
   * 用户的真实工况就是从资源管理器把**任意位置**的文件拖进设备
   * （文件在 D:\资料、U 盘、下载目录……不一定在主目录下）。
   * 修前这些位置一律 E_OUTSIDE_ROOT，拖入直接失败。
   *
   * 这条用例真的跑一次 push（本地源在主目录之外）+ 一次 pull
   * （本地目标在主目录之外），并在设备侧/本地侧各自核对内容。
   * 目录在主目录之外这件事由用例自己断言 —— 前提不成立就直接红，
   * 而不是悄悄变成一条「在主目录里传文件」的空转用例。
   */
  it.skipIf(!OUTSIDE_HOME_AVAILABLE)('R2-1：本地源与目标都在主目录之外 → push/pull 各成功一次', async () => {
    const created = makeOutsideHomeDir()
    expect(created, '本机找不到主目录之外的可写目录').not.toBeNull()
    const outside = realpathSync.native(created as string)
    const name = 'R2-1 根外 上传 测试.txt'
    // 目标名来自本地文件名（fileNameOf），所以设备侧路径就是 REMOTE_DIR + name
    const remote = REMOTE_DIR + '/' + name
    const svc = new TransferService({
      adbPath: () => ADB,
      clientFor: (serial) => new AdbClient(serial),
      emit: () => {},
    })

    const waitTerminal = async (id: string) => {
      const deadline = Date.now() + 60_000
      let task = svc.controller.get(id)
      while (task !== undefined && task.status !== 'done' && task.status !== 'failed' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        task = svc.controller.get(id)
      }
      return task
    }

    try {
      // 前提：这个目录真的在主目录之外（否则整条用例测的不是 R2-1）
      expect(isInsideRoot(realHome(), outside)).toBe(false)

      // 1) push：本地源在主目录之外
      const localFile = path.join(outside, name)
      writeFileSync(localFile, 'R2-1-OUTSIDE-HOME')
      const push = await svc.controller.enqueue({ serial: SERIAL as string, direction: 'push', src: localFile, dstDir: REMOTE_DIR })
      expect(push.dst).toBe(remote)
      const pushed = await waitTerminal(push.id)
      expect(pushed?.status).toBe('done')
      // 设备侧复核内容（push 报成功不等于内容对）
      expect(shell('cat ' + JSON.stringify(remote)).trim()).toBe('R2-1-OUTSIDE-HOME')

      // 2) pull：本地目标在主目录之外
      const pull = await svc.controller.enqueue({ serial: SERIAL as string, direction: 'pull', src: remote, dstDir: outside })
      expect(pull.dst).toBe(path.join(outside, name))
      const pulled = await waitTerminal(pull.id)
      expect(pulled?.status).toBe('done')
      expect(readFileSync(path.join(outside, name), 'utf8')).toBe('R2-1-OUTSIDE-HOME')
    } finally {
      try { shell('rm -f -- ' + JSON.stringify(remote)) } catch { /* 不存在是常态 */ }
      try { rmSync(outside, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ }
      svc.dispose()
    }
  }, 180_000)
})
