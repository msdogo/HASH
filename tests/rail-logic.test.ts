import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { hasUnauthorized, summarize } from '../src/shared/device-view'
import type { DeviceSession } from '../src/shared/types'

const root = path.resolve(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

function dev(over: Partial<DeviceSession> & { serial: string }): DeviceSession {
  return {
    serial: over.serial,
    status: over.status ?? 'device',
    transport: over.transport ?? 'usb',
    model: over.model,
    lastSeenAt: 1,
  }
}

/*
 * I6（审查轮 1）：DeviceRail.tsx 里内联了 devices.some((d) => d.status === 'unauthorized')，
 * 与 shared 的 summarize() 重复。内联判断没有测试覆盖，且两处逻辑将来会漂移。
 */

describe('I6 设备栏判断收敛到纯函数', () => {
  it('hasUnauthorized 覆盖有/无未授权设备', () => {
    expect(hasUnauthorized([dev({ serial: 'A', status: 'unauthorized' })])).toBe(true)
    expect(hasUnauthorized([dev({ serial: 'A', status: 'device' })])).toBe(false)
    expect(hasUnauthorized([])).toBe(false)
    expect(hasUnauthorized([dev({ serial: 'A', status: 'offline' }), dev({ serial: 'B', status: 'unknown' })])).toBe(false)
  })

  it('hasUnauthorized 与 summarize().unauthorized 永远一致（不许两套逻辑漂移）', () => {
    const samples: DeviceSession[][] = [
      [],
      [dev({ serial: 'A', status: 'unauthorized' })],
      [dev({ serial: 'A', status: 'device' }), dev({ serial: 'B', status: 'unauthorized' })],
      [dev({ serial: 'A', status: 'offline' })],
    ]
    for (const list of samples) {
      expect(hasUnauthorized(list)).toBe(summarize(list).unauthorized > 0)
    }
  })

  it('DeviceRail 不再内联 devices.some(...unauthorized...)', () => {
    const rail = read('src/components/DeviceRail.tsx')
    expect(rail).not.toMatch(/devices\.some\(/)
    expect(rail).toContain('hasUnauthorized')
  })
})
