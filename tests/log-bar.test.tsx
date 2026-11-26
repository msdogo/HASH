import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LogBar, type LogBarProps } from '../src/components/LogBar'
import { t } from '../src/shared/i18n'
import { appendLog, formatLogTime, lastEntryText, LOG_MAX_ENTRIES, type LogEntry } from '../src/shared/log'

/*
 * 日志栏的渲染门禁（安装进度与结果）。
 *
 * 为什么要单独立这条栏：页面顶部的 notice 是单槽的（下一条顶掉上一条、切页丢失），
 * 而安装一个包要几十秒且经常切页 —— 用户回来时必须还能看到「刚才发生了什么」。
 * SSR 只跑一次 render、拿不到事件，所以这里断言形态与纯函数，事件接线如实登记无门禁。
 */

type Initial = NonNullable<LogBarProps['initial']>
const Bar = LogBar as unknown as (props: { initial?: Initial }) => React.ReactElement

function html(over: Initial = {}): string {
  return renderToStaticMarkup(React.createElement(Bar, { initial: over }))
}

function entry(id: number, text: string, level: 'info' | 'error' = 'info'): LogEntry {
  return { id, at: 1_700_000_000_000, level, text }
}

describe('日志栏的形态', () => {
  it('空态说「暂无日志」，而不是留一片空白', () => {
    expect(html()).toContain(t('log.empty'))
  })

  it('展开态把每条都渲染出来（带时间戳）', () => {
    const out = html({ entries: [entry(1, '第一条'), entry(2, '第二条')] })
    expect(out).toContain('第一条')
    expect(out).toContain('第二条')
    expect(out).toContain(formatLogTime(1_700_000_000_000))
  })

  it('折叠态只留最新一条（否则折叠没有意义）', () => {
    const out = html({ entries: [entry(1, '旧的那条'), entry(2, '新的那条')], collapsed: true })
    expect(out).toContain('新的那条')
    expect(out).not.toContain('旧的那条')
  })

  it('失败用红色标出来（不靠用户逐字去读）', () => {
    const out = html({ entries: [entry(1, '装失败了', 'error')] })
    expect(out).toContain('text-red-600')
  })

  it('安装进度条按真实百分比给宽度，并显示阶段', () => {
    const out = html({
      installing: { serial: 'S1', phase: 'pushing', apkName: 'a.apk', doneBytes: 30, totalBytes: 100, percent: 27 },
    })
    expect(out).toContain('width:27%')
    expect(out).toContain(t('apps.phase.pushing'))
  })

  it('安装阶段不再是假百分比：显示不确定态文案', () => {
    const out = html({
      installing: { serial: 'S1', phase: 'installing', apkName: 'a.apk', doneBytes: 100, totalBytes: 100, percent: 90 },
    })
    expect(out).toContain(t('apps.installingPhase'))
  })
})

describe('日志模型（纯函数）', () => {
  it('超过上限时丢最旧的，保留最近的', () => {
    let entries: LogEntry[] = []
    for (let i = 0; i < LOG_MAX_ENTRIES + 5; i++) entries = appendLog(entries, entry(i, 'e' + i))
    expect(entries.length).toBe(LOG_MAX_ENTRIES)
    expect(entries[entries.length - 1]?.text).toBe('e' + (LOG_MAX_ENTRIES + 4))
  })

  it('追加不改原数组（React 依赖引用变化决定重渲染）', () => {
    const original: LogEntry[] = []
    const next = appendLog(original, entry(1, 'x'))
    expect(original.length).toBe(0)
    expect(next.length).toBe(1)
  })

  it('lastEntryText 在没有日志时返回空串（折叠态不能崩）', () => {
    expect(lastEntryText([])).toBe('')
    expect(lastEntryText([entry(1, 'abc')])).toBe('abc')
  })

  it('时间戳是本地时区的 HH:MM:SS（用户拿自己的钟对时间）', () => {
    const ms = new Date(2026, 10, 25, 9, 5, 7).getTime()
    expect(formatLogTime(ms)).toBe('09:05:07')
  })
})