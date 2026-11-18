import { describe, it, expect } from 'vitest'
import { DeviceManager } from '../electron/devices/manager'
import { AdbTracking } from '../electron/app/sessions'
import type { AdbState, DevicesChangedBatch } from '../src/shared/types'

function silentChild(): unknown {
  return {
    pid: undefined,
    stdout: { on: () => {}, resume: () => {} },
    stderr: { resume: () => {} },
    on: () => {},
    kill: () => {},
  }
}

/*
 * 现场发现（2026-11-18，CDP 抓真实渲染层）：
 * 渲染层启动时先调一次 devices:list 拿首屏，此时 adb 自检（4~8s）往往还没结束，
 * 于是它拿到 adb = { state:'checking' } 并【永远停在 checking】——
 * 后续的 devices:changed 推送里根本没有 adb 字段，界面上「无法使用 adb」的提示
 * 因此永远不会出现。adb 状态必须跟推送一起走。
 */

const CHECKING: AdbState = { state: 'checking' }
const OK: AdbState = { state: 'ok', path: 'C:/adb.exe', version: '1.0.41', source: 'path' }
const NOT_FOUND: AdbState = { state: 'error', code: 'E_ADB_NOT_FOUND', attempts: [] }

function makeTracking(adb: () => AdbState): AdbTracking {
  return new AdbTracking({
    adbPath: 'C:/adb.exe',
    spawnTrack: () => silentChild() as never,
    adbState: adb,
  })
}

describe('推送批次必须携带 adb 状态（否则界面永远停在「正在查找 adb…」）', () => {
  it('设备变更的批次里带当前 adb 状态', () => {
    const t = makeTracking(() => OK)
    const batches: DevicesChangedBatch[] = []
    t.onDevicesChanged((b) => { batches.push(b) })
    t.mgr.upsert({ serial: 'A', status: 'device' })
    t.flushChanges()
    expect(batches).toHaveLength(1)
    expect(batches[0].adb).toEqual(OK)
    t.stop()
  })

  it('adb 自检状态变化本身也能推出去（设备表没变时也要推）', () => {
    let state: AdbState = CHECKING
    const t = makeTracking(() => state)
    const batches: DevicesChangedBatch[] = []
    t.onDevicesChanged((b) => { batches.push(b) })
    t.mgr.upsert({ serial: 'A', status: 'device' })
    t.flushChanges()
    expect(batches.map((b) => b.adb?.state)).toEqual(['checking'])

    // 自检失败 → 状态从 checking 变 error，设备表一个字没变
    state = NOT_FOUND
    t.notifyAdbState()
    t.flushChanges()
    expect(batches).toHaveLength(2)
    expect(batches[1].adb).toEqual(NOT_FOUND)
    // 没有设备变化，只有 adb 状态变化
    expect(batches[1].changed).toEqual([])
    expect(batches[1].removed).toEqual([])
    t.stop()
  })

  it('adb 状态没变时不会因为 notifyAdbState 反复推（保持去重语义）', () => {
    const t = makeTracking(() => OK)
    const batches: DevicesChangedBatch[] = []
    t.onDevicesChanged((b) => { batches.push(b) })
    t.mgr.upsert({ serial: 'A', status: 'device' })
    t.flushChanges()
    expect(batches).toHaveLength(1)
    t.notifyAdbState()
    t.notifyAdbState()
    t.flushChanges()
    expect(batches).toHaveLength(1)
    t.stop()
  })

  it('stop 之后 notifyAdbState 不再推', () => {
    const t = makeTracking(() => OK)
    let count = 0
    t.onDevicesChanged(() => { count += 1 })
    t.stop()
    t.notifyAdbState()
    t.flushChanges()
    expect(count).toBe(0)
  })
})
