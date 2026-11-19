import { describe, it, expect } from 'vitest'
import {
  CANONICAL_USER_STORAGE,
  MAX_NAME_BYTES,
  MAX_PATH_BYTES,
  PROTECTED_REMOTE_PATHS,
  assertSafeRemotePath,
  canonicalRemotePath,
  checkName,
  checkRemotePath,
  isInsideRoot,
  isProtectedRemotePath,
  isProtectedTransferDirectory,
  isProtectedTransferPath,
  isRemoteInside,
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

  /*
   * 【审查 I6】/sdcard/Android 及其两个独立挂载子目录。
   *
   * 真机实测：/storage/emulated/0/Android、.../Android/data、.../Android/obb
   * 都**不是**保护路径，而 /sdcard/Android/data 与 /sdcard 是不同设备号的独立 f2fs 挂载点。
   * 删它等于清掉所有 App 的私有数据（部分不可再生），而界面只会说「非空目录」。
   * 两次点击就能做到 —— 这是必须堵的。
   */
  it.each([
    '/sdcard/Android',
    '/sdcard/Android/data',
    '/sdcard/Android/obb',
    '/storage/emulated/0/Android',
    '/storage/emulated/0/Android/data',
    '/storage/emulated/0/Android/obb',
  ])('%s 受保护（I6：Android 目录是全部应用数据）', (path) => {
    expect(isProtectedRemotePath(path)).toBe(true)
  })

  /*
   * 【审查 M2】/mnt/* 是 /storage 的老别名，指同一批挂载点。
   * 真机上删它们会因权限失败（root 拥有的 symlink），所以不构成绕过；
   * 但错误码会是 E_NO_PERMISSION，文案误导用户去「申请权限」。
   * 补进名单让文案说对人话。
   */
  it.each([
    '/mnt/sdcard',
    '/mnt/user/0/emulated/0',
    '/mnt/runtime/default/emulated/0',
    '/storage/emulated/0',
    '/storage/self/primary',
  ])('%s 受保护（M2：别名与等价路径）', (path) => {
    expect(isProtectedRemotePath(path)).toBe(true)
  })

  it.each([
    '/sdcard/Download',
    '/sdcard/Download/测试 目录',
    '/storage/emulated/0/Download/a.txt',
    '/data/local/tmp/x',
    // Android 下的**普通子目录**不在保护范围：不能因为防 Android 就把整棵树锁死
    '/sdcard/Android/data/com.example.app',
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

describe('裁决 3 / C3：自包含判定（复制到自身子目录会无界递归）', () => {
  it.each([
    ['相等', '/sdcard/A', '/sdcard/A', true],
    ['直接子目录', '/sdcard/A', '/sdcard/A/inner', true],
    ['深子目录', '/sdcard/A', '/sdcard/A/x/y/z', true],
    ['带尾斜杠的子目录', '/sdcard/A', '/sdcard/A/inner/', true],
    ['父目录同名前缀但不相干', '/sdcard/A', '/sdcard/AB', false],
    ['兄弟目录', '/sdcard/A', '/sdcard/B', false],
    ['父目录', '/sdcard/A', '/sdcard', false],
    ['完全不同', '/sdcard/A', '/data/local/tmp/x', false],
    ['根比较', '/', '/sdcard/A', true],
  ])('%s：%s ⊃ %s → %s', (_label, parent, child, expected) => {
    expect(isRemoteInside(parent, child)).toBe(expected)
  })

  it('对含 .. 的输入保守返回 true（宁可拒操作，也不放行一次可能递归的复制）', () => {
    // 这里不是路径校验（那个由 checkRemotePath 负责），而是「复制/移动前的最后一道自包含检查」：
    // 看不懂的输入一律当成「可能自包含」，让它被拒绝而不是被执行。
    expect(isRemoteInside('/sdcard/A', '/sdcard/A/../A/inner')).toBe(true)
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

describe('第 2 轮复审 C3：存储别名归一（/sdcard 与 /storage/emulated/0 是同一目录）', () => {
  it('canonicalRemotePath 把用户存储区别名归一成同一个规范路径', () => {
    expect(CANONICAL_USER_STORAGE).toBe('/storage/emulated/0')
    for (const alias of ['/sdcard', '/storage/self/primary', '/storage/emulated/0', '/mnt/sdcard']) {
      expect(canonicalRemotePath(alias), alias).toBe('/storage/emulated/0')
    }
    expect(canonicalRemotePath('/sdcard/Download/x.txt')).toBe('/storage/emulated/0/Download/x.txt')
    expect(canonicalRemotePath('/mnt/sdcard/DCIM')).toBe('/storage/emulated/0/DCIM')
  })

  it('非别名的系统路径原样返回（不要误伤 /data、/system）', () => {
    expect(canonicalRemotePath('/data/local/tmp')).toBe('/data/local/tmp')
    expect(canonicalRemotePath('/system/bin')).toBe('/system/bin')
    // 前缀相同但不是别名的兄弟目录不能被改写
    expect(canonicalRemotePath('/sdcardx')).toBe('/sdcardx')
    // 【终审 I-6】/storage/emulated/<N>（N 为数字）现在**必须**归一 —— 修前这里断言的
    // 正是反例（emulated/1 原样返回），而那条「反例」恰好就是终审发现的真实盲区：
    // 多用户存储根在三个闸门里全是 false。详见下面 I-6 的专项用例。
    expect(canonicalRemotePath('/storage/emulated/1')).toBe(CANONICAL_USER_STORAGE)
    expect(canonicalRemotePath('/storage/emulated/activity')).toBe('/storage/emulated/activity')
  })

  it('跨别名写到自身子目录 → 判定为自包含（真机实测会无界递归）', () => {
    // 复审实测：2 秒内目录数从 2 涨到 88
    expect(isRemoteInside('/sdcard/A', '/storage/emulated/0/A/inner')).toBe(true)
    expect(isRemoteInside('/storage/emulated/0/A', '/sdcard/A/inner')).toBe(true)
    expect(isRemoteInside('/sdcard/A', '/mnt/sdcard/A/inner')).toBe(true)
    // 别名归一后仍是兄弟目录 → 放行（不能误杀）
    expect(isRemoteInside('/sdcard/A', '/storage/emulated/0/B')).toBe(false)
  })

  it('同一目录的不同别名写法判为相等', () => {
    expect(isRemoteInside('/sdcard/A', '/storage/emulated/0/A')).toBe(true)
    expect(isRemoteInside('/sdcard', '/storage/emulated/0')).toBe(true)
  })
})

/*
 * 【终审 I-6】多用户存储根：/storage/emulated/<N> 必须与 emulated/0 同等对待。
 *
 * 修前实况（终审表格，本机只有 UserInfo{0} 所以没造成现实危害）：
 *   | 路径                                  | isProtectedRemotePath | isProtectedTransferPath | isProtectedTransferDirectory |
 *   | /storage/emulated/1                   | false                 | false                   | true（=可写）                |
 *   | /storage/emulated/1/Android/data       | **false**             | **false**               | true                         |
 * 也就是说只要设备上有工作资料/第二用户，一条 rm -rf 就能清掉该用户全部应用数据。
 *
 * 修法：canonicalRemotePath 在精确别名表之后补一层**模式匹配**
 * （精确名单永远追不上「有用户就有新 N」这一族），归一到 /storage/emulated/0 对应位置。
 * 下面既锁「受保护的仍然受保护」，也锁「普通目录没被误伤」。
 */
describe('终审 I-6：多用户存储根 /storage/emulated/<N> 不得绕过闸门', () => {
  const MULTI_USER = ['/storage/emulated/1', '/storage/emulated/2', '/storage/emulated/10', '/storage/emulated/999']

  it('canonicalRemotePath 把任意 /storage/emulated/<N> 归一到 CANONICAL_USER_STORAGE', () => {
    for (const alias of MULTI_USER) {
      expect(canonicalRemotePath(alias), alias).toBe(CANONICAL_USER_STORAGE)
      expect(canonicalRemotePath(alias + '/Download'), alias).toBe(CANONICAL_USER_STORAGE + '/Download')
      expect(canonicalRemotePath(alias + '/Android/data'), alias)
        .toBe(CANONICAL_USER_STORAGE + '/Android/data')
    }
    // 非数字的兄弟目录不能被误伤
    expect(canonicalRemotePath('/storage/emulated/activity')).toBe('/storage/emulated/activity')
    expect(canonicalRemotePath('/storage/emulated')).toBe('/storage/emulated')
  })

  it('/storage/emulated/1/Android/data 受对象级保护（修前是 false）', () => {
    expect(isProtectedRemotePath('/storage/emulated/1/Android/data')).toBe(true)
    expect(isProtectedRemotePath('/storage/emulated/1/Android')).toBe(true)
    expect(isProtectedRemotePath('/storage/emulated/1/Android/obb')).toBe(true)
    // 各个 N 都一样
    for (const alias of MULTI_USER) {
      for (const suffix of ['', '/Android', '/Android/data', '/Android/obb']) {
        expect(isProtectedRemotePath(alias + suffix), alias + suffix).toBe(true)
      }
    }
  })

  it('/storage/emulated/1/Android/data 受传输通道保护（对象级 + 子树级都 true，修前全 false）', () => {
    expect(isProtectedTransferPath('/storage/emulated/1/Android/data')).toBe(true)
    expect(isProtectedTransferPath('/storage/emulated/1')).toBe(true)
  })

  it('/storage/emulated/1/Download 必须放行（只补保护、不动可用性）', () => {
    expect(isProtectedRemotePath('/storage/emulated/1/Download')).toBe(false)
    expect(isProtectedTransferPath('/storage/emulated/1/Download')).toBe(false)
    expect(isProtectedTransferDirectory('/storage/emulated/1/Download')).toBe(false)
    // 存储根本身可写（首屏默认目录语义），各 N 一致
    for (const alias of MULTI_USER) {
      expect(isProtectedTransferDirectory(alias), alias).toBe(false)
      expect(isProtectedTransferDirectory(alias + '/DCIM'), alias).toBe(false)
    }
  })

  /*
   * 【合并前复审补】/mnt/user/<N>/(primary|emulated/<M>) 同属多用户存储根一族。
   *
   * 复审用探针直调四闸门实测（修前）：/mnt/user/10/primary/Android/data 与
   * /mnt/user/1/emulated/1/Android/data **三个闸门全 false** —— 与 I-6 原状同一类洞，
   * 只是换了别名族；而终审 I-6 的修法建议里点名了这一族。上面 /storage/emulated/<N>
   * 修好之后，这里如果还留着，等于换个前缀就能绕过，保护是假的。
   *
   * 注意 /mnt/user/0/primary 与 /mnt/user/0/emulated/0 早在精确别名表里（N-2 补的），
   * 所以下面刻意只用 **非 0 用户号**，否则测的是精确表而不是新模式。
   */
  it('/mnt/user/<N>/primary 与 /mnt/user/<N>/emulated/<M> 同样归一到存储根', () => {
    expect(canonicalRemotePath('/mnt/user/10/primary')).toBe(CANONICAL_USER_STORAGE)
    expect(canonicalRemotePath('/mnt/user/10/primary/Download')).toBe(CANONICAL_USER_STORAGE + '/Download')
    expect(canonicalRemotePath('/mnt/user/1/emulated/1')).toBe(CANONICAL_USER_STORAGE)
    expect(canonicalRemotePath('/mnt/user/1/emulated/1/Android/data'))
      .toBe(CANONICAL_USER_STORAGE + '/Android/data')
    // 不误伤：非数字用户号、以及 emulated 后面不是数字的老写法都原样保留
    expect(canonicalRemotePath('/mnt/user')).toBe('/mnt/user')
    expect(canonicalRemotePath('/mnt/user/primary')).toBe('/mnt/user/primary')
    expect(canonicalRemotePath('/mnt/user/10/emulated/primary')).toBe('/mnt/user/10/emulated/primary')
  })

  it('/mnt/user/10/primary/Android/data 受保护（修前三闸门全 false）', () => {
    for (const path of [
      '/mnt/user/10/primary/Android/data',
      '/mnt/user/10/primary/Android/obb',
      '/mnt/user/1/emulated/1/Android/data',
    ]) {
      expect(isProtectedRemotePath(path), path).toBe(true)
      expect(isProtectedTransferPath(path), path).toBe(true)
      expect(isProtectedTransferDirectory(path), path).toBe(true)
    }
  })

  it('/mnt/user/10/primary/Download 必须放行（只补保护、不动可用性）', () => {
    for (const path of ['/mnt/user/10/primary/Download', '/mnt/user/1/emulated/1/Download']) {
      expect(isProtectedRemotePath(path), path).toBe(false)
      expect(isProtectedTransferPath(path), path).toBe(false)
      expect(isProtectedTransferDirectory(path), path).toBe(false)
    }
  })

  it('多用户路径参与自包含判定（别名归一后与 emulated/0 同源）', () => {
    // 同一台设备的两个用户目录是**不同**的存储区，不能互相判成自包含
    expect(isRemoteInside('/storage/emulated/0/A', '/storage/emulated/1/A/inner')).toBe(true)
    // 注意：归一后 1 与 0 指向同一规范路径，因此跨用户会被保守判为「在里面」——
    // 这是**安全侧**的保守（宁可拒绝，不可放行无界递归）。
    expect(isRemoteInside('/storage/emulated/1/A', '/storage/emulated/1/A/inner')).toBe(true)
  })
})

describe('第 2 轮复审 N2 / N3：目标目录的可写判定', () => {
  it('用户存储根与其子目录可写（首屏默认目录就是 /sdcard）', () => {
    for (const dir of ['/sdcard', '/storage/emulated/0', '/storage/self/primary', '/sdcard/Download', '/sdcard/DCIM']) {
      expect(isProtectedTransferDirectory(dir), dir).toBe(false)
    }
  })

  it('设备根与挂载点容器不可写（N3：/ 必须拒）', () => {
    for (const dir of ['/', '/storage', '/mnt']) {
      expect(isProtectedTransferDirectory(dir), dir).toBe(true)
    }
  })

  it('系统区子树不可写（C2 绕过的来源侧同一条判据）', () => {
    for (const dir of ['/data', '/data/local/tmp', '/system', '/system/bin', '/vendor/lib', '/proc']) {
      expect(isProtectedTransferDirectory(dir), dir).toBe(true)
    }
  })

  it('受保护的存储子目录不可写，但其下的具体 App 目录可写', () => {
    expect(isProtectedTransferDirectory('/sdcard/Android')).toBe(true)
    expect(isProtectedTransferDirectory('/storage/emulated/0/Android')).toBe(true)
    expect(isProtectedTransferDirectory('/sdcard/Android/data/com.example.app')).toBe(false)
  })
})

/*
 * 【第 3 轮复审 N-2】对象级保护（isProtectedRemotePath）必须穿得透存储别名。
 *
 * 修前 isProtectedRemotePath 只做 normalizeSegments（纯词法折叠），于是同一个目录
 * 换个别名写法就绕过保护 —— 复审实测 6 种写法里 4 种漏网，服务层直接发出
 * `rm -rf -- '/mnt/sdcard/Android/data'`。真机上这些写法是**同一批 inode**
 * （stat 设备号/inode 全同 64780:2643），删它等于清掉全部 App 的数据库与扩展包。
 *
 * 这里用表驱动锁死「别名 × 受保护后代」= 18 个组合全 true，再反向锁住
 * 「别名下的普通目录」必须 false —— 只堵绕过、不误伤用户目录。
 */
describe('第 3 轮复审 N-2：受保护后代不能被存储别名绕过', () => {
  const ALIASES = [
    '/sdcard',
    '/storage/self/primary',
    '/storage/emulated/0',
    '/mnt/sdcard',
    '/mnt/user/0/primary',
    '/mnt/user/0/emulated/0',
    '/mnt/runtime/default/emulated/0',
  ]

  it('别名表覆盖全部已知写法（含 N-2 漏掉的 /mnt/user/0/primary）', () => {
    expect(ALIASES).toHaveLength(7)
    for (const alias of ALIASES) {
      expect(canonicalRemotePath(alias), alias).toBe(CANONICAL_USER_STORAGE)
      // 别名自身是受保护的存储根
      expect(isProtectedRemotePath(alias), alias).toBe(true)
    }
  })

  it.each(ALIASES.flatMap((alias) => [alias + '/Android', alias + '/Android/data', alias + '/Android/obb']))(
    '%s 受保护（别名不得绕过对象级保护）',
    (path) => {
      expect(isProtectedRemotePath(path)).toBe(true)
    },
  )

  it.each(ALIASES.flatMap((alias) => [
    alias + '/Download',
    alias + '/DCIM/a.jpg',
    // Android 下的具体 App 目录必须放行：用户要能管理单个 App 的文件
    alias + '/Android/data/com.example.app',
  ]))('%s 不受保护（只堵绕过，不误伤用户目录）', (path) => {
    expect(isProtectedRemotePath(path)).toBe(false)
  })

  it('传输通道判据同样穿得透别名（isProtectedTransferPath 复用同一个谓词）', () => {
    // 这两条已经由其它用例覆盖，这里只确认别名形态与正名形态结论一致
    for (const alias of ALIASES) {
      expect(isProtectedTransferPath(alias + '/Android/data'), alias).toBe(true)
      expect(isProtectedTransferPath(alias + '/Download'), alias).toBe(false)
    }
  })
})
