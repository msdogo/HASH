import { describe, it, expect } from 'vitest'
import {
  MAX_NAME_BYTES,
  MAX_PATH_BYTES,
  PROTECTED_REMOTE_PATHS,
  assertSafeRemotePath,
  checkName,
  checkRemotePath,
  isInsideRoot,
  isProtectedRemotePath,
  normalizeLocalPath,
  remoteBaseName,
  remoteJoin,
  remoteParent,
} from '../src/shared/path-guard'

/*
 * 裁决 2：所有路径操作必须过同一个校验函数。
 *
 * 这里是那道闸门的表驱动证据：至少 10 个用例覆盖「空 / 根 / 重复斜杠 / .. 逃逸 /
 * \0 / 尾随空格 / 超长 / 中文 / 单引号 / ; 注入」。
 *
 * 注意两类「看起来像注入但其实合法」的输入（单引号、;、$()）：
 * 它们是**合法文件名**，在设备上真实存在完全可能（裁决 9 的真机用例就是
 * `测试 目录'1'`）。所以这里必须**接受**，安全性由 shellQuote 在命令构造处保证 ——
 * 「路径校验」负责的是一次路径的语义正确，不是转义。
 */

interface Case {
  label: string
  input: string
  expect: 'ok' | 'reject'
  /** 接受时的归一化结果。 */
  normalized?: string
}

const CASES: Case[] = [
  { label: '空串', input: '', expect: 'reject' },
  { label: '纯空白', input: '   ', expect: 'reject' },
  { label: '只有根', input: '/', expect: 'reject' },
  { label: '双斜杠根', input: '//', expect: 'reject' },
  { label: '含 NUL', input: '/sdcard/a\u0000b', expect: 'reject' },
  { label: '含换行', input: '/sdcard/a\nb', expect: 'reject' },
  { label: '含回车', input: '/sdcard/a\rb', expect: 'reject' },
  { label: '相对路径（未归一化）', input: 'sdcard/Download', expect: 'reject' },
  { label: '相对点路径', input: './sdcard', expect: 'reject' },
  { label: '.. 逃出根', input: '/a/../..', expect: 'reject' },
  { label: '.. 出现在任意位置', input: '/sdcard/Download/../DCIM', expect: 'reject' },
  { label: '尾随空格', input: '/sdcard/测试 ', expect: 'reject' },
  { label: '前导空格', input: ' /sdcard/x', expect: 'reject' },
  { label: '超长整体', input: '/' + 'a'.repeat(MAX_PATH_BYTES + 10), expect: 'reject' },
  { label: '单个名字超长', input: '/sdcard/' + 'a'.repeat(MAX_NAME_BYTES + 1), expect: 'reject' },
  { label: '中文与空格', input: '/sdcard/Download/测试 目录', expect: 'ok', normalized: '/sdcard/Download/测试 目录' },
  { label: '单引号', input: "/sdcard/Download/测试 目录'1'", expect: 'ok', normalized: "/sdcard/Download/测试 目录'1'" },
  // 分号是合法文件名字符（转义后就是字面量）；含它的路径必须能通过语义校验
  { label: '; 注入串', input: '/sdcard/evil;touch pwned', expect: 'ok', normalized: '/sdcard/evil;touch pwned' },
  // 但「段尾带空格」一律拒（ls 里看不出来的不可见差异）
  { label: '段尾空格的注入串', input: '/sdcard/x;rm -rf /data', expect: 'reject' },
  { label: '命令替换', input: '/sdcard/$(reboot)', expect: 'ok', normalized: '/sdcard/$(reboot)' },
  { label: '重复斜杠归一', input: '/sdcard//Download/', expect: 'ok', normalized: '/sdcard/Download' },
  { label: '点段归一', input: '/sdcard/./Download', expect: 'ok', normalized: '/sdcard/Download' },
]

describe('裁决 2：assertSafeRemotePath 表驱动（20 例）', () => {
  it('用例数量足够（至少 10 个）', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(10)
  })

  it.each(CASES)('$label → $expect', (item: Case) => {
    const verdict = checkRemotePath(item.input)
    if (item.expect === 'reject') {
      expect(verdict.ok, item.input).toBe(false)
      // 拒绝时必须给出可翻译的错误码，不能只有布尔
      if (!verdict.ok) expect(verdict.code).toMatch(/^E_/)
      expect(() => assertSafeRemotePath(item.input)).toThrow()
      return
    }
    expect(verdict.ok, item.input).toBe(true)
    if (verdict.ok) expect(verdict.path).toBe(item.normalized ?? item.input)
    expect(assertSafeRemotePath(item.input)).toBe(item.normalized ?? item.input)
  })

  it('拒绝码区分「非法路径」与「越界路径」', () => {
    expect(checkRemotePath('/sdcard/a\u0000b')).toEqual({ ok: false, code: 'E_INVALID_PATH' })
    expect(checkRemotePath('relative/x')).toEqual({ ok: false, code: 'E_INVALID_PATH' })
    expect(checkRemotePath('/sdcard/../..')).toEqual({ ok: false, code: 'E_PATH_UNSAFE' })
    expect(checkRemotePath('/')).toEqual({ ok: false, code: 'E_INVALID_PATH' })
  })
})

describe('名字（单段）校验', () => {
  it.each([
    ['空', '', false],
    ['点', '.', false],
    ['双点', '..', false],
    ['含斜杠', 'a/b', false],
    ['含反斜杠', 'a\\b', false],
    ['含换行', 'a\nb', false],
    ['前导空格', ' a', false],
    ['尾随空格', 'a ', false],
    ['超长', 'a'.repeat(MAX_NAME_BYTES + 1), false],
    ['普通名', '测试.txt', true],
    ['含空格', '我的 照片.jpg', true],
    ['含单引号', "测试 目录'1'", true],
    ['含分号', 'a;b', true],
  ])('%s', (_label, input, ok) => {
    expect(checkName(input).ok).toBe(ok)
  })

  it('接受时原样返回名字（不做任何改写）', () => {
    expect(checkName("测试 目录'1'")).toEqual({ ok: true, name: "测试 目录'1'" })
  })
})

describe('裁决 1：根路径白名单式保护', () => {
  it.each([
    '/',
    '/sdcard',
    '/storage',
    '/storage/emulated',
    '/storage/emulated/0',
    '/storage/self/primary',
    '/mnt',
    '/mnt/user/0/primary',
    '/system',
    '/data',
    '/vendor',
    '/proc',
    '/sys',
  ])('%s 受保护（不许删/移/改名）', (path) => {
    expect(isProtectedRemotePath(path)).toBe(true)
  })

  it.each([
    '/sdcard/Download',
    '/sdcard/Download/测试 目录',
    '/storage/emulated/0/Download/a.txt',
    '/data/local/tmp/x',
  ])('%s 不在保护名单内', (path) => {
    expect(isProtectedRemotePath(path)).toBe(false)
  })

  it('保护名单本身都是归一化后的绝对路径（没有尾斜杠 / .. 残留）', () => {
    for (const path of PROTECTED_REMOTE_PATHS) {
      expect(path.startsWith('/')).toBe(true)
      expect(path === '/' || !path.endsWith('/')).toBe(true)
      expect(path).not.toContain('..')
    }
  })
})

describe('远程路径运算', () => {
  it('remoteParent / remoteBaseName / remoteJoin', () => {
    expect(remoteParent('/sdcard/Download')).toBe('/sdcard')
    expect(remoteParent('/sdcard')).toBe('/')
    expect(remoteParent('/')).toBe(null)
    expect(remoteBaseName('/sdcard/a.txt')).toBe('a.txt')
    expect(remoteBaseName('/sdcard/测试 目录')).toBe('测试 目录')
    expect(remoteJoin('/sdcard', 'a.txt')).toBe('/sdcard/a.txt')
    expect(remoteJoin('/sdcard/', 'a.txt')).toBe('/sdcard/a.txt')
    expect(remoteJoin('/', 'a.txt')).toBe('/a.txt')
  })
})

describe('裁决 5：本地路径必须落在用户选定根目录内', () => {
  it('normalizeLocalPath 归一化分隔符与 ..（词法层面）', () => {
    // 归一化结果是【比较形态】：统一正斜杠、去尾分隔符（显示用真实路径，不用它）
    expect(normalizeLocalPath('C:\\Users\\me\\a\\..\\b')).toBe('C:/Users/me/b')
    expect(normalizeLocalPath('/home/me/a/../b')).toBe('/home/me/b')
    expect(normalizeLocalPath('C:\\Users\\me\\')).toBe('C:/Users/me')
  })

  it.each([
    ['常规子路径', 'C:\\Users\\me', 'C:\\Users\\me\\docs\\a.txt', true],
    ['根自身', 'C:\\Users\\me', 'C:\\Users\\me', true],
    ['大小写不同（Windows）', 'C:\\Users\\Me', 'c:\\users\\me\\a.txt', true],
    ['前缀相同的兄弟目录', 'C:\\Users\\me', 'C:\\Users\\me2\\a.txt', false],
    ['.. 逃逸', 'C:\\Users\\me', 'C:\\Users\\me\\..\\..\\Windows', false],
    ['完全在外部', 'C:\\Users\\me', 'D:\\etc\\passwd', false],
    ['POSIX 根', '/', '/etc/passwd', true],
    ['POSIX 子路径', '/home/me', '/home/me/a/b', true],
    ['POSIX 外部', '/home/me', '/home/other', false],
    ['POSIX .. 逃逸', '/home/me', '/home/me/../../etc', false],
  ])('%s', (_label, root, target, inside) => {
    expect(isInsideRoot(root, target)).toBe(inside)
  })

  it('根目录本身为 / 时一切都算在内（但仍要防 .. 逃逸到根之外）', () => {
    expect(isInsideRoot('/', '/')).toBe(true)
    expect(isInsideRoot('/', '/..')).toBe(true) // 根之上仍是根（POSIX 语义）
  })
})
