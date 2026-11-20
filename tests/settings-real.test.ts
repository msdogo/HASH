import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AdbClient } from '../electron/adb/client'
import { TransferService } from '../electron/transfer/service'
import { createSettingsStore } from '../electron/settings/store'
import { downloadDirForDownload } from '../src/shared/settings'
import { shellQuote } from '../electron/adb/shellsafe'
import { acquireDeviceLock, deviceSkipMessage, resolveSerial } from './device-lock'

/*
 * R2-2 的真机验收：**普通下载真的落到「设置里的默认下载路径」**。
 *
 * 这是本轮唯一无法用假依赖证明的事：此前 FilesPage 的 localDir 取的是本地面板的
 * cwd，所以「设置一个路径 → 下载 → 文件出现在那里」这条用户路径从来没有被跑通过。
 * 本用例走的是与生产完全相同的链路：
 *   1. createSettingsStore 用**临时目录**做持久化，写一个自定义下载路径；
 *   2. downloadDirForDownload 拿到的就是那个路径（与 FilesPage 的注入同一行）；
 *   3. TransferService.enqueue 以它为 dstDir 真拉一次；
 *   4. 断言文件**在设置的目录里**、内容逐字节一致，且**不在**本地面板目录里。
 *
 * 跳过必须说话：模块顶层打印原因（不能放 beforeAll —— 全员 skip 时 beforeAll 不执行）。
 * 设备号绝不硬编码：先 ADB_TEST_SERIAL，否则从 adb devices 自动取第一台在线设备。
 */

const ADB = process.env.ADB_PATH ?? 'adb'

/*
 * 设备锁（N17）：与 batch/drag/ops/transfer 四个真机文件共用同一把
 * `adbfm-device-<serial>.lock` —— 默认并行的 `npx vitest run` 里它们互斥。
 * 必须在模块顶层抢：放 beforeAll 就晚了。
 */
const SERIAL = resolveSerial()
const lockRelease = SERIAL === null ? null : acquireDeviceLock(SERIAL, 'settings-real')
const skip = SERIAL === null || lockRelease === null
if (skip) {
  console.log(deviceSkipMessage('settings-real', SERIAL, lockRelease))
}

/** 设备侧临时目录（用例结束清理）。 */
const REMOTE_DIR = '/sdcard/Download/adb-fm-settings-itest'

describe.skipIf(skip)('真机：普通下载落到设置里的默认下载路径（R2-2）', () => {
  let storeDir = ''
  let settingsDir = ''
  let decoyDir = ''
  let transfer: TransferService

  /** 设备侧执行一条命令。 */
  function shell(command: string): string {
    return execFileSync(ADB, ['-s', SERIAL as string, 'shell', command], {
      encoding: 'utf8', windowsHide: true, timeout: 120_000,
    })
  }

  beforeAll(() => {
    /*
     * 三个真实目录，语义各不相同：
     *   storeDir        —— electron-store 的落盘目录（模拟 userData）
     *   settingsDir     —— 用户「在设置里选的」下载路径（本用例的核心断言对象）
     *   decoyDir        —— 一个**不该**收到文件的干扰目录（R4 之前这里是「本地面板目录」，
     *                      本地面板删除后改名，但反向断言仍有意义：文件不许落到别处）
     */
    storeDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'adbfm-settings-real-')))
    settingsDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'adbfm-settings-dl-')))
    decoyDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'adbfm-settings-decoy-')))

    transfer = new TransferService({
      adbPath: () => ADB,
      clientFor: (serial) => new AdbClient(serial),
      emit: () => undefined,
    })

    try { shell('rm -rf ' + REMOTE_DIR) } catch { /* 目录不存在是常态 */ }
    shell('mkdir -p ' + REMOTE_DIR)
  }, 180_000)

  afterAll(() => {
    try { shell('rm -rf ' + REMOTE_DIR) } catch { /* 忽略清理失败 */ }
    for (const dir of [storeDir, settingsDir, decoyDir]) {
      if (dir !== '') rmSync(dir, { recursive: true, force: true })
    }
    // 释放设备锁（最后一个动作：确保设备侧清理已经跑完）
    lockRelease?.()
  })

  it('改设置里的下载路径 → 普通下载一次 → 文件真的落在新路径（内容一致）', async () => {
    // 1) 设备上造一个可校验的文件（中文名 + 空格，真机常见形态）
    const name = '设置 校验 下载.bin'
    const remotePath = REMOTE_DIR + '/' + name
    const payload = Buffer.alloc(96 * 1024)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 13) % 251
    const seedPath = path.join(storeDir, 'seed.bin')
    writeFileSync(seedPath, payload)
    execFileSync(ADB, ['-s', SERIAL as string, 'push', seedPath, remotePath], {
      encoding: 'utf8', windowsHide: true, timeout: 120_000,
    })

    // 2) 设置里写入「自定义下载路径」（真实 fs + 真实 electron-store 文件）
    const store = createSettingsStore({
      filePath: storeDir,
      // 默认值指向这个干扰目录：如果实现里偷偷回退到「别的目录」，这条会红
      defaultDownloadDir: decoyDir,
      warn: () => undefined,
    })
    store.setDownloadDir(settingsDir)
    // 重建一次，证明拿到的确实是**持久化后**的值，而不是内存里的顺带结果
    const reloaded = createSettingsStore({
      filePath: storeDir,
      defaultDownloadDir: decoyDir,
      warn: () => undefined,
    })
    expect(reloaded.getDownloadDir()).toBe(settingsDir)

    // 3) 与 FilesPage 完全相同的一行注入（R4：签名只剩 settings 一个参数）
    const target = downloadDirForDownload({
      downloadDir: reloaded.getDownloadDir(),
      defaultDownloadDir: reloaded.getDefaultDownloadDir(),
      adb: { state: 'checking' },
    })
    expect(target).toBe(settingsDir)

    // 4) 真下载（普通下载走的就是这条：transfer.enqueue direction=pull）
    const task = await transfer.controller.enqueue({
      serial: SERIAL as string,
      direction: 'pull',
      src: remotePath,
      dstDir: target as string,
    })

    // 等任务进终态（队列是异步跑的）
    const deadline = Date.now() + 60_000
    let settled = transfer.controller.get(task.id)
    while (settled !== undefined && settled.status !== 'done' && settled.status !== 'failed' && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 50) })
      settled = transfer.controller.get(task.id)
    }
    expect(settled?.status).toBe('done')

    // 5) 文件必须落在**设置里的路径**
    const landed = path.join(settingsDir, name)
    expect(existsSync(landed)).toBe(true)
    expect(readFileSync(landed).equals(payload)).toBe(true)

    // 6) 且**没有**落到那个干扰目录里（R4 之前这里断言的是「本地面板目录」）
    expect(existsSync(path.join(decoyDir, name))).toBe(false)

    // 7) 与设备侧 sha256 对拍（内容一致，不只是大小一致）
    const remoteHash = shell('sha256sum ' + shellQuote(remotePath)).trim().split(/\s+/)[0]
    const localHash = createHash('sha256').update(readFileSync(landed)).digest('hex')
    expect(localHash).toBe(remoteHash)
  }, 180_000)

  it('恢复默认后，新下载落到默认目录（切换是即时的，不需要重启）', async () => {
    const name = '恢复默认 下载.bin'
    const remotePath = REMOTE_DIR + '/' + name
    const payload = Buffer.from('R2-2 default dir check')
    const seedPath = path.join(storeDir, 'seed2.bin')
    writeFileSync(seedPath, payload)
    execFileSync(ADB, ['-s', SERIAL as string, 'push', seedPath, remotePath], {
      encoding: 'utf8', windowsHide: true, timeout: 120_000,
    })

    // 默认目录另放一个真实存在的目录（这里用 storeDir 之外的一个新目录）
    const defaultDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'adbfm-settings-default-')))
    try {
      const store = createSettingsStore({
        filePath: storeDir,
        defaultDownloadDir: defaultDir,
        warn: () => undefined,
      })
      store.setDownloadDir(settingsDir)
      expect(store.getDownloadDir()).toBe(settingsDir)
      store.resetDownloadDir()
      expect(store.getDownloadDir()).toBe(defaultDir)

      const target = downloadDirForDownload({
        downloadDir: store.getDownloadDir(),
        defaultDownloadDir: store.getDefaultDownloadDir(),
        adb: { state: 'checking' },
      })
      expect(target).toBe(defaultDir)

      const task = await transfer.controller.enqueue({
        serial: SERIAL as string,
        direction: 'pull',
        src: remotePath,
        dstDir: target as string,
      })
      const deadline = Date.now() + 60_000
      let settled = transfer.controller.get(task.id)
      while (settled !== undefined && settled.status !== 'done' && settled.status !== 'failed' && Date.now() < deadline) {
        await new Promise((resolve) => { setTimeout(resolve, 50) })
        settled = transfer.controller.get(task.id)
      }
      expect(settled?.status).toBe('done')
      expect(existsSync(path.join(defaultDir, name))).toBe(true)
    } finally {
      rmSync(defaultDir, { recursive: true, force: true })
    }
  }, 180_000)
})
