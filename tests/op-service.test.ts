import { describe, it, expect } from 'vitest'
import { FsOpsService } from '../electron/fs/op-service'
import type { OpsRunner } from '../electron/fs/operations'

/*
 * 裁决 4 的服务层证据：批量操作必须逐项容错、结果可追溯。
 *
 * 这一层比 shared/fs-ops 的纯逻辑测试更强：它跑的是**真实编排**
 * （前置校验 → 逐项执行 → 逐项结果），只是把 adb 换成一个有状态的假文件系统。
 */

type Kind = 'file' | 'dir' | 'link'
const KIND_TEXT: Record<Kind, string> = { file: 'regular file', dir: 'directory', link: 'symbolic link' }

/** 有状态的假设备文件系统（足够执行 stat / mkdir / mv -n / cp -a / rm / ls）。 */
function fakeDevice(initial: Record<string, Kind>): { client: OpsRunner; commands: string[]; tree: () => string[] } {
  const nodes = new Map<string, Kind>(Object.entries(initial))
  const commands: string[] = []

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
  const removeTree = (path: string): void => {
    for (const child of children(path)) removeTree(path + '/' + child)
    nodes.delete(path)
  }
  const argv = (cmd: string): string[] => {
    const out: string[] = []
    let current = ''
    let quoted = false
    let has = false
    for (const ch of cmd) {
      if (ch === "'") { quoted = !quoted; current += ch; has = true; continue }
      if (ch === ' ' && !quoted) {
        if (has) { out.push(current); current = ''; has = false }
        continue
      }
      current += ch
      has = true
    }
    if (has) out.push(current)
    return out.map((t) => (t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1).split("'\"'\"'").join("'") : t))
  }

  const client: OpsRunner = {
    serial: 'FAKE',
    run: async (args: string[]) => {
      const cmd = args[1]
      commands.push(cmd)
      const t = argv(cmd)
      if (t[0] === 'stat') {
        const kind = nodes.get(t[4])
        if (kind === undefined) return { code: 1, stdout: '', stderr: 'stat: No such file or directory' }
        return { code: 0, stdout: KIND_TEXT[kind] + '\n', stderr: '' }
      }
      if (t[0] === 'mkdir') {
        const p = t[2]
        if (nodes.has(p)) return { code: 1, stdout: '', stderr: 'mkdir: File exists' }
        nodes.set(p, 'dir')
        return { code: 0, stdout: '', stderr: '' }
      }
      // 目标父目录必须存在 —— 真机上 mv/cp 到不存在的目录就是这样失败的，
      // 假 fs 若不校验，「目标目录不存在」的用例会假绿。
      const parentOf = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/'
      const parentOk = (p: string): boolean => parentOf(p) === '/' || nodes.get(parentOf(p)) === 'dir'

      if (t[0] === 'mv') {
        const kind = nodes.get(t[3])
        if (kind === undefined) return { code: 1, stdout: '', stderr: 'No such file or directory' }
        if (nodes.has(t[4])) return { code: 0, stdout: '', stderr: '' }
        if (!parentOk(t[4])) return { code: 1, stdout: '', stderr: 'mv: No such file or directory' }
        nodes.delete(t[3])
        nodes.set(t[4], kind)
        return { code: 0, stdout: '', stderr: '' }
      }
      if (t[0] === 'cp') {
        const kind = nodes.get(t[3])
        if (kind === undefined) return { code: 1, stdout: '', stderr: 'cp: No such file or directory' }
        if (!parentOk(t[4])) return { code: 1, stdout: '', stderr: 'cp: No such file or directory' }
        nodes.set(t[4], kind)
        return { code: 0, stdout: '', stderr: '' }
      }
      if (t[0] === 'rm') {
        const p = t[3]
        const kind = nodes.get(p)
        if (kind === 'dir' && !t[1].includes('r')) return { code: 1, stdout: '', stderr: 'Is a directory' }
        if (kind === 'dir') for (const c of children(p)) removeTree(p + '/' + c)
        nodes.delete(p)
        return { code: 0, stdout: '', stderr: '' }
      }
      if (t[0] === 'LC_ALL=C') {
        const dir = t[4].replace(/\/+$/, '') || '/'
        if (nodes.get(dir) !== 'dir') return { code: 1, stdout: '', stderr: 'ls: no such dir' }
        const names = children(dir)
        return { code: 0, stdout: names.length === 0 ? '' : names.join('\n') + '\n', stderr: '' }
      }
      return { code: 127, stdout: '', stderr: 'unsupported: ' + cmd }
    },
  }
  return { client, commands, tree: () => [...nodes.keys()].sort() }
}

function service(client: OpsRunner): FsOpsService {
  return new FsOpsService({ clientFor: () => client, adbPath: () => 'C:/adb.exe' })
}

describe('裁决 4：3 项里第 2 项失败', () => {
  it('删除：1、3 成功，第 2 项带错误码，且第 2 项确实没被删', async () => {
    const dev = fakeDevice({
      '/sdcard': 'dir',
      '/sdcard/Download': 'dir',
      '/sdcard/Download/a.txt': 'file',
      '/sdcard/Download/c.txt': 'file',
      // b.txt 不存在 → 第 2 项必然失败
    })
    const result = await service(dev.client).remove('S', [
      '/sdcard/Download/a.txt',
      '/sdcard/Download/b.txt',
      '/sdcard/Download/c.txt',
    ])
    expect(result.results).toEqual([
      { name: 'a.txt', ok: true },
      { name: 'b.txt', ok: false, code: 'E_NOT_FOUND' },
      { name: 'c.txt', ok: true },
    ])
    expect(dev.tree()).toContain('/sdcard/Download')  // 目录还在
    expect(dev.tree()).not.toContain('/sdcard/Download/a.txt')
    expect(dev.tree()).not.toContain('/sdcard/Download/c.txt')
  })

  it('结果长度恒等于入参长度（每一项都有交代）', async () => {
    const dev = fakeDevice({ '/sdcard': 'dir', '/sdcard/Download': 'dir' })
    const result = await service(dev.client).remove('S', ['/sdcard/Download/x', '/sdcard/Download/y'])
    expect(result.results).toHaveLength(2)
    expect(result.results.every((item) => typeof item.ok === 'boolean')).toBe(true)
  })

  it('受保护路径不会尝试执行，单独标 E_PROTECTED_PATH', async () => {
    const dev = fakeDevice({ '/sdcard': 'dir', '/sdcard/Download': 'dir', '/sdcard/Download/a.txt': 'file' })
    const result = await service(dev.client).remove('S', ['/sdcard', '/sdcard/Download/a.txt'])
    expect(result.results).toEqual([
      { name: 'sdcard', ok: false, code: 'E_PROTECTED_PATH' },
      { name: 'a.txt', ok: true },
    ])
    // 根目录毫发无伤
    expect(dev.tree()).toContain('/sdcard')
    expect(dev.commands.some((c) => c === "rm -rf -- '/sdcard'")).toBe(false)
  })

  it('含 .. 的项被 E_PATH_UNSAFE 拒绝', async () => {
    const dev = fakeDevice({ '/sdcard': 'dir' })
    const result = await service(dev.client).remove('S', ['/sdcard/../../system'])
    expect(result.results[0].code).toBe('E_PATH_UNSAFE')
  })
})

describe('删除确认事实（裁决 1）', () => {
  it('给出数量、前 3 个名字、是否非空目录与被拒绝项', async () => {
    const dev = fakeDevice({
      '/sdcard': 'dir',
      '/sdcard/Download': 'dir',
      '/sdcard/Download/照片1.jpg': 'file',
      '/sdcard/Download/照片2.jpg': 'file',
      '/sdcard/Download/照片3.jpg': 'file',
      '/sdcard/Download/照片4.jpg': 'file',
      '/sdcard/Download/DCIM': 'dir',
      '/sdcard/Download/DCIM/inner.jpg': 'file',
    })
    const facts = await service(dev.client).removeFacts('S', [
      '/sdcard/Download/照片1.jpg',
      '/sdcard/Download/照片2.jpg',
      '/sdcard/Download/照片3.jpg',
      '/sdcard/Download/照片4.jpg',
      '/sdcard/Download/DCIM',
    ])
    expect(facts.count).toBe(5)
    expect(facts.names).toEqual(['照片1.jpg', '照片2.jpg', '照片3.jpg'])
    expect(facts.truncated).toBe(true)
    expect(facts.hasNonEmptyDir).toBe(true)
    expect(facts.blocked).toEqual([])
  })

  it('受保护项计入 blocked，且 count 只算真正会被删的项', async () => {
    const dev = fakeDevice({ '/sdcard': 'dir', '/sdcard/Download': 'dir', '/sdcard/Download/a.txt': 'file' })
    const facts = await service(dev.client).removeFacts('S', ['/sdcard', '/sdcard/Download/a.txt'])
    expect(facts.count).toBe(1)
    expect(facts.names).toEqual(['a.txt'])
    expect(facts.blocked).toEqual([{ name: 'sdcard', ok: false, code: 'E_PROTECTED_PATH' }])
  })

  it('空目录不触发 hasNonEmptyDir', async () => {
    const dev = fakeDevice({ '/sdcard': 'dir', '/sdcard/Download': 'dir', '/sdcard/Download/Empty': 'dir' })
    const facts = await service(dev.client).removeFacts('S', ['/sdcard/Download/Empty'])
    expect(facts.hasNonEmptyDir).toBe(false)
  })
})

describe('复制 / 移动到目标目录（裁决 3 / 6）', () => {
  it('复制到目标目录：逐项结果，同名已存在的那项失败', async () => {
    const dev = fakeDevice({
      '/sdcard': 'dir',
      '/sdcard/A': 'dir',
      '/sdcard/B': 'dir',
      '/sdcard/A/x.txt': 'file',
      '/sdcard/A/y.txt': 'file',
      '/sdcard/B/y.txt': 'file',
    })
    const result = await service(dev.client).copy('S', ['/sdcard/A/x.txt', '/sdcard/A/y.txt'], '/sdcard/B')
    expect(result.results).toEqual([
      { name: 'x.txt', ok: true },
      { name: 'y.txt', ok: false, code: 'E_ALREADY_EXISTS' },
    ])
    // B/y.txt 原有内容没有被覆盖（只断言仍然存在；内容级验证在真机做）
    expect(dev.tree()).toContain('/sdcard/B/y.txt')
  })

  it('移动成功：源消失、目标出现', async () => {
    const dev = fakeDevice({ '/sdcard': 'dir', '/sdcard/A': 'dir', '/sdcard/B': 'dir', '/sdcard/A/x.txt': 'file' })
    const result = await service(dev.client).move('S', ['/sdcard/A/x.txt'], '/sdcard/B')
    expect(result.results).toEqual([{ name: 'x.txt', ok: true }])
    expect(dev.tree()).not.toContain('/sdcard/A/x.txt')
    expect(dev.tree()).toContain('/sdcard/B/x.txt')
  })

  it('目标目录不存在 → 每项都失败（不是整批抛错）', async () => {
    const dev = fakeDevice({ '/sdcard': 'dir', '/sdcard/A': 'dir', '/sdcard/A/x.txt': 'file' })
    const result = await service(dev.client).move('S', ['/sdcard/A/x.txt'], '/sdcard/NoSuchDir')
    expect(result.results).toHaveLength(1)
    expect(result.results[0].ok).toBe(false)
  })

  it('缺 dstDir → E_INVALID_PATH（复制/移动必须有目标目录）', async () => {
    const dev = fakeDevice({ '/sdcard': 'dir' })
    const result = await service(dev.client).copy('S', ['/sdcard/a.txt'], undefined)
    expect(result.results[0].code).toBe('E_INVALID_PATH')
  })
})

describe('新建 / 重命名', () => {
  it('mkdir 成功；重名 → E_ALREADY_EXISTS', async () => {
    const dev = fakeDevice({ '/sdcard': 'dir', '/sdcard/Download': 'dir' })
    const svc = service(dev.client)
    expect(await svc.mkdir('S', '/sdcard/Download', '测试 目录')).toEqual({ ok: true })
    expect(dev.tree()).toContain('/sdcard/Download/测试 目录')
    expect(await svc.mkdir('S', '/sdcard/Download', '测试 目录')).toEqual({ ok: false, code: 'E_ALREADY_EXISTS' })
  })

  it('rename 到已存在的名字 → 拒绝且两边都在', async () => {
    const dev = fakeDevice({ '/sdcard': 'dir', '/sdcard/a.txt': 'file', '/sdcard/b.txt': 'file' })
    expect(await service(dev.client).rename('S', '/sdcard/a.txt', 'b.txt')).toEqual({ ok: false, code: 'E_ALREADY_EXISTS' })
    expect(dev.tree()).toEqual(['/sdcard', '/sdcard/a.txt', '/sdcard/b.txt'])
  })

  it('rename 成功 → 只有新名字', async () => {
    const dev = fakeDevice({ '/sdcard': 'dir', '/sdcard/a.txt': 'file' })
    expect(await service(dev.client).rename('S', '/sdcard/a.txt', '我的 照片.jpg')).toEqual({ ok: true })
    expect(dev.tree()).toEqual(['/sdcard', '/sdcard/我的 照片.jpg'])
  })
})
