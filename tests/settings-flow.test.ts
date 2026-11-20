import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isAbsolutePath, downloadDirForDownload, downloadTargetOf, toSettingsAdb } from '../src/shared/settings'
import { makeDownloadHandler } from '../src/shared/download-flow'
import { DragOutService } from '../electron/drag/service'
import type { TransferTask } from '../src/shared/transfer'
import type { SettingsData } from '../src/shared/settings'

/*
 * R2-2：**下载目标的优先级**（用户裁决的核心诉求）。
 *
 * 用户的原话拆成两条规则：
 *   1. 普通下载（工具条「下载到本地」）→ 设置里的 downloadDir；
 *   2. 拖拽下载 → 资源管理器的拖放目标（那条路在 electron/drag/service.ts，
 *      本文件不管；但下面有一条「普通下载绝不取本地面板目录」的对拍）。
 *
 * 为什么这些断言必须在 shared 层：FilesPage 是组件，本项目的测试工程（tsconfig.node，
 * 无 DOM）import 不进 src/pages —— 「下载目标取了哪一份」在组件里观测不到，
 * 而它正是修前出错的地方（取的是 useLocalStore 的 cwd）。判定搬到 shared 后，
 * 组件只是把纯函数的结果注入 makeDownloadHandler，这里是真正可执行的门禁。
 */

const SETTINGS_DIR = 'C:/Users/me/Downloas-from-settings'
const LOCAL_PANEL_CWD = 'D:/somewhere/else/local-panel'
const SERIAL = 'TESTSERIAL'

function settingsWith(over: Partial<SettingsData> = {}): SettingsData {
  return {
    downloadDir: SETTINGS_DIR,
    defaultDownloadDir: 'C:/Users/me/Downloads',
    adb: { state: 'ok', source: 'path', path: 'C:/adb.exe', version: '1.0.41' },
    ...over,
  }
}

describe('R2-2 优先级：普通下载用设置里的 downloadDir（不是本地面板 cwd）', () => {
  it('两个候选同时给出时，取设置里的目录', () => {
    expect(downloadDirForDownload(settingsWith(), LOCAL_PANEL_CWD)).toBe(SETTINGS_DIR)
  })

  it('本地面板 cwd 与设置目录相同时也不出错（不是靠「撞巧一样」通过的）', () => {
    // 反向验证：把设置目录换成本地面板的 cwd，结果必须跟着**设置**走
    expect(downloadDirForDownload(settingsWith({ downloadDir: LOCAL_PANEL_CWD }), LOCAL_PANEL_CWD))
      .toBe(LOCAL_PANEL_CWD)
    expect(downloadDirForDownload(settingsWith({ downloadDir: SETTINGS_DIR }), SETTINGS_DIR))
      .toBe(SETTINGS_DIR)
  })

  it('设置缺失时返回 undefined（调用方据此提示），**绝不**回退到本地面板 cwd', () => {
    // 这一条就是用户抱怨的旧行为的反面：修前 localDir() 直接返回本地 cwd，
    // 所以即便设置没读到，下载也照样往本地面板的目录里放。
    expect(downloadDirForDownload(null, LOCAL_PANEL_CWD)).toBeUndefined()
    expect(downloadDirForDownload(settingsWith({ downloadDir: '' }), LOCAL_PANEL_CWD)).toBeUndefined()
  })

  it('设置里是相对路径时返回 undefined（坏值不会变成一次往奇怪位置的下载）', () => {
    expect(downloadDirForDownload(settingsWith({ downloadDir: 'relative/dir' }), LOCAL_PANEL_CWD)).toBeUndefined()
  })

  it('downloadTargetOf 给出可区分的降级原因（界面能说清是「没有」还是「坏值」）', () => {
    expect(downloadTargetOf({ settingsDir: SETTINGS_DIR })).toEqual({ ok: true, dir: SETTINGS_DIR })
    expect(downloadTargetOf({ settingsDir: undefined })).toEqual({ ok: false, reason: 'no-settings' })
    expect(downloadTargetOf({ settingsDir: '   ' })).toEqual({ ok: false, reason: 'no-settings' })
    expect(downloadTargetOf({ settingsDir: 'relative/dir' })).toEqual({ ok: false, reason: 'invalid-settings' })
  })

  it('注入 makeDownloadHandler 后，入队的 dstDir 就是设置里的目录', async () => {
    const calls: Array<{ serial: string; sources: string[]; localDir: string }> = []
    const settings = settingsWith()
    const handler = makeDownloadHandler({
      serial: SERIAL,
      run: async (serial, sources, localDir) => {
        calls.push({ serial, sources, localDir })
        return null
      },
      selectedTargets: () => ['/sdcard/DCIM/a.jpg'],
      // 与 FilesPage 完全同一条注入线（组件里也是这一行）
      localDir: () => downloadDirForDownload(settings, LOCAL_PANEL_CWD),
      notify: () => undefined,
    })
    await handler()
    expect(calls).toEqual([{ serial: SERIAL, sources: ['/sdcard/DCIM/a.jpg'], localDir: SETTINGS_DIR }])
    // 明确断言：不是本地面板的目录
    expect(calls[0]?.localDir).not.toBe(LOCAL_PANEL_CWD)
  })

  it('设置读取失败时给用户可理解的提示，且**不**入队（不是静默失败）', async () => {
    const calls: string[] = []
    const notices: Array<string | null> = []
    const handler = makeDownloadHandler({
      serial: SERIAL,
      run: async (_serial, _sources, localDir) => { calls.push(localDir); return null },
      selectedTargets: () => ['/sdcard/a.txt'],
      localDir: () => downloadDirForDownload(null, LOCAL_PANEL_CWD),
      notify: (text) => { notices.push(text) },
    })
    await handler()
    expect(calls).toEqual([])
    expect(notices).toHaveLength(1)
    expect(notices[0]).not.toBeNull()
    // 提示必须指向「设置」，而不是把用户再引回本地面板（旧文案就是那么写的）
    expect(String(notices[0])).toContain('设置')
  })
})

describe('R2-2 拖拽下载用拖放目标（临时目录），与设置里的 downloadDir 无关', () => {
  /*
   * 拖出这条路的目标由资源管理器决定，主进程只能先把文件落到自己的临时目录
   * （electron/drag/service.ts 的 tempDir()）。所以对拍就是：
   * **同一份设置下**，普通下载入队 dstDir = 设置目录，拖出入队 dstDir = 拖拽临时目录。
   * 若有人把「拖拽也用设置目录」写进去，这条会红。
   */
  it('同一份设置：普通下载落到 downloadDir，拖出落到拖拽临时目录', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'adbfm-drag-target-'))
    try {
      const enqueued: Array<{ src: string; dstDir: string }> = []
      const tasks = new Map<string, TransferTask>()
      let seq = 0
      const service = new DragOutService({
        tempRoot: () => tempRoot,
        enqueue: async (input) => {
          enqueued.push({ src: input.src, dstDir: input.dstDir })
          seq += 1
          const id = 'drag-' + seq
          const name = input.src.split('/').pop() ?? 'file'
          const task: TransferTask = {
            id, serial: input.serial, direction: 'pull', src: input.src,
            dst: path.join(input.dstDir, name), totalBytes: 1, doneBytes: 1,
            status: 'done', attempt: 0, createdAt: 0, finishedAt: 1,
          }
          // 必须真的落一个文件，否则 verifyLocal 会判 E_SYNC_FAILED
          writeFileSync(task.dst, 'x')
          tasks.set(id, task)
          return task
        },
        getTask: (id) => tasks.get(id),
        tick: async () => undefined,
        emitProgress: () => undefined,
        emitFailed: () => undefined,
        startDrag: () => undefined,
      })

      const result = await service.dragOut({ serial: SERIAL, paths: ['/sdcard/DCIM/a.jpg'] })
      expect(result.ok).toBe(true)

      const settingsDir = downloadDirForDownload(settingsWith(), LOCAL_PANEL_CWD)
      expect(enqueued).toHaveLength(1)
      // 拖出的落点是拖拽临时目录
      expect(enqueued[0]?.dstDir).toBe(service.tempDir())
      // 且**不是**设置里的下载目录（两个目标各归各的）
      expect(enqueued[0]?.dstDir).not.toBe(settingsDir)
      expect(enqueued[0]?.dstDir).not.toBe(SETTINGS_DIR)
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})

describe('R2-2 shared 规则：绝对路径判定与 adb 快照', () => {
  it('POSIX / Windows 盘符 / UNC 判为绝对；相对与盘符相对判为非绝对', () => {
    expect(isAbsolutePath('/home/me/Downloads')).toBe(true)
    expect(isAbsolutePath('C:/Users/me/Downloads')).toBe(true)
    expect(isAbsolutePath('C:\\Users\\me\\Downloads')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share\\dl')).toBe(true)
    expect(isAbsolutePath('relative/dir')).toBe(false)
    expect(isAbsolutePath('C:foo')).toBe(false)
    expect(isAbsolutePath('')).toBe(false)
  })

  it('AdbState → 设置页快照：ok 保留三个字段，checking / error 只留判别标签', () => {
    expect(toSettingsAdb({ state: 'ok', path: 'C:/adb.exe', version: '1.0.41', source: 'bundled' }))
      .toEqual({ state: 'ok', source: 'bundled', path: 'C:/adb.exe', version: '1.0.41' })
    expect(toSettingsAdb({ state: 'checking' })).toEqual({ state: 'checking' })
    expect(toSettingsAdb({ state: 'error', code: 'E_ADB_NOT_FOUND', attempts: [] }))
      .toEqual({ state: 'error', code: 'E_ADB_NOT_FOUND' })
  })
})
