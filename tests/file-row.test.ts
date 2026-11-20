import { describe, it, expect } from 'vitest'
import { ROW_ACTIVE_CLASS, ROW_IDLE_CLASS, ROW_FOCUS_CLASS, rowClassName } from '../src/shared/file-row'

/*
 * R4 事项 3 的门禁：**多选时那圈黄框**。
 *
 * 现象：行是 tabIndex={0} 的 div（Enter 打开），浏览器默认给它画焦点环；
 * 用户鼠标点一下就出现一圈黄描边，多选时连点几次满屏黄框。
 *
 * 修法有两条互相拉扯的约束，正是最容易写反的地方：
 *   a) 鼠标点击（:focus，不含 :focus-visible）不能看到环 → 必须 outline-none；
 *   b) Tab 聚焦（:focus-visible）**必须**还能看见 → 保留 focus-visible 的细内描边。
 * 只做 a 会砸掉键盘可达性；只做 b 等于没修。所以两条都要断言，且要断言
 * 「不是裸 ring-1」（那会在鼠标点击时也画环，等于把黄框换个颜色接着显示）。
 */

const classes = (value: string): string[] => value.split(/\s+/).filter((part) => part !== '')

describe('R4-3 rowClassName：去掉鼠标焦点的黄框，保留键盘焦点环', () => {
  it('带 outline-none（这一条直接对应黄框消失）', () => {
    expect(classes(rowClassName(false))).toContain('outline-none')
    expect(classes(rowClassName(true))).toContain('outline-none')
  })

  it('焦点环是 focus-visible 的细蓝内描边（键盘可达性不退化）', () => {
    for (const value of [rowClassName(false), rowClassName(true)]) {
      const tokens = classes(value)
      expect(tokens).toContain('focus-visible:ring-1')
      expect(tokens).toContain('focus-visible:ring-sky-500')
      expect(tokens).toContain('focus-visible:ring-inset')
    }
  })

  it('不得出现裸 ring / focus: ring（否则鼠标点击时照样画环，等于没修）', () => {
    for (const value of [rowClassName(false), rowClassName(true)]) {
      const tokens = classes(value)
      // 允许的只有 focus-visible: 前缀的那些
      for (const token of tokens) {
        if (!token.includes('ring')) continue
        expect(token.startsWith('focus-visible:'), token).toBe(true)
      }
      expect(tokens).not.toContain('ring')
      expect(tokens).not.toContain('ring-1')
      expect(tokens).not.toContain('outline')
      // 也不许用 focus:outline-none 之外的写法把它又加回来
      expect(tokens).not.toContain('focus:ring-1')
    }
  })

  it('选中态与未选中态的背景互斥，且焦点类两边都在', () => {
    const active = classes(rowClassName(true))
    const idle = classes(rowClassName(false))
    // 常量本身可能含多个 token，逐个比（直接 toContain 整串会永远失败）
    for (const token of classes(ROW_ACTIVE_CLASS)) {
      expect(active).toContain(token)
      expect(idle).not.toContain(token)
    }
    for (const token of classes(ROW_IDLE_CLASS)) {
      expect(idle).toContain(token)
      expect(active).not.toContain(token)
    }
    expect(ROW_ACTIVE_CLASS).not.toBe(ROW_IDLE_CLASS)
    // 焦点类不随选中态变化：选中后再 Tab 过去也要看得见
    for (const token of classes(ROW_FOCUS_CLASS)) {
      expect(active).toContain(token)
      expect(idle).toContain(token)
    }
  })

  it('行仍然是 flex 布局且不换行（虚拟列表的行高必须是固定 34px）', () => {
    const tokens = classes(rowClassName(false))
    expect(tokens).toContain('flex')
    expect(tokens).toContain('items-center')
    expect(tokens).toContain('px-3')
    expect(tokens).toContain('select-none')
    // 行高由内联 style 的 ROW_HEIGHT 决定，class 里不该再出现高度
    for (const token of tokens) expect(token.startsWith('h-')).toBe(false)
  })
})
