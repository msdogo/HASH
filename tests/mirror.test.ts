import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MAX_SIZE,
  HEADER_HEIGHT,
  MAX_SIZE_OPTIONS,
  SCRCPY_WINDOW_PREFIX,
  SIDEBAR_WIDTH,
  availableRect,
  buildScrcpyArgs,
  classifyScrcpyFailure,
  fitRect,
  mirrorTitleOf,
  needsRaise,
  parseScrcpyExtraArgs,
  SCRCPY_RESERVED_DISPLAY,
  windowFitSize,
} from '../src/shared/mirror'

describe('buildScrcpyArgs', () => {
  it('必须带 -s serial（与 adb 同一条红线）', () => {
    const args = buildScrcpyArgs({ serial: 'ABC123', token: 't1', maxSize: DEFAULT_MAX_SIZE })
    expect(args.slice(0, 2)).toEqual(['-s', 'ABC123'])
  })

  it('无边框 + 唯一标题前缀', () => {
    const args = buildScrcpyArgs({ serial: 'ABC123', token: 't1', maxSize: DEFAULT_MAX_SIZE })
    expect(args).toContain('--window-borderless')
    expect(args).toContain('--window-title=' + SCRCPY_WINDOW_PREFIX + 't1')
  })

  it('不带 --render-driver（spike 证明默认 d3d11 够用，少一个变量）', () => {
    const args = buildScrcpyArgs({ serial: 'ABC123', token: 't1', maxSize: DEFAULT_MAX_SIZE })
    expect(args.some((a) => a.startsWith('--render-driver'))).toBe(false)
  })

  it('带 --no-audio', () => {
    const args = buildScrcpyArgs({ serial: 'ABC123', token: 't1', maxSize: DEFAULT_MAX_SIZE })
    expect(args).toContain('--no-audio')
  })

  it('maxSize 拼进 --max-size', () => {
    const args = buildScrcpyArgs({ serial: 'ABC123', token: 't1', maxSize: 720 })
    expect(args).toContain('--max-size=720')
  })

  it('无线设备序列号（含冒号）原样传递', () => {
    const args = buildScrcpyArgs({ serial: '192.168.1.7:5555', token: 't2', maxSize: 1280 })
    expect(args.slice(0, 2)).toEqual(['-s', '192.168.1.7:5555'])
    expect(args).toContain('--max-size=1280')
  })

  it('两个 token 不同则标题不同（多设备互不认错）', () => {
    const a = buildScrcpyArgs({ serial: 'S1', token: 'aaa', maxSize: DEFAULT_MAX_SIZE })
    const b = buildScrcpyArgs({ serial: 'S2', token: 'bbb', maxSize: DEFAULT_MAX_SIZE })
    expect(a).not.toEqual(b)
    expect(a).toContain('--window-title=' + SCRCPY_WINDOW_PREFIX + 'aaa')
    expect(b).toContain('--window-title=' + SCRCPY_WINDOW_PREFIX + 'bbb')
  })
})

describe('mirrorTitleOf', () => {
  it('有型号用型号 + serial 后 4 位', () => {
    expect(mirrorTitleOf({ serial: '9N9CN2G0012A3P', model: 'DJI RC Plus 2' })).toBe('DJI RC Plus 2 (2A3P)')
  })

  it('无型号回退「设备」', () => {
    expect(mirrorTitleOf({ serial: '9N9CN2G0012A3P' })).toBe('设备 (2A3P)')
  })

  it('空字符串型号也回退（不显示空括号前缀）', () => {
    expect(mirrorTitleOf({ serial: 'ABCD1234', model: '' })).toBe('设备 (1234)')
  })
})

describe('classifyScrcpyFailure', () => {
  it('认不出设备 → E_DEVICE_OFFLINE', () => {
    expect(classifyScrcpyFailure('ERROR: Could not find any ADB device')).toBe('E_DEVICE_OFFLINE')
  })

  it('ADB 设备找不到（带 serial 的变体）→ E_DEVICE_OFFLINE', () => {
    expect(classifyScrcpyFailure('ERROR: Could not find ADB device 9N9CN2G0012A3P')).toBe('E_DEVICE_OFFLINE')
  })

  it('adb server 起不来 → E_SCRCPY_NO_ADB', () => {
    expect(classifyScrcpyFailure('ERROR: Could not start adb server')).toBe('E_SCRCPY_NO_ADB')
  })

  it('Command not found: [adb] → E_SCRCPY_NO_ADB', () => {
    expect(
      classifyScrcpyFailure("ERROR: Command not found: [/e/AI/x/adb.exe], [start-server]"),
    ).toBe('E_SCRCPY_NO_ADB')
  })

  it('其余 → E_MIRROR_START_FAILED', () => {
    expect(classifyScrcpyFailure('something odd happened')).toBe('E_MIRROR_START_FAILED')
  })

  it('空串 → E_MIRROR_START_FAILED（不抛）', () => {
    expect(classifyScrcpyFailure('')).toBe('E_MIRROR_START_FAILED')
  })
})

describe('availableRect', () => {
  it('扣掉顶栏（上）与右侧侧边栏', () => {
    const r = availableRect({ width: 480, height: 900 }, 1)
    expect(r.x).toBe(0)
    expect(r.y).toBe(HEADER_HEIGHT)
    expect(r.width).toBe(480 - SIDEBAR_WIDTH)
    expect(r.height).toBe(900 - HEADER_HEIGHT)
  })

  it('scaleFactor 2 时全部翻倍（MoveWindow 要物理像素）', () => {
    const r = availableRect({ width: 480, height: 900 }, 2)
    expect(r.y).toBe(HEADER_HEIGHT * 2)
    expect(r.width).toBe(960 - SIDEBAR_WIDTH * 2)
    expect(r.height).toBe(1800 - HEADER_HEIGHT * 2)
  })

  it('scaleFactor 非法（0 / 负数）时按 1 处理，不产生负尺寸', () => {
    for (const bad of [0, -1, Number.NaN]) {
      const r = availableRect({ width: 400, height: 400 }, bad)
      expect(r.width).toBeGreaterThan(0)
      expect(r.height).toBeGreaterThan(0)
    }
  })

  it('窗口比侧边栏还窄时宽度夹到 0（不出现负数）', () => {
    const r = availableRect({ width: 40, height: 100 }, 1)
    expect(r.width).toBe(0)
  })
})

describe('fitRect', () => {
  it('横屏视频放进竖长区域 → 撑满宽度、上下留黑边、垂直居中', () => {
    const r = fitRect({ x: 0, y: 36, width: 368, height: 864 }, 1024, 640)
    expect(r.width).toBe(368)
    expect(r.height).toBe(Math.round(640 * (368 / 1024)))
    // 垂直居中：上下剩余相等
    const topGap = r.y - 36
    const bottomGap = 36 + 864 - (r.y + r.height)
    expect(Math.abs(topGap - bottomGap)).toBeLessThanOrEqual(1)
  })

  it('竖屏视频放进宽区域 → 撑满高度、左右留黑边、水平居中', () => {
    const r = fitRect({ x: 0, y: 0, width: 1000, height: 500 }, 500, 1000)
    expect(r.height).toBe(500)
    expect(r.width).toBe(250)
    expect(r.x).toBe(Math.floor((1000 - 250) / 2))
  })

  it('宽高比一致时不产生黑边（铺满可用区域）', () => {
    const r = fitRect({ x: 10, y: 20, width: 400, height: 200 }, 400, 200)
    expect(r).toEqual({ x: 10, y: 20, width: 400, height: 200 })
  })

  it('视频尺寸未知（0）→ 回落到铺满，不产生 NaN', () => {
    const area = { x: 0, y: 0, width: 100, height: 80 }
    expect(fitRect(area, 0, 640)).toEqual(area)
    expect(fitRect(area, 1024, 0)).toEqual(area)
  })

  it('可用区域为 0 → 回退原值，不抛', () => {
    const area = { x: 0, y: 0, width: 0, height: 0 }
    expect(fitRect(area, 1024, 640)).toEqual(area)
  })

  it('结果永远不超出可用区域', () => {
    for (const [vw, vh] of [[1024, 640], [640, 1024], [1920, 1080], [100, 300]]) {
      const area = { x: 5, y: 7, width: 400, height: 900 }
      const r = fitRect(area, vw, vh)
      expect(r.width).toBeLessThanOrEqual(area.width)
      expect(r.height).toBeLessThanOrEqual(area.height)
      expect(r.x).toBeGreaterThanOrEqual(area.x)
      expect(r.y).toBeGreaterThanOrEqual(area.y)
    }
  })
})

describe('windowFitSize', () => {
  it('窗口刚好装下 16:10 画面：宽 = 视频宽 + 侧边栏，高 = 视频高 + 顶栏', () => {
    const size = windowFitSize(1024, 640, 1, 2000)
    expect(size.width).toBe(1024 + SIDEBAR_WIDTH)
    expect(size.height).toBe(640 + HEADER_HEIGHT)
  })

  it('scaleFactor 2 时视频尺寸减半（DIP 更小），但侧边栏/顶栏不缩', () => {
    const size = windowFitSize(1024, 640, 2, 2000)
    expect(size.width).toBe(512 + SIDEBAR_WIDTH)
    expect(size.height).toBe(320 + HEADER_HEIGHT)
  })

  it('超过 maxHeight 时按比例缩，不拉伸画面', () => {
    const size = windowFitSize(1024, 1024, 1, 500)
    expect(size.height).toBe(500)
    // 等比：宽高比与视频一致（差异只来自取整与固定减项）
    expect(size.width).toBeLessThan(1024 + SIDEBAR_WIDTH)
  })

  it('视频未知（0）→ 给可用的默认尺寸，不是 0×0', () => {
    const size = windowFitSize(0, 0, 1)
    expect(size.width).toBeGreaterThan(SIDEBAR_WIDTH)
    expect(size.height).toBeGreaterThan(HEADER_HEIGHT)
  })

  it('极窄视频也不会把窗口压到放不下六个键', () => {
    const size = windowFitSize(40, 400, 1, 2000)
    expect(size.width).toBeGreaterThanOrEqual(SIDEBAR_WIDTH + 120)
  })

  it('永远不返回负尺寸或 NaN', () => {
    for (const [w, h, s] of [[1024, 640, 1], [0, 640, 1], [1024, 640, 0], [-5, -5, -1]]) {
      const size = windowFitSize(w, h, s)
      expect(Number.isFinite(size.width)).toBe(true)
      expect(size.width).toBeGreaterThan(0)
      expect(size.height).toBeGreaterThan(0)
    }
  })
})

describe('MAX_SIZE_OPTIONS', () => {
  it('含默认值', () => {
    expect(MAX_SIZE_OPTIONS).toContain(DEFAULT_MAX_SIZE)
  })

  it('全部为正整数且递增', () => {
    for (let i = 0; i < MAX_SIZE_OPTIONS.length; i++) {
      expect(Number.isInteger(MAX_SIZE_OPTIONS[i])).toBe(true)
      expect(MAX_SIZE_OPTIONS[i]).toBeGreaterThan(0)
      if (i > 0) expect(MAX_SIZE_OPTIONS[i]).toBeGreaterThan(MAX_SIZE_OPTIONS[i - 1])
    }
  })
})

describe('自定义 scrcpy 参数：追加与切分', () => {
  it('extraArgs 追加在固定参数**之后**（我们的参数优先，不被用户值顶掉）', () => {
    const args = buildScrcpyArgs({
      serial: 'ABC123',
      token: 't1',
      maxSize: 1024,
      extraArgs: ['--turn-screen-off', '--show-touches'],
    })
    expect(args.slice(-2)).toEqual(['--turn-screen-off', '--show-touches'])
    // 固定参数仍在原位：-s serial 必须是开头两个
    expect(args.slice(0, 2)).toEqual(['-s', 'ABC123'])
    expect(args.indexOf('--max-size=1024')).toBeLessThan(args.indexOf('--turn-screen-off'))
  })

  it('不给 extraArgs 时参数与修前完全一致（不多出空串参数）', () => {
    const withoutExtra = buildScrcpyArgs({ serial: 'ABC123', token: 't1', maxSize: 1024 })
    const withEmpty = buildScrcpyArgs({ serial: 'ABC123', token: 't1', maxSize: 1024, extraArgs: [] })
    expect(withoutExtra).toEqual(withEmpty)
    expect(withoutExtra).not.toContain('')
  })

  it('空串 / 纯空白 → 零个参数', () => {
    expect(parseScrcpyExtraArgs('').args).toEqual([])
    expect(parseScrcpyExtraArgs('   \t  ').args).toEqual([])
  })

  it('按空白切分多个参数', () => {
    expect(parseScrcpyExtraArgs('--turn-screen-off  --show-touches').args).toEqual([
      '--turn-screen-off',
      '--show-touches',
    ])
  })

  it('成对引号里的空格不切断参数', () => {
    expect(parseScrcpyExtraArgs('--crop="100:200:300:400" --x=1').args).toEqual([
      '--crop=100:200:300:400',
      '--x=1',
    ])
    expect(parseScrcpyExtraArgs("--record 'C:/a b/c.mp4'").args).toEqual(['--record', 'C:/a b/c.mp4'])
  })

  it('未闭合的引号按「到结尾都是值」处理（不吞掉用户写的东西）', () => {
    expect(parseScrcpyExtraArgs('--record "C:/a b').args).toEqual(['--record', 'C:/a b'])
  })
})

describe('自定义 scrcpy 参数：红线参数被拒绝', () => {
  it('-s / --serial 被拒绝（否则会投到别的设备上）', () => {
    const a = parseScrcpyExtraArgs('-s OTHERDEV')
    expect(a.args).toEqual([])
    expect(a.ignored).toEqual(['-s', 'OTHERDEV'])
    const b = parseScrcpyExtraArgs('--serial=OTHERDEV')
    expect(b.args).toEqual([])
    expect(b.ignored).toEqual(['--serial=OTHERDEV'])
  })

  it('带值保留项的**值**也被吃掉（否则游离参数会被 scrcpy 当成设备序列号）', () => {
    // 这是修前的真实缺陷：只丢 -s，OTHERDEV 会作为位置参数传给 scrcpy = 绕过红线
    const r = parseScrcpyExtraArgs('-s OTHERDEV --show-touches')
    expect(r.args).toEqual(['--show-touches'])
    expect(r.ignored).toEqual(['-s', 'OTHERDEV'])
  })

  it('紧随开关后面的参数不被连坐（--window-borderless 不吃值）', () => {
    const r = parseScrcpyExtraArgs('--window-borderless --show-touches')
    expect(r.args).toEqual(['--show-touches'])
    expect(r.ignored).toEqual(['--window-borderless'])
  })

  it('下一个 token 是另一个开关时不吞（--max-size --show-touches）', () => {
    const r = parseScrcpyExtraArgs('--max-size --show-touches')
    expect(r.args).toEqual(['--show-touches'])
    expect(r.ignored).toEqual(['--max-size'])
  })

  it('--window-title / --window-borderless 被拒绝（嵌入靠它们定位窗口）', () => {
    const r = parseScrcpyExtraArgs('--window-title=hack --window-borderless')
    expect(r.args).toEqual([])
    expect(r.ignored).toEqual(['--window-title=hack', '--window-borderless'])
  })

  it('--max-size 两种写法都被拒绝（窗口初始尺寸按 1024 预计算）', () => {
    expect(parseScrcpyExtraArgs('--max-size=720').ignored).toEqual(['--max-size=720'])
    // 空格写法会连同值一起被吃掉，不留一个游离的 '720'
    expect(parseScrcpyExtraArgs('--max-size 720').ignored).toEqual(['--max-size', '720'])
  })

  it('被拒的只剔除自己，其余参数照常保留', () => {
    const r = parseScrcpyExtraArgs('--turn-screen-off --max-size=720 --show-touches')
    expect(r.args).toEqual(['--turn-screen-off', '--show-touches'])
    expect(r.ignored).toEqual(['--max-size=720'])
  })

  it('大小写与多余横线也能认出来（--Max-Size / ---serial）', () => {
    expect(parseScrcpyExtraArgs('--Max-Size=720').ignored).toHaveLength(1)
    expect(parseScrcpyExtraArgs('---serial').ignored).toHaveLength(1)
  })

  it('长得像但不相关的参数不被误杀（--stay-awake / -S）', () => {
    expect(parseScrcpyExtraArgs('--stay-awake --show-touches').args).toEqual([
      '--stay-awake',
      '--show-touches',
    ])
    // 大小写归一化：-S 落到保留项 s 上，一并拒掉（宁可多拒，也不赌 scrcpy 版本行为）
    expect(parseScrcpyExtraArgs('-S').ignored).toEqual(['-S'])
  })

  it('界面用的清单与判定表覆盖同一组参数（有条目、不重复）', () => {
    expect(SCRCPY_RESERVED_DISPLAY.length).toBe(4)
    expect(new Set(SCRCPY_RESERVED_DISPLAY).size).toBe(SCRCPY_RESERVED_DISPLAY.length)
  })
})

/**
 * z 序判定（第五个实机缺陷）。
 *
 * 症状：投屏成功后一会儿鼠标点不动，画面却正常。
 * 成因：宿主 resize 时 Chromium 把渲染子窗口插回 z 序最顶，把 scrcpy 压下去；
 * 被压住的窗口画面照样合成，鼠标事件却全被渲染层吃掉。
 *
 * 这里锁的是「什么时候要动手」：动手太频繁会抖，不动手就点不动。
 */
describe('needsRaise', () => {
  it('scrcpy 已在最顶层 → 不动手（否则每 500ms 抖一次）', () => {
    expect(needsRaise([100, 200], 100)).toBe(false)
  })

  it('scrcpy 被渲染层压到下面 → 必须动手', () => {
    expect(needsRaise([200, 100], 100)).toBe(true)
  })

  it('scrcpy 排在第三个也要动手（中间多几个兄弟窗口同理）', () => {
    expect(needsRaise([200, 300, 100], 100)).toBe(true)
  })

  it('列表为空（还没挂上 / 枚举失败）→ 不动手', () => {
    expect(needsRaise([], 100)).toBe(false)
  })

  it('列表里没有 scrcpy（已被销毁）→ 不动手', () => {
    expect(needsRaise([200, 300], 100)).toBe(false)
  })

  it('句柄是 0 → 不动手（SetWindowPos 对 0 必然失败，不要白调一次）', () => {
    expect(needsRaise([200], 0)).toBe(false)
    expect(needsRaise([], 0)).toBe(false)
  })

  it('只有一个子窗口且就是它 → 不动手', () => {
    expect(needsRaise([100], 100)).toBe(false)
  })
})
