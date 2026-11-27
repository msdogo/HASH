import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSettingsStore, SETTINGS_FILE_NAME } from '../electron/settings/store'
import { DEFAULT_SCRCPY_ARGS } from '../src/shared/mirror'
import { E_INVALID_PATH, E_NOT_FOUND } from '../src/shared/errors'

/*
 * R2-2：默认下载路径的**真读写**持久化（不是源码文本断言）。
 *
 * 三条硬要求（来自简报）：
 *   1. 写 → 重建 store → 读回：值必须一致，且磁盘上真的有一个 settings.json；
 *   2. 坏值降级有测试：坏 JSON / 非绝对路径 / 不存在的目录 → 读回默认值且不崩；
 *   3. electron-store 必须是注入式设计：本文件在纯 node 下 import（没有 Electron），
 *      全部存储都落在 mkdtemp 出来的真实临时目录里。
 *
 * 为什么这些断言必须有真实文件系统：'写进去了' 与 '读得回来' 之间隔着序列化、
 * 原子改名、schema 清理三层，任何一层坏掉都只在真盘上才看得见。
 */

/** 每个用例一个独立的存储目录 + 一个独立的「默认下载目录」（都是真实路径）。 */
let storeDir = ''
let defaultDir = ''
let customDir = ''
const warnings: string[] = []

function open(over: { defaultDownloadDir?: string } = {}) {
  return createSettingsStore({
    filePath: storeDir,
    defaultDownloadDir: over.defaultDownloadDir ?? defaultDir,
    // 「投屏参数」默认值：与生产同一个常量，这样「没设过 → 读到默认值」可证
    defaultScrcpyArgs: DEFAULT_SCRCPY_ARGS,
    warn: (message) => { warnings.push(message) },
  })
}

/** 直接往存储文件里写一段原始内容（模拟被外部编辑 / 旧版本写坏）。 */
function writeRaw(content: string): void {
  writeFileSync(path.join(storeDir, SETTINGS_FILE_NAME + '.json'), content, 'utf8')
}

/** 读磁盘上的存储文件内容（证明「真的落盘了」，而不是只在内存里）。 */
function readRaw(): string {
  return readFileSync(path.join(storeDir, SETTINGS_FILE_NAME + '.json'), 'utf8')
}

beforeEach(() => {
  storeDir = mkdtempSync(path.join(tmpdir(), 'adbfm-settings-'))
  defaultDir = mkdtempSync(path.join(tmpdir(), 'adbfm-dl-default-'))
  customDir = mkdtempSync(path.join(tmpdir(), 'adbfm-dl-custom-'))
  warnings.length = 0
})

afterEach(() => {
  for (const dir of [storeDir, defaultDir, customDir]) {
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
  }
})

describe('自定义 scrcpy 参数：持久化与坏值降级', () => {
  it('首次启动读到**默认参数**（不是空串：默认那行要出现在输入框里）', () => {
    expect(open().getScrcpyArgs()).toBe(DEFAULT_SCRCPY_ARGS)
    expect(open().getScrcpyArgs()).not.toBe('')
  })

  it('默认参数就是 --no-mouse-hover（用户第一次打开设置就能看到它）', () => {
    expect(DEFAULT_SCRCPY_ARGS).toBe('--no-mouse-hover')
  })

  it('用户把它删掉存空串 → 读回空串，不会被默认值顶回去', () => {
    const store = open()
    store.setScrcpyArgs('')
    // 关键区别：「没设过」→ 默认值；「显式存了空串」→ 空串
    expect(open().getScrcpyArgs()).toBe('')
  })

  it('resetScrcpyArgs 写回默认值（删掉之后能一键拿回来）', () => {
    const store = open()
    store.setScrcpyArgs('')
    expect(store.getScrcpyArgs()).toBe('')
    expect(store.resetScrcpyArgs()).toBe(DEFAULT_SCRCPY_ARGS)
    expect(open().getScrcpyArgs()).toBe(DEFAULT_SCRCPY_ARGS)
  })

  it('坏值（数字）降级成**默认值**，不是空串', () => {
    writeRaw(JSON.stringify({ scrcpyArgs: 123 }))
    expect(open().getScrcpyArgs()).toBe(DEFAULT_SCRCPY_ARGS)
  })

  it('写 → 重建 store → 读回（值真的落盘了）', () => {
    const first = open()
    first.setScrcpyArgs('--turn-screen-off --show-touches')
    const parsed: unknown = JSON.parse(readRaw())
    expect(parsed).toMatchObject({ scrcpyArgs: '--turn-screen-off --show-touches' })

    expect(open().getScrcpyArgs()).toBe('--turn-screen-off --show-touches')
  })

  it('写入时 trim（首尾空白不落盘）', () => {
    const store = open()
    expect(store.setScrcpyArgs('  --show-touches  ')).toBe('--show-touches')
    expect(open().getScrcpyArgs()).toBe('--show-touches')
  })

  it('空串合法：显式清空后读到空串（不会回退到默认参数）', () => {
    const store = open()
    store.setScrcpyArgs('--show-touches')
    store.setScrcpyArgs('')
    expect(open().getScrcpyArgs()).toBe('')
  })

  it('整个文件是坏 JSON → 读默认值，不崩', () => {
    writeRaw('{ not json')
    expect(open().getScrcpyArgs()).toBe(DEFAULT_SCRCPY_ARGS)
  })

  it('与其它设置项互不干扰（写参数不动 downloadDir）', () => {
    const store = open()
    store.setDownloadDir(customDir)
    store.setScrcpyArgs('--show-touches')
    const reopened = open()
    expect(reopened.getDownloadDir()).toBe(customDir)
    expect(reopened.getScrcpyArgs()).toBe('--show-touches')
  })
})

describe('R2-2 持久化：写 → 重建 store → 读回', () => {
  it('set 之后落盘，重建一个全新 store 仍读到同一个值', () => {
    const first = open()
    // 首次启动没有存储文件：读到的必须是系统「下载」目录，而不是空串
    expect(first.getDownloadDir()).toBe(defaultDir)

    first.setDownloadDir(customDir)

    // 1) 磁盘上真的有文件，且**解析出来的值**就是刚写的路径（不是「文本里出现过」）
    expect(existsSync(first.storagePath())).toBe(true)
    const parsed: unknown = JSON.parse(readRaw())
    expect(parsed).toMatchObject({ downloadDir: customDir })

    // 2) 重建（模拟重启应用）：读到必须一致 —— 这才是「持久化」的定义
    const second = open()
    expect(second.getDownloadDir()).toBe(customDir)
  })

  it('写入时会去掉首尾空白（用户从资源管理器复制路径常带空格）', () => {
    const store = open()
    expect(store.setDownloadDir('  ' + customDir + '  ')).toBe(customDir)
    expect(open().getDownloadDir()).toBe(customDir)
  })

  it('恢复默认：写回系统下载目录，重建后仍是默认值', () => {
    const store = open()
    store.setDownloadDir(customDir)
    expect(open().getDownloadDir()).toBe(customDir)

    expect(store.resetDownloadDir()).toBe(defaultDir)
    expect(open().getDownloadDir()).toBe(defaultDir)
    expect(store.getDefaultDownloadDir()).toBe(defaultDir)
  })

  it('从没设置过时返回默认值，且不产生任何告警（「没设置」不是坏值）', () => {
    expect(open().getDownloadDir()).toBe(defaultDir)
    expect(warnings).toEqual([])
  })
})

describe('R2-2 坏值降级：坏 JSON / 非绝对路径 / 不存在的目录', () => {
  it('整个文件是坏 JSON：读回默认值，不抛异常', () => {
    writeRaw('{ this is not json')
    const store = open()
    expect(() => store.getDownloadDir()).not.toThrow()
    expect(store.getDownloadDir()).toBe(defaultDir)
  })

  it('坏 JSON 之后仍能写入（降级不是把存储永久弄坏）', () => {
    writeRaw('{ this is not json')
    const store = open()
    expect(store.setDownloadDir(customDir)).toBe(customDir)
    // 重建再读：文件已被重写成合法 JSON
    expect(open().getDownloadDir()).toBe(customDir)
  })

  it('非绝对路径（相对路径）→ 退默认值，并记录一次告警', () => {
    writeRaw(JSON.stringify({ downloadDir: 'Downloads/adbfm' }))
    const store = open()
    expect(store.getDownloadDir()).toBe(defaultDir)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Downloads/adbfm')
  })

  /*
   * 【变异验证的针对性】这一条用「相对路径但**当前工作目录下真实存在**」的样本
   * （仓库根下的 src 目录），所以它只能被「绝对路径校验」抓住：
   * 若把 isAbsolutePath 那一路去掉、只留「目录是否存在」，这里会读回 'src'
   * 而不是默认值 —— 两条校验各自都有独立的用例，不是一条兜另一条。
   */
  it('相对路径即使当前目录下真实存在，也必须退默认值（绝对路径校验单独生效）', () => {
    expect(existsSync('src')).toBe(true) // 前提自证：这个相对路径在本仓库里确实存在
    writeRaw(JSON.stringify({ downloadDir: 'src' }))
    expect(open().getDownloadDir()).toBe(defaultDir)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('src')
  })

  it('盘符相对写法（C:foo）也按非绝对路径处理', () => {
    writeRaw(JSON.stringify({ downloadDir: 'C:adbfm' }))
    expect(open().getDownloadDir()).toBe(defaultDir)
    expect(warnings).toHaveLength(1)
  })

  it('空串 → 退默认值（空串不是「用默认」的合法存储形态）', () => {
    writeRaw(JSON.stringify({ downloadDir: '' }))
    expect(open().getDownloadDir()).toBe(defaultDir)
    expect(warnings).toHaveLength(1)
  })

  it('绝对路径但目录已被删除 → 退默认值并告警', () => {
    const gone = mkdtempSync(path.join(tmpdir(), 'adbfm-dl-gone-'))
    rmSync(gone, { recursive: true, force: true })
    writeRaw(JSON.stringify({ downloadDir: gone }))
    expect(open().getDownloadDir()).toBe(defaultDir)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(gone)
  })

  it('绝对路径但指向的是一个文件 → 退默认值（不是目录就不能当下载目录）', () => {
    const file = path.join(storeDir, 'not-a-dir.txt')
    writeFileSync(file, 'x', 'utf8')
    writeRaw(JSON.stringify({ downloadDir: file }))
    expect(open().getDownloadDir()).toBe(defaultDir)
    expect(warnings).toHaveLength(1)
  })

  it('类型错的值（数字）被 schema 清掉 → 退默认值，且每次读都稳定', () => {
    writeRaw(JSON.stringify({ downloadDir: 123 }))
    const store = open()
    expect(store.getDownloadDir()).toBe(defaultDir)
    // 读多次必须稳定：降级不能是「第一次读崩、第二次读正常」
    expect(store.getDownloadDir()).toBe(defaultDir)
    expect(open().getDownloadDir()).toBe(defaultDir)
  })

  it('同一条坏值只告警一次（避免每次读设置都刷日志）', () => {
    writeRaw(JSON.stringify({ downloadDir: 'relative/dir' }))
    const store = open()
    store.getDownloadDir()
    store.getDownloadDir()
    store.getDownloadDir()
    expect(warnings).toHaveLength(1)
  })
})

describe('R2-2 写入校验：非法值必须抛错（不能假装写成功）', () => {
  it('非绝对路径 → E_INVALID_PATH，且磁盘上什么都没写', () => {
    const store = open()
    expect(() => store.setDownloadDir('relative/dir')).toThrow(E_INVALID_PATH)
    expect(existsSync(store.storagePath())).toBe(false)
    expect(open().getDownloadDir()).toBe(defaultDir)
  })

  it('目录不存在 → E_NOT_FOUND', () => {
    const store = open()
    const missing = path.join(storeDir, 'nope')
    expect(() => store.setDownloadDir(missing)).toThrow(E_NOT_FOUND)
  })

  it('空串 → E_INVALID_PATH（想回默认请走 resetDownloadDir）', () => {
    const store = open()
    expect(() => store.setDownloadDir('')).toThrow(E_INVALID_PATH)
  })

  it('校验失败后已存的值不受影响', () => {
    const store = open()
    store.setDownloadDir(customDir)
    expect(() => store.setDownloadDir('relative/dir')).toThrow(E_INVALID_PATH)
    expect(open().getDownloadDir()).toBe(customDir)
  })
})

describe('R2-2 注入式设计：存储位置由调用方决定', () => {
  it('两个不同 filePath 的 store 互不干扰（生产每个用户目录一份）', () => {
    const other = mkdtempSync(path.join(tmpdir(), 'adbfm-settings-other-'))
    try {
      const a = createSettingsStore({ filePath: storeDir, defaultDownloadDir: defaultDir, defaultScrcpyArgs: DEFAULT_SCRCPY_ARGS, warn: () => undefined })
      const b = createSettingsStore({ filePath: other, defaultDownloadDir: defaultDir, defaultScrcpyArgs: DEFAULT_SCRCPY_ARGS, warn: () => undefined })
      a.setDownloadDir(customDir)
      expect(a.getDownloadDir()).toBe(customDir)
      expect(b.getDownloadDir()).toBe(defaultDir)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('filePath 下有子目录且目录还不存在时也能用（首次启动的 userData 就是这样）', () => {
    const nested = path.join(storeDir, 'nested', 'deep')
    // 前提自证：构造之前这些目录确实不存在（否则这条用例是空转）
    expect(existsSync(nested)).toBe(false)
    const store = createSettingsStore({ filePath: nested, defaultDownloadDir: defaultDir, defaultScrcpyArgs: DEFAULT_SCRCPY_ARGS, warn: () => undefined })
    expect(store.setDownloadDir(customDir)).toBe(customDir)
    // electron-store 会自建目录：写完必须真的在 nested 下留了文件
    expect(existsSync(nested)).toBe(true)
    expect(store.storagePath().startsWith(nested)).toBe(true)
    expect(open().getDownloadDir()).toBe(defaultDir)
  })

  it('存储文件名固定为 settings.json（报告与排查要能对上）', () => {
    const store = open()
    store.setDownloadDir(customDir)
    expect(path.basename(store.storagePath())).toBe('settings.json')
    mkdirSync(storeDir, { recursive: true })
    expect(existsSync(path.join(storeDir, 'settings.json'))).toBe(true)
  })
})

/*
 * ============ R9：按设备序列号记住上次停留的目录 ============
 *
 * 与 R2-2 同一套证明标准：**真读写**（写 → 重建 store → 读回），不是源码文本断言。
 * 设备目录记录最怕两种坏法，两种都在这里钉住：
 *   1. 写不进去（重建后读回 undefined）；
 *   2. 一台设备的记录污染另一台（读回串味）。
 *
 * 有一条**刻意没测**：「目录在设备上是否还存在」。那要发 adb，是渲染层的职责
 * （见 src/shared/cwd-memo.ts 的 resolveRestoreCwd）。存储层只碰本机设置文件。
 */
describe('R9 设备目录记忆：写 → 重建 store → 读回', () => {
  it('写一台设备 → 落盘 → 重建后读回同一个值', () => {
    const first = open()
    expect(first.getDeviceCwd('SERIAL-A')).toBeUndefined()

    first.setDeviceCwd('SERIAL-A', '/sdcard/DCIM')

    // 磁盘上真的写进去了（解析出来的值就是它，不是「文本里出现过」）
    const parsed: unknown = JSON.parse(readRaw())
    expect(parsed).toMatchObject({ deviceCwds: { 'SERIAL-A': '/sdcard/DCIM' } })

    // 重建（模拟重启应用）：这才是「记住」的定义
    expect(open().getDeviceCwd('SERIAL-A')).toBe('/sdcard/DCIM')
  })

  it('多设备互不污染：写 A 与 B，各自读回自己的目录', () => {
    const store = open()
    store.setDeviceCwd('SERIAL-A', '/sdcard/DCIM')
    store.setDeviceCwd('SERIAL-B', '/sdcard/Download')

    const reloaded = open()
    expect(reloaded.getDeviceCwd('SERIAL-A')).toBe('/sdcard/DCIM')
    expect(reloaded.getDeviceCwd('SERIAL-B')).toBe('/sdcard/Download')
    // 第三台没写过：必须是没有记录，不能借到别人的
    expect(reloaded.getDeviceCwd('SERIAL-C')).toBeUndefined()
  })

  it('同一 serial 覆盖写入 → 读到最新值，且不影响其它设备', () => {
    const store = open()
    store.setDeviceCwd('SERIAL-A', '/sdcard/DCIM')
    store.setDeviceCwd('SERIAL-B', '/sdcard/Download')
    store.setDeviceCwd('SERIAL-A', '/sdcard/Movies')

    const reloaded = open()
    expect(reloaded.getDeviceCwd('SERIAL-A')).toBe('/sdcard/Movies')
    expect(reloaded.getDeviceCwd('SERIAL-B')).toBe('/sdcard/Download')
  })

  it('不设数量上限（用户裁决）：写 40 台设备，全部记得住', () => {
    const store = open()
    for (let i = 0; i < 40; i++) store.setDeviceCwd('SERIAL-' + i, '/sdcard/dir' + i)

    const reloaded = open()
    for (let i = 0; i < 40; i++) expect(reloaded.getDeviceCwd('SERIAL-' + i), String(i)).toBe('/sdcard/dir' + i)
  })

  it('写入时去掉首尾空白', () => {
    const store = open()
    store.setDeviceCwd('  SERIAL-A  ', '  /sdcard/DCIM  ')
    const reloaded = open()
    expect(reloaded.getDeviceCwd('SERIAL-A')).toBe('/sdcard/DCIM')
    expect(reloaded.getDeviceCwd('  SERIAL-A  ')).toBe('/sdcard/DCIM')
  })

  it('与下载路径共存：写设备目录不影响 downloadDir，反之亦然', () => {
    const store = open()
    store.setDownloadDir(customDir)
    store.setDeviceCwd('SERIAL-A', '/sdcard/DCIM')
    store.setDeviceCwd('SERIAL-A', '/sdcard/Movies')

    const reloaded = open()
    expect(reloaded.getDownloadDir()).toBe(customDir)
    expect(reloaded.getDeviceCwd('SERIAL-A')).toBe('/sdcard/Movies')
  })
})

describe('R9 设备目录记忆：坏值与拒绝写入（不抛、不降级成垃圾记录）', () => {
  it('相对路径记录 → 读回 undefined，并只告警一次', () => {
    writeRaw(JSON.stringify({ deviceCwds: { 'SERIAL-A': 'sdcard/DCIM' } }))
    const store = open()
    expect(store.getDeviceCwd('SERIAL-A')).toBeUndefined()
    expect(store.getDeviceCwd('SERIAL-A')).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('SERIAL-A')
  })

  it('空串记录 → 读回 undefined（不当成「停在根目录」）', () => {
    writeRaw(JSON.stringify({ deviceCwds: { 'SERIAL-A': '' } }))
    expect(open().getDeviceCwd('SERIAL-A')).toBeUndefined()
  })

  it('非字符串记录（数字 / null / 对象）→ 读回 undefined，不抛', () => {
    for (const bad of [123, null, { dir: '/sdcard' }, ['/sdcard']]) {
      warnings.length = 0
      writeRaw(JSON.stringify({ deviceCwds: { 'SERIAL-A': bad } }))
      const store = open()
      expect(() => store.getDeviceCwd('SERIAL-A')).not.toThrow()
      expect(store.getDeviceCwd('SERIAL-A'), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('整个 deviceCwds 不是对象（字符串 / 数组）→ 读回 undefined，不抛', () => {
    for (const bad of ['nope', 42, ['/sdcard'], null]) {
      warnings.length = 0
      writeRaw(JSON.stringify({ deviceCwds: bad }))
      const store = open()
      expect(() => store.getDeviceCwd('SERIAL-A')).not.toThrow()
      expect(store.getDeviceCwd('SERIAL-A'), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('整个文件是坏 JSON → 设备目录读回 undefined，不抛（其它设置也照旧降级）', () => {
    writeRaw('{ this is not json')
    const store = open()
    expect(() => store.getDeviceCwd('SERIAL-A')).not.toThrow()
    expect(store.getDeviceCwd('SERIAL-A')).toBeUndefined()
    expect(store.getDownloadDir()).toBe(defaultDir)
  })

  it('坏值之后仍能写入（降级不是把存储永久弄坏）', () => {
    writeRaw(JSON.stringify({ deviceCwds: { 'SERIAL-A': 'relative/bad' } }))
    const store = open()
    store.setDeviceCwd('SERIAL-A', '/sdcard/DCIM')
    expect(open().getDeviceCwd('SERIAL-A')).toBe('/sdcard/DCIM')
  })

  it('空 serial → 拒绝写入（设备没序列号时不该产生垃圾键）', () => {
    const store = open()
    store.setDeviceCwd('', '/sdcard/DCIM')
    store.setDeviceCwd('   ', '/sdcard/DCIM')
    /*
     * 拒绝得彻底：整个存储文件都还没有（一次真实写入都没发生）。
     * 若实现改成「写一个空表」，这里会红 —— 那也是垃圾写入（首次连设备就产生 settings.json）。
     */
    expect(existsSync(path.join(storeDir, SETTINGS_FILE_NAME + '.json'))).toBe(false)
    // 紧接着一次**合法**写入仍然照常工作（拒绝不是把写入通道堵死）
    store.setDeviceCwd('SERIAL-A', '/sdcard/DCIM')
    expect(open().getDeviceCwd('SERIAL-A')).toBe('/sdcard/DCIM')
    const raw = JSON.parse(readRaw()) as { deviceCwds?: Record<string, string> }
    expect(Object.keys(raw.deviceCwds ?? {})).toEqual(['SERIAL-A'])
  })

  it('空 cwd / 非绝对路径 cwd → 拒绝写入，已有记录保持不变', () => {
    const store = open()
    store.setDeviceCwd('SERIAL-A', '/sdcard/DCIM')
    store.setDeviceCwd('SERIAL-A', '   ')
    store.setDeviceCwd('SERIAL-A', 'sdcard/Download')

    expect(open().getDeviceCwd('SERIAL-A')).toBe('/sdcard/DCIM')
  })

  it('拒绝写入只 warn，不抛（写盘失败不该影响浏览）', () => {
    const store = open()
    expect(() => store.setDeviceCwd('', '/sdcard/DCIM')).not.toThrow()
    expect(() => store.setDeviceCwd('SERIAL-A', '')).not.toThrow()
    expect(() => store.setDeviceCwd('SERIAL-A', 'not/absolute')).not.toThrow()
  })

  it('没写过任何设备时读任意 serial 都是 undefined，且不产生告警（「没记过」不是坏值）', () => {
    const store = open()
    expect(store.getDeviceCwd('SERIAL-A')).toBeUndefined()
    expect(warnings).toEqual([])
  })
})

