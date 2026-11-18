import { describe, it, expect } from 'vitest'
import {
  CH,
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  isEventChannel,
  isInvokeChannel,
} from '../electron/ipc/channels'

describe('IPC 通道常量（契约形状）', () => {
  it('本任务新增的三个通道值与简报逐字一致', () => {
    expect(CH.DEVICES_LIST).toBe('devices:list')
    expect(CH.DEVICES_CHANGED).toBe('devices:changed')
    expect(CH.FS_LIST).toBe('fs:list')
  })

  it('fs:list 的载荷字段固定为 serial + dir（任务 7 在此基础上扩展）', () => {
    expect(CH.FS_LIST).toBe('fs:list')
  })

  it('invoke 与 event 通道不重叠（避免把推送挂到 handle 上）', () => {
    for (const channel of INVOKE_CHANNELS) expect(isEventChannel(channel)).toBe(false)
    for (const channel of EVENT_CHANNELS) expect(isInvokeChannel(channel)).toBe(false)
    expect(INVOKE_CHANNELS.length + EVENT_CHANNELS.length).toBe(Object.keys(CH).length)
  })

  it('白名单判定拒绝任何未登记通道', () => {
    expect(isInvokeChannel('devices:list')).toBe(true)
    expect(isInvokeChannel('devices:changed')).toBe(false)
    expect(isInvokeChannel('evil:channel')).toBe(false)
    expect(isEventChannel('devices:changed')).toBe(true)
    expect(isEventChannel('fs:list')).toBe(false)
    expect(isEventChannel('renderer:inject')).toBe(false)
  })

  it('通道值统一形如 domain:action', () => {
    for (const value of Object.values(CH)) expect(value).toMatch(/^[a-z]+:[a-z]+$/)
  })
})
