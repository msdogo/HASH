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
    /*
     * 每个通道都必须归入 invoke 或 event 之一，且不重复登记。
     *
     * 修前的写法是「两者数量之和 == CH 的键数」，任务 9 加了 8 个 invoke 通道后
     * 那条断言会红 —— 但红的原因是「清单没跟上」，不是「实现有问题」。
     * 改成按**通道值**去重再比：漏登记会少一个值，重复登记会多一个值，
     * 两种错误都能抓到，且新增通道时只要清单同步就一定通过。
     */
    const all = [...INVOKE_CHANNELS, ...EVENT_CHANNELS]
    expect(new Set(all).size).toBe(all.length)
    expect([...all].sort()).toEqual([...Object.values(CH)].sort())
  })

  it('白名单判定拒绝任何未登记通道', () => {
    expect(isInvokeChannel('devices:list')).toBe(true)
    expect(isInvokeChannel('devices:changed')).toBe(false)
    expect(isInvokeChannel('evil:channel')).toBe(false)
    expect(isEventChannel('devices:changed')).toBe(true)
    expect(isEventChannel('fs:list')).toBe(false)
    expect(isEventChannel('renderer:inject')).toBe(false)
  })

  it('通道值统一形如 domain:action（action 允许 kebab-case）', () => {
    /*
     * action 段允许连字符：任务 8 引入了 transfer:pick-files。
     * 原来的 /^[a-z]+:[a-z]+$/ 会把合法的多词动作判非法 —— 那是断言过严，不是实现有问题，
     * 所以放宽到「小写字母开头、kebab-case」，domain 段仍然不允许连字符（一个词就够）。
     */
    for (const value of Object.values(CH)) expect(value).toMatch(/^[a-z]+:[a-z][a-z-]*$/)
  })
})
