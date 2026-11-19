import { describe, it, expect } from 'vitest'
import {
  activeTaskCount,
  batchDetailKey,
  batteryPercent,
  canSubmit,
  createStdoutBudget,
  isDangerousCommand,
  storageView,
  summarizeBatch,
  truncateUtf8,
  type BatchItemResult,
} from '../src/shared/batch'
import { tf } from '../src/shared/i18n'

/*
 * 总览页的展示数据纯函数（任务 10 / 规格 §9.3）。
 *
 * 这一组用例守的是**「没有数据就显示占位符，绝不编造」**这条：
 * DeviceSession 的 battery / storage 是可选的，而唯一数据来源 abh devices -l 不含它们，
 * 所以真实运行中几乎总是 undefined。若这里把 undefined 变成 0% 或 0/0 GB，
 * 界面就会显示一台「电量 0%、存储 0/0G」的假设备。
 */

describe('batteryPercent：没有数据就是 null', () => {
  it('undefined → null（绝不回退成 0）', () => {
    expect(batteryPercent(undefined)).toBeNull()
  })

  it('合法值原样返回（含 0 与 100 两个边界）', () => {
    expect(batteryPercent(0)).toBe(0)
    expect(batteryPercent(86)).toBe(86)
    expect(batteryPercent(100)).toBe(100)
  })

  it('越界 / 非有限数 → null（设备上报了坏值也不画一条假进度）', () => {
    expect(batteryPercent(-1)).toBeNull()
    expect(batteryPercent(101)).toBeNull()
    expect(batteryPercent(Number.NaN)).toBeNull()
    expect(batteryPercent(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('storageView：没有数据就是 null', () => {
  it('undefined → null', () => {
    expect(storageView(undefined)).toBeNull()
  })

  it('总量为 0 / 负数 → null（避免除零得到一个 100% 的假进度条）', () => {
    expect(storageView({ usedKb: 0, totalKb: 0 })).toBeNull()
    expect(storageView({ usedKb: 10, totalKb: -1 })).toBeNull()
    expect(storageView({ usedKb: -5, totalKb: 100 })).toBeNull()
  })

  it('正常值给出百分比与「已用 / 总量 GB」标签', () => {
    // 108G / 128G
    const used = 108 * 1024 * 1024
    const total = 128 * 1024 * 1024
    const view = storageView({ usedKb: used, totalKb: total })
    expect(view).not.toBeNull()
    expect(view?.label).toBe('108 / 128 GB')
    expect(view?.percent).toBeCloseTo(84.375, 3)
  })

  it('已用超过总量时百分比夹在 100（不画出条外）', () => {
    const view = storageView({ usedKb: 200, totalKb: 100 })
    expect(view?.percent).toBe(100)
  })
})

describe('activeTaskCount：只数排队与进行中', () => {
  const tasks = [
    { serial: 'A', status: 'running' },
    { serial: 'A', status: 'queued' },
    { serial: 'A', status: 'done' },
    { serial: 'A', status: 'failed' },
    { serial: 'B', status: 'running' },
  ]

  it('只统计目标设备的 running + queued', () => {
    expect(activeTaskCount(tasks, 'A')).toBe(2)
    expect(activeTaskCount(tasks, 'B')).toBe(1)
  })

  it('没有任务返回 0（界面显示「空闲」而不是「0 任务」）', () => {
    expect(activeTaskCount(tasks, 'C')).toBe(0)
    expect(activeTaskCount([], 'A')).toBe(0)
  })

  it('已结束的任务不算（done / failed / canceled 都不该让界面一直显示有任务在跑）', () => {
    expect(activeTaskCount([{ serial: 'A', status: 'canceled' }], 'A')).toBe(0)
  })
})

describe('truncateUtf8：按字节截断，不切出半个码点', () => {
  it('未超限时原样返回且 truncated=false', () => {
    expect(truncateUtf8('abc', 10)).toEqual({ text: 'abc', truncated: false })
  })

  it('超限时截断并标 truncated=true', () => {
    expect(truncateUtf8('abcdef', 3)).toEqual({ text: 'abc', truncated: true })
  })

  it('汉字按 3 字节算：512 字节只能放 170 个汉字', () => {
    const result = truncateUtf8('汉'.repeat(300), 512)
    expect(result.text).toBe('汉'.repeat(170))
    expect(result.truncated).toBe(true)
  })

  it('不会切出 U+FFFD（半截码点）', () => {
    const result = truncateUtf8('汉'.repeat(300), 500)
    // 500 / 3 = 166 个汉字（498 字节），第 167 个会跨过上限
    expect(result.text).toBe('汉'.repeat(166))
    expect(result.text).not.toContain('\uFFFD')
  })

  it('maxBytes <= 0 时返回空串，且是否截断取决于原串是否为空', () => {
    expect(truncateUtf8('x', 0)).toEqual({ text: '', truncated: true })
    expect(truncateUtf8('', 0)).toEqual({ text: '', truncated: false })
  })

  it('恰好等于上限时不标截断（边界不能误报）', () => {
    expect(truncateUtf8('abcd', 4)).toEqual({ text: 'abcd', truncated: false })
  })
})

describe('summarizeBatch', () => {
  it('统计成功/失败/总数', () => {
    const results: BatchItemResult[] = [
      { serial: 'A', ok: true },
      { serial: 'B', ok: false, code: 'E_DEVICE_OFFLINE' },
      { serial: 'C', ok: true },
    ]
    expect(summarizeBatch(results)).toEqual({ ok: 2, failed: 1, total: 3 })
  })

  it('空结果全零（不是 NaN，也不抛）', () => {
    expect(summarizeBatch([])).toEqual({ ok: 0, failed: 0, total: 0 })
  })
})

describe('batchDetailKey：主进程只给数据，文案在这里拼', () => {
  it('截图成功 → 「已加入队列」（detail 是任务 id，绝不把它直接贴给用户）', () => {
    const mapped = batchDetailKey('screenshot', { serial: 'A', ok: true, detail: 'task-7' })
    expect(mapped).toEqual({ key: 'batch.result.queued', params: {} })
    // 关键：任务 id 不能被塞进参数里（用户不知道 task-7 是什么）
    expect(JSON.stringify(mapped)).not.toContain('task-7')
  })

  it('推送成功 → 带文件数的「N 个文件已加入队列」（R2：批量层只入队）', () => {
    const mapped = batchDetailKey('push', { serial: 'A', ok: true, detail: '3' })
    expect(mapped).toEqual({ key: 'batch.result.filesQueued', params: { count: '3' } })
  })

  it('执行命令成功 → 把 stdout 摘要放进「输出：{text}」', () => {
    const mapped = batchDetailKey('shell', { serial: 'A', ok: true, detail: 'adbfm-ok' })
    expect(mapped).toEqual({ key: 'batch.shellOutput', params: { text: 'adbfm-ok' } })
  })

  it('执行命令成功但没有输出 → 「没有输出」（不是空字符串，否则那一行看起来像坏了）', () => {
    expect(batchDetailKey('shell', { serial: 'A', ok: true, detail: '' }))
      .toEqual({ key: 'batch.result.noOutput', params: {} })
    expect(batchDetailKey('shell', { serial: 'A', ok: true }))
      .toEqual({ key: 'batch.result.noOutput', params: {} })
  })

  it('安装成功 → 固定的成功文案', () => {
    expect(batchDetailKey('install', { serial: 'A', ok: true }))
      .toEqual({ key: 'batch.result.installed', params: {} })
  })

  it('失败项不产生 detail 文案（界面必须显示错误码，而不是伪装成成功）', () => {
    expect(batchDetailKey('shell', { serial: 'A', ok: false, code: 'E_TIMEOUT' })).toBeNull()
  })

  it('每个 detail key 都在 i18n 里登记（否则界面会显示原始 key）', () => {
    const keys = [
      batchDetailKey('screenshot', { serial: 'A', ok: true })?.key,
      batchDetailKey('install', { serial: 'A', ok: true })?.key,
      batchDetailKey('push', { serial: 'A', ok: true, detail: '1' })?.key,
      batchDetailKey('shell', { serial: 'A', ok: true, detail: 'x' })?.key,
      batchDetailKey('shell', { serial: 'A', ok: true })?.key,
    ]
    for (const key of keys) {
      expect(key, String(key)).toBeTruthy()
      const text = tf(key as string, { count: '1', text: 'x' })
      // 未登记的 key 会原样返回 —— 那正是这里要抓的
      expect(text, String(key)).not.toBe(key)
      expect(text, String(key)).toMatch(/[\u4e00-\u9fff]/)
    }
  })
})

describe('canSubmit：按钮能不能点（C1 的替代——行为断言，不是源码文本）', () => {
  it('运行中一律不可点（防重复提交）', () => {
    for (const action of ['screenshot', 'install', 'push', 'shell'] as const) {
      expect(canSubmit({ running: true, pickedCount: 3, action, fileCount: 1, dstDir: '/sdcard', command: 'ls' }))
        .toBe(false)
    }
  })

  it('没勾设备一律不可点', () => {
    for (const action of ['screenshot', 'install', 'push', 'shell'] as const) {
      expect(canSubmit({ running: false, pickedCount: 0, action, fileCount: 1, dstDir: '/sdcard', command: 'ls' }))
        .toBe(false)
    }
  })

  it('截图 / 安装只要有设备就能点', () => {
    expect(canSubmit({ running: false, pickedCount: 1, action: 'screenshot' })).toBe(true)
    expect(canSubmit({ running: false, pickedCount: 1, action: 'install' })).toBe(true)
  })

  it('推送需要同时有文件与非空目标目录', () => {
    const base = { running: false, pickedCount: 1, action: 'push' as const }
    expect(canSubmit({ ...base, fileCount: 0, dstDir: '/sdcard' })).toBe(false)
    expect(canSubmit({ ...base, fileCount: 1, dstDir: '   ' })).toBe(false)
    expect(canSubmit({ ...base, fileCount: 1 })).toBe(false)
    expect(canSubmit({ ...base, fileCount: 1, dstDir: '/sdcard/Download' })).toBe(true)
  })

  it('执行命令需要非空命令（纯空白不算）', () => {
    const base = { running: false, pickedCount: 1, action: 'shell' as const }
    expect(canSubmit({ ...base, command: '' })).toBe(false)
    expect(canSubmit({ ...base, command: '   ' })).toBe(false)
    expect(canSubmit({ ...base })).toBe(false)
    expect(canSubmit({ ...base, command: 'echo ok' })).toBe(true)
  })
})

describe('createStdoutBudget：流式封顶（I3）', () => {
  it('未超限时原样保留，不标截断', () => {
    const budget = createStdoutBudget(10)
    expect(budget.push('abc')).toBe(false)
    expect(budget.text()).toBe('abc')
    expect(budget.overflowed()).toBe(false)
  })

  it('超限时立即返回 true（调用方据此 abort），且缓冲不超过上限', () => {
    const budget = createStdoutBudget(5)
    expect(budget.push('abcdef')).toBe(true)
    expect(budget.text()).toBe('abcde')
    expect(budget.overflowed()).toBe(true)
  })

  it('超限后再喂 chunk 直接返回 true，且不再增长（内存恒定）', () => {
    const budget = createStdoutBudget(3)
    budget.push('abcd')
    const before = budget.text()
    for (let i = 0; i < 100; i++) expect(budget.push('x'.repeat(1024))).toBe(true)
    expect(budget.text()).toBe(before)
  })

  it('汉字按 3 字节计，且不切出半个码点', () => {
    const budget = createStdoutBudget(5)
    // 5 字节只放得下 1 个汉字（3 字节），第二个会跨过上限
    expect(budget.push('汉汉')).toBe(true)
    expect(budget.text()).toBe('汉')
    expect(budget.text()).not.toContain('�')
  })

  it('大数据流的内存表现：喂 10 MB 也不线性增长（缓冲恒 <= 上限）', () => {
    const budget = createStdoutBudget(8 * 1024)
    const chunk = 'x'.repeat(64 * 1024)
    let chunks = 0
    for (let i = 0; i < 160; i++) {
      chunks += 1
      if (budget.push(chunk)) break
    }
    // 10 MB 的输入在第 1 个 64 KB chunk 里就该封顶
    expect(chunks).toBe(1)
    expect(budget.text().length).toBe(8 * 1024)
    expect(budget.overflowed()).toBe(true)
  })
})

describe('isDangerousCommand：规格 §9.6 的二次确认判据', () => {
  it('kill-server / reboot / root 都算危险', () => {
    expect(isDangerousCommand('adb kill-server')).toBe(true)
    expect(isDangerousCommand('reboot')).toBe(true)
    expect(isDangerousCommand('su -c reboot')).toBe(true)
    expect(isDangerousCommand('root')).toBe(true)
    expect(isDangerousCommand('sh -c "reboot -p"')).toBe(true)
  })

  it('大小写不敏感（REBOOT 同样是危险命令）', () => {
    expect(isDangerousCommand('REBOOT')).toBe(true)
    expect(isDangerousCommand('Kill-Server')).toBe(true)
  })

  it('普通命令不算危险（避免每次都弹确认）', () => {
    expect(isDangerousCommand('echo ok')).toBe(false)
    expect(isDangerousCommand('ls -l /sdcard')).toBe(false)
    expect(isDangerousCommand('cat /sdcard/a.txt')).toBe(false)
    expect(isDangerousCommand('pm list packages')).toBe(false)
  })

  it('不误伤包含这些子串的普通词（rooted / rebootX / reroot）', () => {
    expect(isDangerousCommand('echo rooted')).toBe(false)
    expect(isDangerousCommand('cat rebootlog.txt')).toBe(false)
  })
})
