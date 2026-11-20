import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DragOutService } from '../electron/drag/service'
import { shellQuote } from '../electron/adb/shellsafe'
import { TransferService } from '../electron/transfer/service'
import { AdbClient } from '../electron/adb/client'
import { acquireDeviceLock, deviceSkipMessage, resolveSerial } from './device-lock'

/*
 * 简报 C 的真机验收：**拖出一个真实文件，内容必须逐字节一致**。
 *
 * 这条用例覆盖的是本任务唯一无法用假依赖证明的事：
 * 「下载到临时目录 → 交给资源管理器」这条路上，落盘的字节与设备上的完全一样。
 * 其余部分（startDrag 的入参、失败零调用、临时目录清理）在
 * tests/drag-out.test.ts 用注入依赖压住了 —— 那些不该依赖真机。
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
const lockRelease = SERIAL === null ? null : acquireDeviceLock(SERIAL, 'drag-real')
const skip = SERIAL === null || lockRelease === null
if (skip) {
  // 三种原因（无设备 / serial 不在线 / 撞锁）必须能区分，且在模块顶层打印
  // （放 beforeAll 就晚了：全员 skip 时 beforeAll 根本不执行）
  console.log(deviceSkipMessage('drag-real', SERIAL, lockRelease))
}

/** 设备侧临时目录（用例结束清理）。 */
const REMOTE_DIR = '/sdcard/Download/adb-fm-drag-itest'

describe.skipIf(skip)('真机拖出（简报 C）：下载到临时目录后内容一致', () => {
  let dragDir = ''
  let service: DragOutService
  let transfer: TransferService
  let remoteName = ''

  function shell(command: string): string {
    return execFileSync(ADB, ['-s', SERIAL as string, 'shell', command], {
      encoding: 'utf8', windowsHide: true, timeout: 120_000,
    })
  }

  function sha256(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex')
  }

  beforeAll(() => {
    /*
     * 拖拽落点目录（R2-1 之后它只是本用例自己的临时目录，不再是「本地根」）。
     *
     * 必须用 realpathSync.native：Windows 的 mkdtempSync 会给出 8.3 短名
     * （C:\Users\ADMINI~1\...），而 resolveLocalPath 解析真实路径时用长名
     * （C:\Users\Administrator\...）。node 的 JS 版 realpath 不会展开 8.3 短名，
     * 只有 native 版会 —— 两边形态不一致会让「落点是否在拖拽目录里」的比对失败。
     */
    dragDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'adbfm-drag-real-')))
    transfer = new TransferService({
      adbPath: () => ADB,
      clientFor: (serial) => new AdbClient(serial),
      emit: () => undefined,
    })
    service = new DragOutService({
      tempRoot: () => dragDir,
      enqueue: (input) => transfer.controller.enqueue(input),
      getTask: (id) => transfer.controller.get(id),
      emitProgress: () => undefined,
      emitFailed: (payload) => { console.log('[drag-real] 失败事件：' + JSON.stringify(payload)) },
      // 真机用例不真的拖（Windows 上 startDrag 会卡住鼠标），只断言准备好的文件内容
      startDrag: () => undefined,
    })

    try { shell('rm -rf ' + REMOTE_DIR) } catch { /* 目录不存在是常态 */ }
    shell('mkdir -p ' + REMOTE_DIR)

    // 设备上造一个内容可校验的文件（二进制 + 中文文件名 + 空格）
    remoteName = '拖拽 校验.bin'
    const payload = Buffer.alloc(64 * 1024)
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251
    const localTemp = path.join(dragDir, 'seed.bin')
    writeFileSync(localTemp, payload)
    execFileSync(ADB, ['-s', SERIAL as string, 'push', localTemp, REMOTE_DIR + '/' + remoteName], {
      encoding: 'utf8', windowsHide: true, timeout: 120_000,
    })
  }, 180_000)

  afterAll(() => {
    try { shell('rm -rf ' + REMOTE_DIR) } catch { /* 忽略清理失败 */ }
    if (dragDir !== '') rmSync(dragDir, { recursive: true, force: true })
    // 释放设备锁（最后一个动作：确保设备侧清理已经跑完）
    lockRelease?.()
  })

  it('设备文件 → 临时目录：内容逐字节一致（sha256 比对）', async () => {
    const result = await service.dragOut({
      serial: SERIAL as string,
      paths: [REMOTE_DIR + '/' + remoteName],
    })
    expect(result).toEqual({ ok: true })

    // 临时目录里必须出现那个文件（名字与设备上一致）
    const prepared = readdirSync(service.tempDir())
    expect(prepared).toEqual([remoteName])

    const downloaded = readFileSync(path.join(service.tempDir(), remoteName))

    /*
     * 与设备上的内容对拍：用设备侧的 sha256sum（toybox 自带）算权威哈希，
     * 再与本机算出的哈希逐字符比较。
     *
     * 为什么不「再 pull 一份到 verify/ 目录」：adb pull 到**目录**时会用远端文件名
     * 建本地文件，而中文名在 Windows 控制台上会被按当前代码页截断
     * （实测报 "Illegal byte sequence"）。那是 adb 的路径编码问题，与本任务无关，
     * 却会让一条本该证明「内容一致」的用例红在别的理由上。
     * sha256sum 完全绕开这一点，而且正是简报要求的那种比对。
     *
     * shellQuote 是必需的：文件名里有中文与空格，不转义会被 shell 拆成多个单词。
     */
    const remoteHash = shell('sha256sum ' + shellQuote(REMOTE_DIR + '/' + remoteName)).trim().split(/\s+/)[0]
    const localHash = sha256(downloaded)
    expect(localHash).toBe(remoteHash)
    // 字节数也要一致（sha256 相等已蕴含，但这条读起来更直观）
    expect(downloaded.length).toBe(64 * 1024)

    console.log('[drag-real] 设备文件 sha256 = ' + remoteHash)
    console.log('[drag-real] 拖拽准备文件 sha256 = ' + localHash)
  }, 180_000)

  it('连续两次拖出：第二次开始前第一次的残留被清掉（真机路径同样成立）', async () => {
    // 第二次拖同一个文件：开始前临时目录必须被清空，只剩本次准备的那份
    const result = await service.dragOut({
      serial: SERIAL as string,
      paths: [REMOTE_DIR + '/' + remoteName],
    })
    expect(result).toEqual({ ok: true })
    expect(readdirSync(service.tempDir())).toEqual([remoteName])
  }, 180_000)
})
