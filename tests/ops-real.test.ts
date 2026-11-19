import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { AdbClient } from '../electron/adb/client'
import { RemoteOps } from '../electron/fs/operations'
import { FsOpsService } from '../electron/fs/op-service'
import { E_ALREADY_EXISTS, E_PROTECTED_PATH } from '../src/shared/errors'

/*
 * 裁决 9：真机上的全链路文件操作（中文 / 空格 / 单引号文件名）。
 *
 * 跳过必须说话：模块顶层打印原因（不能放 beforeAll —— 全员 skip 时 beforeAll 不执行）。
 * 设备号绝不硬编码：先 ADB_TEST_SERIAL，否则从 adb devices 自动取第一台在线设备。
 *
 * 清理（项目里已经犯过三次「留垃圾」的问题，这里必须彻底）：
 * beforeAll 先删一次残留目录（防上次崩溃留下的），afterAll 再删一次；
 * 目录名固定且前缀唯一，即使某次异常退出也不会污染用户其它文件。
 */

const ADB = process.env.ADB_PATH ?? 'adb'

function resolveSerial(): string | null {
  const fromEnv = process.env.ADB_TEST_SERIAL
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  try {
    const out = execFileSync(ADB, ['devices'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    for (const line of out.split(/\r?\n/)) {
      const match = /^(\S+)\s+device\b/.exec(line.trim())
      if (match !== null) return match[1]
    }
  } catch {
    return null
  }
  return null
}

const SERIAL = resolveSerial()
const skip = SERIAL === null
if (skip) {
  console.log('[ops-real] 跳过真机用例：没有找到在线设备（ADB_TEST_SERIAL 未设置，adb devices 也没有 device 状态的设备）')
}

/** 设备上的测试目录（含空格、中文、单引号 —— 正是易出错的三种字符）。 */
const BASE = "/sdcard/Download/adbfm-task9-测试 目录'1'"

describe.skipIf(skip)('真机文件操作（裁决 9）', () => {
  let ops: RemoteOps
  let service: FsOpsService
  let adbPath = ''

  function shell(command: string): string {
    return execFileSync(ADB, ['-s', SERIAL as string, 'shell', command], {
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
    })
  }
  /** 用单引号包住路径（测试脚本自己也要正确转义）。 */
  function q(value: string): string {
    return "'" + value.split("'").join("'\\''") + "'"
  }
  /** ls -1A 的原始名字列表（用于复核每一步的结果）。 */
  function lsNames(dir: string): string[] {
    const out = shell('LC_ALL=C ls -1A -- ' + q(dir.endsWith('/') ? dir : dir + '/'))
    return out.split(/\r?\n/).filter((line) => line !== '').sort()
  }
  function exists(path: string): boolean {
    try {
      return shell('test -e ' + q(path) + ' && echo yes').includes('yes')
    } catch {
      return false
    }
  }

  beforeAll(() => {
    adbPath = ADB
    const client = new AdbClient(SERIAL as string)
    ops = new RemoteOps({ client, adbPath })
    service = new FsOpsService({ clientFor: () => client, adbPath: () => adbPath })
    // 清掉上次可能残留的目录（防崩溃遗留）
    try { shell('rm -rf -- ' + q(BASE)) } catch { /* 不存在是常态 */ }
    try { shell('rm -rf -- ' + q(BASE + ' 副本')) } catch { /* 同上 */ }
  }, 120_000)

  afterAll(() => {
    // 无论用例成败都清干净：这是本项目的硬要求（不许留垃圾）
    try { shell('rm -rf -- ' + q(BASE)) } catch { /* 忽略清理失败 */ }
    try { shell('rm -rf -- ' + q(BASE + ' 副本')) } catch { /* 同上 */ }
  }, 120_000)

  it('新建目录 → 新建子目录 → 每一步用 ls 复核', async () => {
    // 1) 建含中文/空格/单引号的目录
    expect(await ops.mkdir('/sdcard/Download', "adbfm-task9-测试 目录'1'")).toEqual({ ok: true })
    expect(exists(BASE)).toBe(true)
    // 复核：父目录里能看到这个名字（逐字节比对，不是「差不多」）
    expect(lsNames('/sdcard/Download')).toContain("adbfm-task9-测试 目录'1'")

    // 2) 在其中再建一个普通子目录
    expect(await ops.mkdir(BASE, '子目录')).toEqual({ ok: true })
    expect(lsNames(BASE)).toEqual(['子目录'])

    // 3) 重名必须拒绝（裁决 3）
    expect(await ops.mkdir(BASE, '子目录')).toEqual({ ok: false, code: E_ALREADY_EXISTS })
  }, 120_000)

  it('创建文件 → 重命名（中文/空格） → 复核', async () => {
    // 设备上没有「创建空文件」的操作入口，直接用 shell 造一个（测试夹具，不是被测代码）
    shell('touch -- ' + q(BASE + '/原文件.txt'))
    expect(lsNames(BASE)).toContain('原文件.txt')

    // 重命名成含空格与中文的名字
    expect(await ops.rename(BASE + '/原文件.txt', '我的 照片.jpg')).toEqual({ ok: true })
    const names = lsNames(BASE)
    expect(names).toContain('我的 照片.jpg')
    expect(names).not.toContain('原文件.txt')

    // 改名到已存在的名字 → 拒绝（两个文件都还在）
    shell('touch -- ' + q(BASE + '/另一个.txt'))
    expect(await ops.rename(BASE + '/另一个.txt', '我的 照片.jpg')).toEqual({ ok: false, code: E_ALREADY_EXISTS })
    expect(lsNames(BASE).sort()).toEqual(['子目录', '我的 照片.jpg', '另一个.txt'].sort())
  }, 120_000)

  it('复制到目标目录 → 源与目标都在 → 删除副本', async () => {
    expect(await ops.copy(BASE + '/我的 照片.jpg', BASE + '/子目录/副本 照片.jpg')).toEqual({ ok: true })
    expect(exists(BASE + '/我的 照片.jpg')).toBe(true)
    expect(lsNames(BASE + '/子目录')).toEqual(['副本 照片.jpg'])

    // 覆盖式复制必须被拒（裁决 3）
    expect(await ops.copy(BASE + '/我的 照片.jpg', BASE + '/子目录/副本 照片.jpg'))
      .toEqual({ ok: false, code: E_ALREADY_EXISTS })

    expect(await ops.remove(BASE + '/子目录/副本 照片.jpg')).toEqual({ ok: true })
    expect(lsNames(BASE + '/子目录')).toEqual([])
  }, 120_000)

  it('移动文件到子目录 → 源消失、目标出现', async () => {
    expect(await ops.move(BASE + '/另一个.txt', BASE + '/子目录/另一个.txt')).toEqual({ ok: true })
    expect(exists(BASE + '/另一个.txt')).toBe(false)
    expect(lsNames(BASE + '/子目录')).toEqual(['另一个.txt'])
  }, 120_000)

  it('批量删除：3 项里第 2 项不存在 → 1、3 成功而第 2 项带错误码，其余不受影响', async () => {
    shell('touch -- ' + q(BASE + '/a.txt') + ' ' + q(BASE + '/c.txt'))
    const result = await service.remove(SERIAL as string, [
      BASE + '/a.txt',
      BASE + '/不存在的中.txt',
      BASE + '/c.txt',
    ])
    expect(result.results).toEqual([
      { name: 'a.txt', ok: true },
      { name: '不存在的中.txt', ok: false, code: 'E_NOT_FOUND' },
      { name: 'c.txt', ok: true },
    ])
    const names = lsNames(BASE)
    expect(names).not.toContain('a.txt')
    expect(names).not.toContain('c.txt')
  }, 120_000)

  it('递归删除非空目录 → 内容一起消失，确认事实里标出「非空」', async () => {
    const facts = await service.removeFacts(SERIAL as string, [BASE + '/子目录'])
    expect(facts.count).toBe(1)
    expect(facts.names).toEqual(['子目录'])
    expect(facts.hasNonEmptyDir).toBe(true)

    expect(await ops.remove(BASE + '/子目录')).toEqual({ ok: true })
    expect(lsNames(BASE)).not.toContain('子目录')
  }, 120_000)

  it('裁决 1：受保护根路径拒绝删除（真机上同样拦住）', async () => {
    expect(await ops.remove('/sdcard')).toEqual({ ok: false, code: E_PROTECTED_PATH })
    expect(await ops.remove('/storage/emulated/0')).toEqual({ ok: false, code: E_PROTECTED_PATH })
    // 复核：/sdcard 还在且内容还在
    expect(exists('/sdcard/Download')).toBe(true)
  }, 120_000)

  it('裁决 1：符号链接只删链接本身，目标目录毫发无伤', async () => {
    /*
     * 链接必须造在 /data/local/tmp 而不是 /sdcard 上。
     *
     * 真机实测（本任务）：/sdcard 是 fuse/sdcardfs，**不支持创建符号链接**
     * （ln: Function not implemented）。这不是权限问题，是文件系统能力问题，
     * 换个挂载点也没用。而 /data/local/tmp 是 ext4，普通应用权限即可建链接。
     *
     * 链接指向 /sdcard/Download —— 正是「删链接不能把目标目录递归删掉」要验证的场景。
     */
    const linkPath = '/data/local/tmp/adbfm-task9-link'
    try { shell('rm -f -- ' + q(linkPath)) } catch { /* 不存在是常态 */ }
    shell('ln -s -- ' + q('/sdcard/Download') + ' ' + q(linkPath))
    // 复核：确实是个链接（stat -c %F 会说 symbolic link）
    expect(shell('stat -c %F -- ' + q(linkPath)).trim()).toBe('symbolic link')

    expect(await ops.remove(linkPath)).toEqual({ ok: true })
    expect(exists(linkPath)).toBe(false)
    // 目标目录与里面的内容都没有被递归删掉
    expect(exists('/sdcard/Download')).toBe(true)
    try { shell('rm -f -- ' + q(linkPath)) } catch { /* 已被删则忽略 */ }
  }, 120_000)
})
