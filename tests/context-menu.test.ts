import { describe, it, expect } from 'vitest'
import {
  MENU_ITEM_HEIGHT,
  MENU_MIN_WIDTH,
  MENU_VIEWPORT_MARGIN,
  SINGLE_SELECTION_ACTIONS,
  MULTI_SELECTION_ACTIONS,
  clampMenuPosition,
  contextSelectionFor,
  isPrimaryPointerButton,
  menuBoxSize,
  menuItemsFor,
  selectedCountAfterContext,
} from '../src/shared/context-menu'

/*
 * R5 事项 2 的门禁：右键菜单项集合 + 右键选中语义 + 视口夹取。
 *
 * 用户裁决（表驱动的唯一来源）：
 *   1 项 → 重命名、删除、下载到本地
 *   > 1 项 → 删除、下载到本地（重命名**不出现**，不是变灰）
 *
 * 这些函数就是生产代码（FilesPage / ContextMenu 也调用它们），不是测试仿制品。
 */

describe('R5-2 menuItemsFor：选中数量决定菜单项（断言完整 id 数组与顺序）', () => {
  const cases: { name: string; count: number; expected: string[] }[] = [
    { name: '0 项 → 空表（不渲染任何菜单）', count: 0, expected: [] },
    { name: '1 项 → 重命名 / 删除 / 下载到本地', count: 1, expected: ['rename', 'delete', 'download'] },
    { name: '2 项 → 删除 / 下载到本地（重命名整项不出现）', count: 2, expected: ['delete', 'download'] },
    { name: '5 项 → 删除 / 下载到本地', count: 5, expected: ['delete', 'download'] },
  ]
  for (const tableCase of cases) {
    it(tableCase.name, () => {
      expect(menuItemsFor(tableCase.count).map((item) => item.id)).toEqual(tableCase.expected)
    })
  }

  it('负数（防御性输入）按 0 处理，不抛错也不返回动作', () => {
    expect(menuItemsFor(-1).map((item) => item.id)).toEqual([])
  })

  it('多选时重命名是**不出现**而不是 disabled=true', () => {
    const ids = menuItemsFor(3).map((item) => item.id)
    expect(ids).not.toContain('rename')
    // 反向确认：不是「出现了但变灰」
    expect(menuItemsFor(3).some((item) => item.id === 'rename')).toBe(false)
  })

  it('返回项的 disabled 全部为 false（用户裁决是出现/不出现，不是置灰）', () => {
    for (const count of [1, 2, 5]) {
      expect(menuItemsFor(count).every((item) => item.disabled === false)).toBe(true)
    }
  })

  it('文案复用工具条已有的 i18n key（不新造重复文案）', () => {
    expect(menuItemsFor(1).map((item) => item.labelKey)).toEqual([
      'op.toolbar.rename',
      'op.toolbar.delete',
      'op.toolbar.download',
    ])
    expect(menuItemsFor(4).map((item) => item.labelKey)).toEqual(['op.toolbar.delete', 'op.toolbar.download'])
  })

  it('每次调用返回新数组（调用方就地排序/过滤不会污染下一次菜单）', () => {
    const first = menuItemsFor(1)
    first.pop()
    expect(menuItemsFor(1).map((item) => item.id)).toEqual(['rename', 'delete', 'download'])
  })

  it('单选与多选的常量与 menuItemsFor 的输出一致（单一来源）', () => {
    expect(SINGLE_SELECTION_ACTIONS).toEqual(['rename', 'delete', 'download'])
    expect(MULTI_SELECTION_ACTIONS).toEqual(['delete', 'download'])
  })
})

describe('R5-2 isPrimaryPointerButton：右键的 mousedown 不得改变选中项', () => {
  it('左键（button 0）→ true（正常选中）', () => {
    expect(isPrimaryPointerButton(0)).toBe(true)
  })

  it('中键（1）/ 右键（2）/ 侧键（3、4）→ 全 false', () => {
    for (const button of [1, 2, 3, 4]) expect(isPrimaryPointerButton(button), String(button)).toBe(false)
  })

  it('这是「多选后右键保持多选」成立的前提：右键 mousedown 不改选择，contextmenu 才看到原集合', () => {
    // 模拟真实时序：多选 [a,b,c]，右键 b
    let selected = ['a.txt', 'b.txt', 'c.txt']
    const onMouseDown = (button: number, name: string): void => {
      if (!isPrimaryPointerButton(button)) return
      selected = [name] // 生产里是 select(replace)，这里用等价效果
    }
    onMouseDown(2, 'b.txt')
    expect(selected).toEqual(['a.txt', 'b.txt', 'c.txt'])
    // 现在 contextmenu 看到的是完整集合 → keep → 菜单按 3 项算（两项）
    expect(contextSelectionFor('b.txt', selected)).toBe('keep')
    expect(menuItemsFor(selected.length).map((item) => item.id)).toEqual(['delete', 'download'])
  })

  it('对照：左键 mousedown 会塌缩选择（说明上面那条不是空转）', () => {
    let selected = ['a.txt', 'b.txt', 'c.txt']
    const onMouseDown = (button: number, name: string): void => {
      if (!isPrimaryPointerButton(button)) return
      selected = [name]
    }
    onMouseDown(0, 'b.txt')
    expect(selected).toEqual(['b.txt'])
  })
})

describe('R5-2 contextSelectionFor：右键未选中行先设为唯一选中，已选中行保持多选', () => {
  const cases: { name: string; clicked: string; selected: string[]; expected: string }[] = [
    { name: '什么都没选 → replace', clicked: 'a.txt', selected: [], expected: 'replace' },
    { name: '右键未选中的行（单选别人的）→ replace', clicked: 'b.txt', selected: ['a.txt'], expected: 'replace' },
    { name: '右键已选中的行（单选）→ keep', clicked: 'a.txt', selected: ['a.txt'], expected: 'keep' },
    { name: '右键已选中的行（多选）→ keep，整批保持', clicked: 'b.txt', selected: ['a.txt', 'b.txt', 'c.txt'], expected: 'keep' },
    { name: '右键未选中的行（当前多选）→ replace', clicked: 'z.txt', selected: ['a.txt', 'b.txt'], expected: 'replace' },
    { name: '名字大小写不同视为不同项 → replace', clicked: 'A.TXT', selected: ['a.txt'], expected: 'replace' },
  ]
  for (const tableCase of cases) {
    it(tableCase.name, () => {
      expect(contextSelectionFor(tableCase.clicked, tableCase.selected)).toBe(tableCase.expected)
    })
  }

  it('选中集合里有同名项时命中前缀不影响判定（不做前缀/包含匹配）', () => {
    // 'a' 是 'ab.txt' 的前缀，但它们是不同的条目
    expect(contextSelectionFor('ab.txt', ['a'])).toBe('replace')
  })
})

describe('R5-2 selectedCountAfterContext：菜单条数与右键后的实际选中数同源', () => {
  it('右键未选中的行 → 变成 1（菜单按单选给三项）', () => {
    expect(selectedCountAfterContext('c.txt', ['a.txt', 'b.txt', 'd.txt'])).toBe(1)
    expect(selectedCountAfterContext('a.txt', [])).toBe(1)
  })

  it('右键已选中的行 → 保持当前数量（多选时按多选给两项）', () => {
    expect(selectedCountAfterContext('b.txt', ['a.txt', 'b.txt', 'c.txt'])).toBe(3)
    expect(selectedCountAfterContext('a.txt', ['a.txt'])).toBe(1)
  })

  it('与 contextSelectionFor 的判定逐例一致（两处不会分叉）', () => {
    const samples: [string, string[]][] = [['a', []], ['a', ['a']], ['a', ['b']], ['a', ['a', 'b']], ['a', ['b', 'c']]]
    for (const [clicked, selected] of samples) {
      const keep = contextSelectionFor(clicked, selected) === 'keep'
      expect(selectedCountAfterContext(clicked, selected), clicked + '|' + selected.join(',')).toBe(
        keep ? selected.length : 1,
      )
    }
  })

  it('菜单项跟着这个数字走：右键未选中行永远拿到三项', () => {
    const count = selectedCountAfterContext('c.txt', ['a.txt', 'b.txt'])
    expect(menuItemsFor(count).map((item) => item.id)).toEqual(['rename', 'delete', 'download'])
  })

  it('菜单项跟着这个数字走：右键已选中的行（多选）拿到两项', () => {
    const count = selectedCountAfterContext('b.txt', ['a.txt', 'b.txt'])
    expect(menuItemsFor(count).map((item) => item.id)).toEqual(['delete', 'download'])
  })
})

describe('R5-2 menuBoxSize：菜单外框尺寸', () => {
  it('单项菜单高 = 一项 + 上下内边距 + 边框', () => {
    // 28 一项 + 8 上下内边距 + 2 边框 = 38
    expect(menuBoxSize(1)).toEqual({ width: MENU_MIN_WIDTH, height: MENU_ITEM_HEIGHT + 8 + 2 })
  })

  it('两项比一项高正好一个行高', () => {
    expect(menuBoxSize(2).height - menuBoxSize(1).height).toBe(MENU_ITEM_HEIGHT)
  })

  it('0 项只剩余内边距与边框（不会出现负高度）', () => {
    expect(menuBoxSize(0).height).toBe(8 + 2)
    expect(menuBoxSize(-3).height).toBe(8 + 2)
  })
})

describe('R5-2 clampMenuPosition：四条边各自的翻转与夹取', () => {
  const viewport = { width: 1000, height: 800 }
  const box = { width: 176, height: 66 }

  it('中间位置放得下 → 原样（右下展开）', () => {
    expect(clampMenuPosition({ x: 400, y: 300, ...box, viewport })).toEqual({ x: 400, y: 300 })
  })

  it('右边缘放不下 → 翻到光标左侧', () => {
    const point = clampMenuPosition({ x: 900, y: 300, ...box, viewport })
    expect(point.x).toBe(900 - 176)
    expect(point.y).toBe(300)
  })

  it('下边缘放不下 → 翻到光标上方', () => {
    const point = clampMenuPosition({ x: 400, y: 780, ...box, viewport })
    expect(point.x).toBe(400)
    expect(point.y).toBe(780 - 66)
  })

  it('右下角同时越界 → 两个轴各自翻转', () => {
    const point = clampMenuPosition({ x: 990, y: 790, ...box, viewport })
    expect(point.x).toBe(990 - 176)
    expect(point.y).toBe(790 - 66)
  })

  it('左边缘：光标比边距还靠左（clientX 可能是 0）→ 夹到左边距', () => {
    expect(clampMenuPosition({ x: 0, y: 300, ...box, viewport }).x).toBe(MENU_VIEWPORT_MARGIN)
    expect(clampMenuPosition({ x: 5, y: 300, ...box, viewport }).x).toBe(MENU_VIEWPORT_MARGIN)
  })

  it('左边缘：窄视口里翻转后仍越界 → 夹回右边（不是贴到光标左侧的负数）', () => {
    // 光标 x=3 在 vw=200 里：右侧 3+176=179 ≤ 192，其实放得下 → 只被左边距夹取到 8
    expect(clampMenuPosition({ x: 3, y: 300, ...box, viewport: { width: 200, height: 800 } }).x).toBe(MENU_VIEWPORT_MARGIN)
    // 光标 x=195：右侧 195+176+8 越界 → 翻到 19，但仍超出右边界 200-8-176=16 → 夹到 16
    expect(clampMenuPosition({ x: 195, y: 300, ...box, viewport: { width: 200, height: 800 } }).x).toBe(16)
  })

  it('上边缘（光标 y 小于边距）→ 夹到上边距', () => {
    const point = clampMenuPosition({ x: 400, y: 0, ...box, viewport })
    expect(point.y).toBe(MENU_VIEWPORT_MARGIN)
  })

  it('菜单比视口还大 → 贴住左上边距（翻转与夹取都无解）', () => {
    const point = clampMenuPosition({
      x: 50,
      y: 50,
      width: 500,
      height: 400,
      viewport: { width: 300, height: 200 },
    })
    expect(point).toEqual({ x: MENU_VIEWPORT_MARGIN, y: MENU_VIEWPORT_MARGIN })
  })

  it('翻转后仍在视口内（不会因为翻到负数而出界）', () => {
    const point = clampMenuPosition({ x: 200, y: 200, width: 400, height: 300, viewport: { width: 500, height: 400 } })
    expect(point.x).toBeGreaterThanOrEqual(MENU_VIEWPORT_MARGIN)
    expect(point.y).toBeGreaterThanOrEqual(MENU_VIEWPORT_MARGIN)
    expect(point.x + 400).toBeLessThanOrEqual(500 - MENU_VIEWPORT_MARGIN + 400)
  })

  it('返回整数（clientX 为小数时不会糊掉 1px 边框）', () => {
    const point = clampMenuPosition({ x: 400.6, y: 300.4, ...box, viewport })
    expect(Number.isInteger(point.x)).toBe(true)
    expect(Number.isInteger(point.y)).toBe(true)
  })

  it('可用 margin 覆盖边距（贴边距离跟着变）', () => {
    const point = clampMenuPosition({ x: 0, y: 0, ...box, viewport, margin: 0 })
    expect(point).toEqual({ x: 0, y: 0 })
  })
})
