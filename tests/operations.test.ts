import { describe, it, expect } from 'vitest'
import { shellQuote } from '../electron/adb/shellsafe'
import {
  E_ALREADY_EXISTS,
  E_CROSS_DEVICE,
  E_INTO_SELF,
  E_OP_FAILED,
  E_OP_PARTIAL,
  E_PATH_UNSAFE,
  E_PROTECTED_PATH,
  RemoteOps,
  opsCopyCommand,
  opsIfExistsCommand,
  opsMkdirCommand,
  opsMoveCommand,
  opsRemoveCommand,
  type OpsRunner,
} from '../electron/fs/operations'

/*
 * 任务 9 裁决 1 / 2 / 3：远程文件操作。
 *
 * 分两层测：
 *   1. **命令构造**（纯函数）—— 转义、-- 分隔符、受保护路径、含 .. 的路径；
 *   2. **编排**（有状态的假文件系统）—— 目标已存在必须拒绝且原文件不变、
 *      移动失败时原文件还在、删除前 stat、符号链接只删链接本身。
 *
 * 为什么假文件系统要**有状态**：只匹配命令文本的假 adb 无法回答「原文件还在吗」，
 * 而裁决 3 的核心要求恰恰是「失败不能毁原文件」。所以这里让假 fs 真的执行
 * mkdir / mv -n / cp -a / rm 的语义，再断言操作前后的目录内容。
 */

type Kind = 'file' | 'dir' | 'link'

const KIND_TEXT: Record<Kind, string> = {
  file: 'regular file',
  dir: 'directory',
  link: 'symbolic link',
}

interface FakeOptions {
  /** 注入故障：mv 返回 0 但其实没动（模拟工具链退化/半完成）。 */
  mvSilentlyDoesNothing?: boolean
  /** 注入故障：cp 返回 1。 */
  cpFails?: boolean
}

function fakeFs(initial: Record<string, Kind>, options: FakeOptions = {}): {
  client: OpsRunner
  commands: string[]
  tree: () => Record<string, Kind>
  has: (path: string) => boolean
  /** 每个前缀根对应的设备号（用于 I4 的跨 FS 判定）。缺省全部同一设备。 */
  devices: Map<string, number>
  /** 注入「rm 删掉 n 项后失败」（用于 I5 的部分成功）。 */
  failRemoveAfterDeleting: (n: number) => void
} {
  const nodes = new Map<string, Kind>(Object.entries(initial))
  const commands: string[] = []
  /** 前缀 → 设备号；没命中的按 1 处理（同一设备）。 */
  const devices = new Map<string, number>()
  /** 注入「rm 删掉 n 项后返回失败」（I5 部分成功）。 */
  let partialRemove: number | null = null
  let partialDeleted = 0

  const deviceOf = (path: string): number => {
    let best: { prefix: string; dev: number } | undefined
    for (const [prefix, dev] of devices) {
      if (path === prefix || path.startsWith(prefix + '/')) {
        if (best === undefined || prefix.length > best.prefix.length) best = { prefix, dev }
      }
    }
    return best?.dev ?? 1
  }

  const children = (dir: string): string[] => {
    const prefix = dir === '/' ? '/' : dir + '/'
    const out: string[] = []
    for (const path of nodes.keys()) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      if (rest === '' || rest.includes('/')) continue
      out.push(rest)
    }
    return out.sort()
  }

  /** 解析 shellQuote 出来的单词（本用例里的路径不含内嵌单引号以外的情况）。 */
  const unquote = (token: string): string => {
    if (!token.startsWith("'") || !token.endsWith("'")) return token
    return token.slice(1, -1).split("'\"'\"'").join("'")
  }

  const argv = (cmd: string): string[] => {
    // 极简分词：只支持单引号包裹的单词（我们的命令构造只用这种形式）
    const out: string[] = []
    let i = 0
    let current = ''
    let quoted = false
    let has = false
    while (i < cmd.length) {
      const ch = cmd[i]
      if (ch === "'") { quoted = !quoted; current += ch; has = true; i++; continue }
      if (ch === ' ' && !quoted) {
        if (has) { out.push(current); current = ''; has = false }
        i++
        continue
      }
      current += ch
      has = true
      i++
    }
    if (has) out.push(current)
    return out.map(unquote)
  }

  const client: OpsRunner = {
    serial: 'FAKE',
    run: async (args: string[]) => {
      if (args[0] !== 'shell' || args.length !== 2) throw new Error('unexpected argv: ' + JSON.stringify(args))
      const cmd = args[1]
      commands.push(cmd)
      const tokens = argv(cmd)
      const is = (index: number, value: string): boolean => tokens[index] === value

      // stat -c %d（设备号，I4 用）与 stat -c %F（类型）都要支持
      if (is(0, 'stat') && is(1, '-c') && tokens[2] === '%d') {
        const devPath = tokens[4]
        if (!nodes.has(devPath)) return { code: 1, stdout: '', stderr: 'stat: No such file or directory' }
        return { code: 0, stdout: String(deviceOf(devPath)) + String.fromCharCode(10), stderr: '' }
      }

      if (is(0, 'stat') && is(1, '-c') && tokens[3] === '--') {
        const path = tokens[4]
        const kind = nodes.get(path)
        if (kind === undefined) return { code: 1, stdout: '', stderr: 'stat: No such file or directory' }
        return { code: 0, stdout: KIND_TEXT[kind] + '\n', stderr: '' }
      }

      if (is(0, 'mkdir')) {
        const path = tokens[2]
        if (nodes.has(path)) return { code: 1, stdout: '', stderr: 'mkdir: File exists' }
        const parent = path.slice(0, path.lastIndexOf('/')) || '/'
        if (parent !== '/' && nodes.get(parent) !== 'dir') {
          return { code: 1, stdout: '', stderr: 'mkdir: No such file or directory' }
        }
        nodes.set(path, 'dir')
        return { code: 0, stdout: '', stderr: '' }
      }

      if (is(0, 'mv')) {
        const from = tokens[3]
        const to = tokens[4]
        const kind = nodes.get(from)
        if (kind === undefined) return { code: 1, stdout: '', stderr: 'mv: No such file or directory' }
        // GNU/toybox 的 -n 语义：目标已存在时**静默成功但不做任何事**（这正是必须自己前置检查的原因）
        if (nodes.has(to)) return { code: 0, stdout: '', stderr: '' }
        if (options.mvSilentlyDoesNothing === true) return { code: 0, stdout: '', stderr: '' }
        nodes.delete(from)
        nodes.set(to, kind)
        return { code: 0, stdout: '', stderr: '' }
      }

      if (is(0, 'cp')) {
        if (options.cpFails === true) return { code: 1, stdout: '', stderr: 'cp: failed' }
        const from = tokens[3]
        const to = tokens[4]
        const kind = nodes.get(from)
        if (kind === undefined) return { code: 1, stdout: '', stderr: 'cp: No such file or directory' }
        nodes.set(to, kind)
        return { code: 0, stdout: '', stderr: '' }
      }

      if (is(0, 'rm')) {
        const recursive = tokens[1].includes('r')
        const path = tokens[3]
        const kind = nodes.get(path)
        if (kind === undefined) return { code: 0, stdout: '', stderr: '' }
        // rm 不跟随操作数上的符号链接：删的是链接本身
        if (kind === 'dir' && !recursive) {
          return { code: 1, stdout: '', stderr: 'rm: Is a directory' }
        }
        /*
         * I5 的注入口：先真删 n 个子项，再返回失败。
         * 这精确复刻真机行为（父目录含 chmod 500 子目录时 rm -rf 返回 1，
         * 但前面那些已经删掉了）—— 「失败」不等于「什么都没发生」。
         */
        if (partialRemove !== null && kind === 'dir') {
          const kids = children(path)
          const limit = Math.min(partialRemove, kids.length)
          for (let i = 0; i < limit; i++) removeTree(path + '/' + kids[i])
          partialDeleted = limit
          const failed = kids.slice(limit)
          return {
            code: 1,
            stdout: '',
            stderr: failed.length === 0
              ? 'rm: cannot remove: Permission denied'
              : "rm: cannot remove '" + failed[0] + "': Permission denied",
          }
        }
        if (kind === 'dir') {
          for (const child of children(path)) removeTree(path + '/' + child)
        }
        nodes.delete(path)
        return { code: 0, stdout: '', stderr: '' }
      }

      if (is(0, 'LC_ALL=C') && is(1, 'ls') && tokens[3] === '--') {
        const dir = tokens[4].replace(/\/$/, '') || '/'
        if (nodes.get(dir) !== 'dir') return { code: 1, stdout: '', stderr: 'ls: No such file or directory' }
        const names = children(dir)
        return { code: 0, stdout: names.length === 0 ? '' : names.join('\n') + '\n', stderr: '' }
      }

      return { code: 127, stdout: '', stderr: 'fake: unsupported: ' + cmd }
    },
  }

  const removeTree = (path: string): void => {
    for (const child of children(path)) removeTree(path + '/' + child)
    nodes.delete(path)
  }

  return {
    client,
    commands,
    tree: () => Object.fromEntries([...nodes.entries()].sort()),
    has: (path) => nodes.has(path),
    devices,
    failRemoveAfterDeleting: (n: number) => { partialRemove = n; partialDeleted = 0 },
  }
}

const ADB = 'C:/platform-tools/adb.exe'

describe('命令构造：转义与分隔符', () => {
  it('mkdir 用 -- 分隔符并转义名字（中文 / 空格 / 单引号）', () => {
    expect(opsMkdirCommand('/sdcard/Download/测试 目录')).toBe("mkdir -- '/sdcard/Download/测试 目录'")
    expect(opsMkdirCommand("/sdcard/Download/测试 目录'1'")).toBe(
      "mkdir -- '/sdcard/Download/测试 目录'\"'\"'1'\"'\"''",
    )
  })

  it('rename / move / copy 都走 -- 且两个操作数分别转义', () => {
    expect(opsMoveCommand('/sdcard/a b.txt', '/sdcard/c d.txt')).toBe("mv -n -- '/sdcard/a b.txt' '/sdcard/c d.txt'")
    expect(opsCopyCommand('/sdcard/a b.txt', '/sdcard/c d.txt')).toBe("cp -a -- '/sdcard/a b.txt' '/sdcard/c d.txt'")
  })

  it('mv 带 -n（不覆盖）：目标已存在时绝不替换，这是「不毁原文件」的第一道闸门', () => {
    expect(opsMoveCommand('/a/b', '/a/c')).toContain('mv -n -- ')
  })

  it('删除用 rm -rf --（递归）或 rm -f --（不递归）', () => {
    expect(opsRemoveCommand('/sdcard/Download/x', true)).toBe("rm -rf -- '/sdcard/Download/x'")
    expect(opsRemoveCommand('/sdcard/Download/x', false)).toBe("rm -f -- '/sdcard/Download/x'")
  })

  it('stat 用 %F 拿类型（区分目录 / 普通文件 / 符号链接）', () => {
    expect(opsIfExistsCommand('/sdcard/Download/x')).toBe("stat -c %F -- '/sdcard/Download/x'")
  })

  it('含 NUL / 换行的路径在构造阶段就抛错（不会被拼进命令）', () => {
    expect(() => opsMkdirCommand('/sdcard/a\nb')).toThrow()
    expect(() => opsRemoveCommand('/sdcard/a' + String.fromCharCode(0) + 'b', true)).toThrow()
  })

  it('受保护根路径拒绝删除 / 移动 / 改名（裁决 1）', () => {
    for (const path of ['/', '/sdcard', '/storage/emulated/0', '/system', '/data']) {
      expect(() => opsRemoveCommand(path, true)).toThrow(E_PROTECTED_PATH)
    }
    expect(() => opsMoveCommand('/sdcard', '/sdcard/x')).toThrow(E_PROTECTED_PATH)
    expect(() => opsMoveCommand('/sdcard/a', '/sdcard')).toThrow(E_PROTECTED_PATH)
  })

  it('含 .. 的路径拒绝（裁决 2：目标路径统一走 assertSafeRemotePath）', () => {
    expect(() => opsRemoveCommand('/sdcard/../../system', true)).toThrow(E_PATH_UNSAFE)
    expect(() => opsMkdirCommand('/sdcard/../x')).toThrow(E_PATH_UNSAFE)
  })
})

describe('新建目录', () => {
  it('目标不存在 → 执行 mkdir 并成功', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/Download': 'dir' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.mkdir('/sdcard/Download', '新目录')).toEqual({ ok: true })
    expect(fs.has('/sdcard/Download/新目录')).toBe(true)
    expect(fs.commands[0]).toBe("stat -c %F -- '/sdcard/Download/新目录'")
    expect(fs.commands[1]).toBe("mkdir -- '/sdcard/Download/新目录'")
  })

  it('目标已存在 → E_ALREADY_EXISTS，且不执行 mkdir', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/Download': 'dir', '/sdcard/Download/已有': 'dir' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.mkdir('/sdcard/Download', '已有')).toEqual({ ok: false, code: E_ALREADY_EXISTS })
    expect(fs.commands).toHaveLength(1)
  })

  it('名字非法（含斜杠）→ 在发命令之前就拒绝', async () => {
    const fs = fakeFs({ '/sdcard': 'dir' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect((await ops.mkdir('/sdcard', 'a/b')).ok).toBe(false)
    expect(fs.commands).toHaveLength(0)
  })
})

describe('裁决 3：重命名 / 移动是原子语义', () => {
  it('目标已存在 → 拒绝（不覆盖），且原文件不动（一条 mv 都没发）', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/a.txt': 'file', '/sdcard/b.txt': 'file' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.move('/sdcard/a.txt', '/sdcard/b.txt')).toEqual({ ok: false, code: E_ALREADY_EXISTS })
    expect(fs.commands.some((c) => c.startsWith('mv '))).toBe(false)
    // 原文件与目标文件都原封不动
    expect(fs.has('/sdcard/a.txt')).toBe(true)
    expect(fs.has('/sdcard/b.txt')).toBe(true)
  })

  it('源不存在 → E_NOT_FOUND，不发 mv', async () => {
    const fs = fakeFs({ '/sdcard': 'dir' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.move('/sdcard/gone.txt', '/sdcard/x.txt')).toEqual({ ok: false, code: 'E_NOT_FOUND' })
    expect(fs.commands.some((c) => c.startsWith('mv '))).toBe(false)
  })

  it('移动成功 → 源消失、目标出现', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/a.txt': 'file', '/sdcard/Download': 'dir' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.move('/sdcard/a.txt', '/sdcard/Download/a.txt')).toEqual({ ok: true })
    expect(fs.has('/sdcard/a.txt')).toBe(false)
    expect(fs.has('/sdcard/Download/a.txt')).toBe(true)
  })

  it('mv 返回 0 但其实没动（工具链退化）→ E_OP_FAILED，原文件仍在', async () => {
    const fs = fakeFs(
      { '/sdcard': 'dir', '/sdcard/a.txt': 'file', '/sdcard/Download': 'dir' },
      { mvSilentlyDoesNothing: true },
    )
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.move('/sdcard/a.txt', '/sdcard/Download/a.txt')).toEqual({ ok: false, code: E_OP_FAILED })
    expect(fs.has('/sdcard/a.txt')).toBe(true)
    expect(fs.has('/sdcard/Download/a.txt')).toBe(false)
    // 全程没有任何 rm：失败路径绝不删源文件
    expect(fs.commands.some((c) => c.startsWith('rm '))).toBe(false)
  })

  it('rename 只改名字：新名字里不允许出现斜杠', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/a.txt': 'file' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect((await ops.rename('/sdcard/a.txt', 'x/y')).ok).toBe(false)
    expect(await ops.rename('/sdcard/a.txt', 'b.txt')).toEqual({ ok: true })
    expect(fs.has('/sdcard/b.txt')).toBe(true)
    expect(fs.has('/sdcard/a.txt')).toBe(false)
  })

  it('rename 到已存在的名字 → 拒绝且两个文件都还在', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/a.txt': 'file', '/sdcard/b.txt': 'file' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.rename('/sdcard/a.txt', 'b.txt')).toEqual({ ok: false, code: E_ALREADY_EXISTS })
    expect(fs.has('/sdcard/a.txt')).toBe(true)
    expect(fs.has('/sdcard/b.txt')).toBe(true)
  })
})

describe('裁决 1：删除', () => {
  it('普通文件 → stat 确认存在后 rm -f（非递归）', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/a.txt': 'file' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.remove('/sdcard/a.txt')).toEqual({ ok: true })
    expect(fs.commands).toEqual(["stat -c %F -- '/sdcard/a.txt'", "rm -f -- '/sdcard/a.txt'"])
    expect(fs.has('/sdcard/a.txt')).toBe(false)
  })

  it('目录 → rm -rf（递归），子项一起消失', async () => {
    const fs = fakeFs({
      '/sdcard': 'dir',
      '/sdcard/Download': 'dir',
      '/sdcard/Download/目录': 'dir',
      '/sdcard/Download/目录/a.jpg': 'file',
      '/sdcard/Download/目录/sub': 'dir',
      '/sdcard/Download/目录/sub/b.jpg': 'file',
    })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.remove('/sdcard/Download/目录')).toEqual({ ok: true })
    // I5 引入了一条前置的浅层 ls（用于失败时算「已删/剩余」），rm 不再是第 2 条命令
    expect(fs.commands.some((c) => c === "rm -rf -- '/sdcard/Download/目录'")).toBe(true)
    expect(Object.keys(fs.tree())).toEqual(['/sdcard', '/sdcard/Download'])
  })

  it('符号链接 → 只用 rm -f 删链接本身，绝不递归（rm 不跟随操作数链接）', async () => {
    const fs = fakeFs({
      '/sdcard': 'dir',
      '/sdcard/link-to-system': 'link',
      '/system': 'dir',
      '/system/important.so': 'file',
    })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.remove('/sdcard/link-to-system')).toEqual({ ok: true })
    expect(fs.commands[1]).toBe("rm -f -- '/sdcard/link-to-system'")
    expect(fs.has('/sdcard/link-to-system')).toBe(false)
    // 链接目标毫发无伤
    expect(fs.has('/system/important.so')).toBe(true)
  })

  it('路径不存在 → E_NOT_FOUND，不发 rm', async () => {
    const fs = fakeFs({ '/sdcard': 'dir' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.remove('/sdcard/gone')).toEqual({ ok: false, code: 'E_NOT_FOUND' })
    expect(fs.commands.some((c) => c.startsWith('rm '))).toBe(false)
  })

  it('受保护根路径 → E_PROTECTED_PATH，不 stat 也不 rm', async () => {
    const fs = fakeFs({ '/sdcard': 'dir' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.remove('/sdcard')).toEqual({ ok: false, code: E_PROTECTED_PATH })
    expect(fs.commands).toHaveLength(0)
  })
})

describe('复制（同设备 cp，不经过 USB）', () => {
  it('目标已存在 → 拒绝（cp -a 会覆盖，必须先拦）', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/a.txt': 'file', '/sdcard/b.txt': 'file' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.copy('/sdcard/a.txt', '/sdcard/b.txt')).toEqual({ ok: false, code: E_ALREADY_EXISTS })
    expect(fs.commands.some((c) => c.startsWith('cp '))).toBe(false)
  })

  it('目标不存在 → cp -a 成功，源保留、目标出现', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/a.txt': 'file' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.copy('/sdcard/a.txt', '/sdcard/b.txt')).toEqual({ ok: true })
    expect(fs.commands).toContain("cp -a -- '/sdcard/a.txt' '/sdcard/b.txt'")
    expect(fs.has('/sdcard/a.txt')).toBe(true)
    expect(fs.has('/sdcard/b.txt')).toBe(true)
  })

  it('cp 失败 → E_OP_FAILED，源文件仍在', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/a.txt': 'file' }, { cpFails: true })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.copy('/sdcard/a.txt', '/sdcard/b.txt')).toEqual({ ok: false, code: E_OP_FAILED })
    expect(fs.has('/sdcard/a.txt')).toBe(true)
  })
})

describe('目录非空探测（删除确认框要用，裁决 1）', () => {
  it('有子项 → true；空目录 → false', async () => {
    const fs = fakeFs({
      '/sdcard': 'dir',
      '/sdcard/DCIM': 'dir',
      '/sdcard/DCIM/a.jpg': 'file',
      '/sdcard/Empty': 'dir',
    })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.dirHasEntries('/sdcard/DCIM')).toBe(true)
    expect(await ops.dirHasEntries('/sdcard/Empty')).toBe(false)
  })

  it('探测失败时按「可能非空」保守处理（绝不让用户以为删的是空目录）', async () => {
    const client: OpsRunner = {
      serial: 'FAKE',
      run: async () => ({ code: 1, stdout: '', stderr: 'ls: Permission denied' }),
    }
    expect(await new RemoteOps({ client, adbPath: ADB }).dirHasEntries('/data')).toBe(true)
  })
})

describe('裁决 3 / C3：不能复制或移动到自身子目录（无界递归）', () => {
  it('复制到自己的子目录 → E_INTO_SELF，且一条 cp 都没发', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/A': 'dir', '/sdcard/A/inner': 'dir' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.copy('/sdcard/A', '/sdcard/A/inner')).toEqual({ ok: false, code: E_INTO_SELF })
    expect(fs.commands.some((c) => c.startsWith('cp '))).toBe(false)
    expect(Object.keys(fs.tree())).toEqual(['/sdcard', '/sdcard/A', '/sdcard/A/inner'])
  })

  it('复制到自己的更深处 → E_INTO_SELF', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/A': 'dir', '/sdcard/A/x': 'dir', '/sdcard/A/x/y': 'dir' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.copy('/sdcard/A', '/sdcard/A/x/y')).toEqual({ ok: false, code: E_INTO_SELF })
  })

  it('复制到自身（同一路径）→ E_INTO_SELF', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/A': 'dir' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.copy('/sdcard/A', '/sdcard/A')).toEqual({ ok: false, code: E_INTO_SELF })
  })

  it('移动到自己的子目录 → E_INTO_SELF（mv 同样会退化）', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/A': 'dir', '/sdcard/A/inner': 'dir' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.move('/sdcard/A', '/sdcard/A/inner')).toEqual({ ok: false, code: E_INTO_SELF })
    expect(fs.commands.some((c) => c.startsWith('mv '))).toBe(false)
  })

  it('同名前缀的兄弟目录不算自包含（不能误杀）', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/A': 'dir', '/sdcard/AB': 'dir', '/sdcard/A/f.txt': 'file' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.copy('/sdcard/A/f.txt', '/sdcard/AB/f.txt')).toEqual({ ok: true })
    expect(fs.has('/sdcard/AB/f.txt')).toBe(true)
  })

  /*
   * 【第 2 轮复审 C3 补充】别名盲区。
   *
   * /sdcard 与 /storage/emulated/0 是**同一个目录**的两个名字（真机上是 bind 挂载）。
   * 修前只做字符串前缀比较，于是「从 /sdcard/A 复制到 /storage/emulated/0/A/inner」
   * 看起来毫不相干，实际是写进自己的子目录 —— 复审在真机上实测 2 秒内目录数从 2 涨到 88。
   * 现在比较前先做别名归一（path-guard 的 canonicalRemotePath）。
   */
  it('跨别名写自身子目录 → E_INTO_SELF（/sdcard 与 /storage/emulated/0 是同一个目录）', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/A': 'dir', '/sdcard/A/inner': 'dir' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.copy('/sdcard/A', '/storage/emulated/0/A/inner'))
      .toEqual({ ok: false, code: E_INTO_SELF })
    expect(await ops.copy('/storage/emulated/0/A', '/sdcard/A/inner'))
      .toEqual({ ok: false, code: E_INTO_SELF })
    // 一条 cp 都不能发出去 —— 真机上一发就是无界递归
    expect(fs.commands.some((c) => c.startsWith('cp '))).toBe(false)
  })

  it('跨别名到兄弟目录照常放行（别名归一不能变成误杀）', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/A': 'dir', '/storage/emulated/0/B': 'dir', '/sdcard/A/f.txt': 'file' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.copy('/sdcard/A/f.txt', '/storage/emulated/0/B/f.txt')).toEqual({ ok: true })
  })

  it('普通文件复制到别的目录 → 允许', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/A': 'dir', '/sdcard/B': 'dir', '/sdcard/A/f.txt': 'file' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.copy('/sdcard/A/f.txt', '/sdcard/B/f.txt')).toEqual({ ok: true })
  })
})

describe('审查 I4：跨文件系统移动必须拒绝（不可回滚）', () => {
  it('设备号不同 → E_CROSS_DEVICE，且一条 mv 都没发', async () => {
    const fs = fakeFs({
      '/data': 'dir', '/data/local': 'dir', '/data/local/tmp': 'dir',
      '/data/local/tmp/a': 'file', '/sdcard': 'dir',
    })
    fs.devices.set('/data', 2)
    fs.devices.set('/sdcard', 1)
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    const result = await ops.move('/data/local/tmp/a', '/sdcard/a')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(E_CROSS_DEVICE)
    expect(fs.commands.some((c) => c.startsWith('mv '))).toBe(false)
    expect(fs.has('/data/local/tmp/a')).toBe(true)
  })

  it('设备号相同 → 正常移动（同 FS 的 mv 是内核 rename，原子）', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/A': 'dir', '/sdcard/B': 'dir', '/sdcard/A/f.txt': 'file' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.move('/sdcard/A/f.txt', '/sdcard/B/f.txt')).toEqual({ ok: true })
    expect(fs.has('/sdcard/B/f.txt')).toBe(true)
  })
})


/*
 * 【审查 I1 / I2 的可执行替代】
 *
 * 这两条原本是 tests/ui-contract.test.ts 里的源码正则：
 *   I1: not.toMatch(/split\('\/'\).*=== '\.\.'/)      —— 源码从来没有这种形态
 *   I2: not.toMatch(/\['\s*\+\s*path\b/)              —— 真实旁路是 'raw ' + path
 * 复审往里灌了真实缺陷（gate() 里重复一份 '..' 规则、opPath 返回 'raw ' + path），
 * 两条断言依然全绿。所以判据必须换成**行为**：
 *
 *   1. 命令构造函数的输出必须逐字节等于 shellQuote 的产物 ——
 *      任何绕过 shellQuote 的写法（拼前缀、拼后缀、少转义一个操作数）都会红；
 *   2. 含 '..' 的输入必须在**所有**命令构造函数上一律抛 E_PATH_UNSAFE ——
 *      不管这条规则写在 gate()、opPath() 还是构造函数里，缺一处就红。
 *
 * 这些断言不关心实现长什么样，只关心用户能观察到的结果。
 */
describe('审查 I1/I2：闸门行为（替代两条空转的源码正则）', () => {
  const SAMPLE = "/sdcard/Download/测试 目录'1' a.txt"

  it('四个命令构造函数的输出逐字节等于 shellQuote 的产物（无拼接旁路）', () => {
    const quoted = shellQuote(SAMPLE)
    // 先确认 shellQuote 确实是「包一层单引号 + 转义内嵌单引号」的形态，
    // 否则下面的等值断言可能因为两边一起错而通过
    expect(quoted.startsWith("'")).toBe(true)
    expect(quoted.endsWith("'")).toBe(true)
    expect(quoted).toContain("'\"'\"'")

    expect(opsMkdirCommand(SAMPLE)).toBe('mkdir -- ' + quoted)
    expect(opsRemoveCommand(SAMPLE, false)).toBe('rm -f -- ' + quoted)
    expect(opsRemoveCommand(SAMPLE, true)).toBe('rm -rf -- ' + quoted)
    expect(opsMoveCommand(SAMPLE, SAMPLE)).toBe('mv -n -- ' + quoted + ' ' + quoted)
    expect(opsCopyCommand(SAMPLE, SAMPLE)).toBe('cp -a -- ' + quoted + ' ' + quoted)
  })

  it('第二个操作数也单独转义（只转第一个是常见漏法）', () => {
    const a = shellQuote('/sdcard/a b.txt')
    const b = shellQuote("/sdcard/c d'e.txt")
    expect(opsMoveCommand('/sdcard/a b.txt', "/sdcard/c d'e.txt")).toBe('mv -n -- ' + a + ' ' + b)
    expect(opsCopyCommand('/sdcard/a b.txt', "/sdcard/c d'e.txt")).toBe('cp -a -- ' + a + ' ' + b)
  })

  it.each([
    '/sdcard/../data/local/tmp',
    '/sdcard/Download/../DCIM',
    '/sdcard/A/../A',
    '/../sdcard',
  ])('含 .. 的输入在四个构造函数上一律 E_PATH_UNSAFE：%s', (bad) => {
    expect(() => opsMkdirCommand(bad)).toThrow(E_PATH_UNSAFE)
    expect(() => opsRemoveCommand(bad, false)).toThrow(E_PATH_UNSAFE)
    expect(() => opsCopyCommand(bad, '/sdcard/ok')).toThrow(E_PATH_UNSAFE)
    expect(() => opsCopyCommand('/sdcard/ok', bad)).toThrow(E_PATH_UNSAFE)
    expect(() => opsMoveCommand(bad, '/sdcard/ok')).toThrow(E_PATH_UNSAFE)
    expect(() => opsMoveCommand('/sdcard/ok', bad)).toThrow(E_PATH_UNSAFE)
  })

  it.each(['/', '/sdcard', '/storage/emulated/0', '/data', '/sdcard/Android/data'])(
    '受保护路径在四个构造函数上不能再被写：%s',
    (bad) => {
      expect(() => opsMkdirCommand(bad)).toThrow(E_PROTECTED_PATH)
      expect(() => opsRemoveCommand(bad, true)).toThrow(E_PROTECTED_PATH)
      expect(() => opsCopyCommand(bad, '/sdcard/ok')).toThrow(E_PROTECTED_PATH)
      expect(() => opsMoveCommand('/sdcard/ok', bad)).toThrow(E_PROTECTED_PATH)
    },
  )
})

describe('审查 I5：递归删除中途失败必须如实说「删掉了一部分」', () => {
  it('失败时给出「已删 N / 剩余 M」并报 E_OP_PARTIAL', async () => {
    const fs = fakeFs({
      '/sdcard': 'dir',
      '/sdcard/D': 'dir',
      '/sdcard/D/a.txt': 'file',
      '/sdcard/D/b.txt': 'file',
      '/sdcard/D/c.txt': 'file',
    })
    fs.failRemoveAfterDeleting(2)
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    const result = await ops.remove('/sdcard/D')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(E_OP_PARTIAL)
      expect(result.removed).toBe(2)
      expect(result.remaining).toBe(1)
    }
  })

  it('一项都没删成功时仍然是普通失败（不夸大成部分完成）', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/D': 'dir', '/sdcard/D/a.txt': 'file' })
    fs.failRemoveAfterDeleting(0)
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    const result = await ops.remove('/sdcard/D')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).not.toBe(E_OP_PARTIAL)
  })

  it('删除成功时不带任何计数（正常路径不产生噪音）', async () => {
    const fs = fakeFs({ '/sdcard': 'dir', '/sdcard/D': 'dir', '/sdcard/D/a.txt': 'file' })
    const ops = new RemoteOps({ client: fs.client, adbPath: ADB })
    expect(await ops.remove('/sdcard/D')).toEqual({ ok: true })
  })
})

