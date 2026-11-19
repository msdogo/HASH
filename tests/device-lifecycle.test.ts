import { describe, it, expect } from 'vitest'
import { createFileViewsModel } from '../src/shared/file-view'
import { DeviceManager, RETAIN_MS } from '../electron/devices/manager'

/*
 * 【终审 I-3 / 第 11 次假护栏】「设备表 → 分片生命周期」的行为门禁。
 *
 * 修前守这条的是 expect(page).toContain('syncDevices(') —— import 行与 store 定义
 * 都能满足。终审实测：把 FilesPage 里真实的 useEffect 调用删掉、只留注释，
 * 全量 1164 passed、tsc exit 0；后果是分片永不 forget，每台设备残留整份 entries
 * （内存单调增长，与规格「<400MB」冲突）。
 *
 * 这里测的是分片模型与设备管理器的**真实行为**：
 *   ① 新设备出现 → 真的得到一份 view state；
 *   ② 设备消失并超过 30 分钟保留期 → 被 GC（manager 发 removed），随后分片被 forget；
 *   ③ 在线设备不被优先淘汰（超过上限时也不能挤掉在线的那几台）。
 *
 * 如实声明：FilesPage 里那一行 useEffect 调用点本身在本工程无法观测
 * （渲染期副作用，无 jsdom），见报告。
 */

function model(options: { maxSerials?: number } = {}) {
  return createFileViewsModel({
    fetch: async () => ({ ok: true, data: { dir: '/', entries: [], degraded: false } }) as never,
    onChange: () => undefined,
    ...options,
  })
}

describe('终审 I-3 ①：新设备出现 → 得到新的 view state', () => {
  it('syncDevices 给新设备建分片，已有设备不被重置', () => {
    const m = model()
    m.syncDevices(['A'])
    expect(m.getViews().A).toBeDefined()
    expect(m.serials()).toEqual(['A'])

    m.syncDevices(['A', 'B'])
    expect(m.getViews().A).toBeDefined()
    expect(m.getViews().B).toBeDefined()
    expect(m.serials().slice().sort()).toEqual(['A', 'B'])
  })

  it('同一批serial重复同步不会抖出多余分片', () => {
    const m = model()
    m.syncDevices(['A', 'B'])
    m.syncDevices(['A', 'B'])
    expect(Object.keys(m.getViews()).sort()).toEqual(['A', 'B'])
  })
})

describe('终审 I-3 ②：设备消失超过 30 分钟保留期 → 被 GC，分片被 forget', () => {
  /** 复刻生产链：manager 判定掉线/清理 → 剩下的设备表喂给分片模型。 */
  function chain() {
    const mgr = new DeviceManager()
    const m = model()
    const push = (): void => {
      m.syncDevices(mgr.list().map((device) => device.serial))
    }
    return { mgr, m, push }
  }

  it('30 分钟内：设备转 offline 但分片必须保留（切回各自恢复）', () => {
    const h = chain()
    h.mgr.upsert({ serial: 'A', status: 'device' })
    h.push()
    expect(h.m.getViews().A).toBeDefined()

    h.mgr.applySnapshot([]) // 设备从设备表消失
    expect(h.mgr.get('A')?.status).toBe('offline')
    h.push()
    // 会话还留着 → 分片也留着
    expect(h.m.getViews().A).toBeDefined()
  })

  it('超过 30 分钟：manager 清理该会话，分片随之被 forget（内存不再单调增长）', () => {
    const h = chain()
    h.mgr.upsert({ serial: 'A', status: 'device' })
    h.push()

    h.mgr.applySnapshot([])
    // 30 分钟后仍是会话保留期，gc 不动它
    h.mgr.gc(Date.now() + RETAIN_MS - 1000)
    expect(h.mgr.get('A')).toBeDefined()

    // 超过保留期 → removed
    h.mgr.gc(Date.now() + RETAIN_MS + 1000)
    expect(h.mgr.get('A')).toBeUndefined()
    h.push()

    expect(h.m.getViews().A).toBeUndefined()
    expect(h.m.serials()).not.toContain('A')
  })

  it('设备直接消失（未超期）时也会 forget 分片', () => {
    const m = model()
    m.syncDevices(['A', 'B'])
    m.syncDevices(['B'])
    expect(m.getViews().A).toBeUndefined()
    expect(m.getViews().B).toBeDefined()
  })
})

describe('终审 I-3 ③：在线设备不被优先淘汰（deferred #43 的修法）', () => {
  it('三台都在线且超上限：一台都不淘汰（内存让位于正确性）', () => {
    const m = model({ maxSerials: 2 })
    m.syncDevices(['A', 'B', 'C'])
    // 修前的用例（先 ensure 一台离线的 D）对「!online.has → true」这个变异是瞎的，
    // 因为淘汰顺序恰好把 D 挑走。这一条才是能红的判据。
    expect(Object.keys(m.getViews()).sort()).toEqual(['A', 'B', 'C'])
    expect(m.serials().slice().sort()).toEqual(['A', 'B', 'C'])
  })

  it('有离线分片时先淘汰离线的，在线的一台都不动', () => {
    const m = model({ maxSerials: 2 })
    m.ensure('GONE') // 不在设备表里 = 非在线
    m.syncDevices(['A', 'B'])
    expect(m.getViews().GONE).toBeUndefined()
    expect(m.getViews().A).toBeDefined()
    expect(m.getViews().B).toBeDefined()
  })
})
