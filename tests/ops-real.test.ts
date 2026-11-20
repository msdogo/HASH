import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { AdbClient } from '../electron/adb/client'
import { RemoteOps } from '../electron/fs/operations'
import { FsOpsService } from '../electron/fs/op-service'
import { E_ALREADY_EXISTS, E_CROSS_DEVICE, E_INTO_SELF, E_OP_PARTIAL, E_PROTECTED_PATH } from '../src/shared/errors'
import { acquireDeviceLock, deviceSkipMessage, resolveSerial } from './device-lock'

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

/*
 * 设备锁（N17）：batch/drag/ops/transfer 四个真机文件共用同一把
 * `adbfm-device-<serial>.lock` —— 默认并行的 `npx vitest run` 里它们互斥，
 * 不再互相删对方的临时文件。
 *
 * 必须在**模块顶层**抢：放 beforeAll 就晚了（那时临时目录、service 都已建好）。
 */
const SERIAL = resolveSerial()
const lockRelease = SERIAL === null ? null : acquireDeviceLock(SERIAL, 'ops-real')
const skip = SERIAL === null || lockRelease === null
if (skip) {
  // 三种原因（无设备 / serial 不在线 / 撞锁）必须能区分，且在模块顶层打印
  // （放 beforeAll 就晚了：全员 skip 时 beforeAll 根本不执行）
  console.log(deviceSkipMessage('ops-real', SERIAL, lockRelease))
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
    // 释放设备锁（最后一个动作：确保设备侧清理已经跑完）
    lockRelease?.()
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

  /*
   * 【复审 C3】真机反例：复制到一个目录自己的子目录里，必须被拒且不留递归产物。
   *
   * 复审实测（修前）：cp -a A A/inner 在真机上无界递归，一分钟内长到 122MB、
   * 深度 16385 层，最后因 Too many open files 才停；更糟的是产物层数太深，
   * **连删除本身都会失败**（rm -rf 同样撞上限），用户只能重刷存储。
   *
   * 复现它的是用户的自然操作：在 A 里新建 inner、全选、复制到 inner。
   * 所以这条用例必须打在真机上 —— 假 fs 只能证明我们「决定拒」，
   * 不能证明「这个输入在真设备上真的会爆炸」。
   */
  it('C3：复制目录到自己的子目录 → E_INTO_SELF，且设备上没有产生任何递归产物', async () => {
    const root = '/data/local/tmp/adbfm-c3-self'
    try { shell('rm -rf -- ' + q(root)) } catch { /* 不存在是常态 */ }
    shell('mkdir -p -- ' + q(root + '/A/inner'))
    shell('touch -- ' + q(root + '/A/f.txt'))
    const before = lsNames(root + '/A')

    const result = await ops.copy(root + '/A', root + '/A/inner')
    expect(result).toEqual({ ok: false, code: E_INTO_SELF })

    // 复核：目标目录里没有任何东西被写进去（没有 A、没有更深层）
    expect(lsNames(root + '/A/inner')).toEqual([])
    // 源目录内容一字未变
    expect(lsNames(root + '/A')).toEqual(before)
    // 深度没有增长：找出最深的路径，必须仍是 2 层（A/inner）
    const depth = shell('cd ' + q(root) + ' && find . -type d | awk -F/ "{print NF-1}" | sort -n | tail -1').trim()
    expect(Number(depth)).toBeLessThanOrEqual(2)

    shell('rm -rf -- ' + q(root))
    expect(exists(root)).toBe(false)
  }, 120_000)

  /*
   * 【复审 C3 真机对拍】同一个输入交给**原始 shell**，证明它真的会炸。
   *
   * 没有这条，C3 的拦截只是「我们选择不这么做」，而不是「不这么做是必要的」。
   * 这里只让 cp 跑 2 秒就杀掉，然后检查产物的深度已经远超合理范围 ——
   * 足以证明无界递归的存在，又不会把设备写满或留下删不掉的深树。
   */
  it('C3 对拍：同一个 cp 命令直接跑 2 秒就会开始无界递归（证明拦截是必要的）', async () => {
    const root = '/data/local/tmp/adbfm-c3-proof'
    try { shell('rm -rf -- ' + q(root)) } catch { /* 不存在是常态 */ }
    /*
     * 关键：目标 **inner 必须不存在**。
     *
     * 真机实测（本任务）两种形态表现不同，两者都必须被 C3 拦住：
     *   - inner 已存在 → toybox 直接拒绝：cp: 'A/inner/A' is 'A/inner'（退出码 0！）
     *   - inner 不存在 → toybox 先创建它再递归复制自己，深度一路涨到 16384，
     *     最后以 "Too many open files" 结束，设备上留下删不掉的深树
     * 后者才是「一条操作把设备写满」的那条，所以对拍用它。
     */
    shell('mkdir -p -- ' + q(root + '/A'))

    /*
     * 用 toybox 自带的 timeout 限制 2 秒（比「后台跑 + sleep + kill」快 20 倍：
     * 后者要等 40 秒左右才真正收敛，因为 kill 掉父进程后子进程仍在写）。
     * 真机实测 2 秒足够长到 16385 层 —— 递归是每层瞬间发生的。
     */
    try {
      shell('cd ' + q(root) + ' && timeout 2 cp -a -- A A/inner 2>/dev/null; true')
    } catch { /* 预期会因递归深度/句柄上限报错，不影响断言 */ }

    // 递归深度已经远超任何正常目录结构（合理目录不会超过十几层）
    const depthOut = shell('cd ' + q(root) + ' && find . -type d | awk -F/ "{print NF-1}" | sort -n | tail -1').trim()
    const depth = Number(depthOut)
    expect(Number.isFinite(depth)).toBe(true)
    expect(depth, 'cp -a A A/inner 没有表现出递归（设备行为可能已变，需重新评估 C3）').toBeGreaterThan(10)

    /*
     * 清理：rm -rf 对这么深的树仍然是可行的（toybox 的 rm 是迭代下潜，
     * 真机实测能删掉 16384 层的产物）。真正会失败的是 find/glob 那种
     * 一次性展开整条路径的写法，所以这里只用 rm -rf。
     */
    try { shell('rm -rf -- ' + q(root)) } catch { /* 忽略 */ }
    expect(exists(root), 'C3 对拍用例必须把自己造出来的深树清干净（本项目硬要求：不留垃圾）').toBe(false)
  }, 180_000)

  /*
   * 【复审 I4】真机：跨文件系统移动必须被拒，且源文件毫发无伤。
   *
   * 复审实测（修前）：/data/local/tmp → /sdcard/Download 的 mv 在源含不可读
   * 子目录时返回 1，但源里的 top.txt **已经消失**（toybox 退化成逐文件
   * 「复制+删除」），目标侧留下半棵树 —— 唯一无法回滚的移动形态。
   */
  it('I4：跨文件系统移动 → E_CROSS_DEVICE，源文件完整保留', async () => {
    const srcDir = '/data/local/tmp/adbfm-i4-src'
    const dstDir = '/sdcard/Download/adbfm-i4-dst'
    try { shell('rm -rf -- ' + q(srcDir)) } catch { /* 忽略 */ }
    try { shell('rm -rf -- ' + q(dstDir)) } catch { /* 忽略 */ }
    shell('mkdir -p -- ' + q(srcDir))
    shell('mkdir -p -- ' + q(dstDir))
    shell('echo KEEP-ME > ' + q(srcDir + '/top.txt'))

    // 先确认这确实是跨 FS（设备号不同），否则这条用例没有验证对象
    const srcDev = shell('stat -c %d -- ' + q(srcDir)).trim()
    const dstDev = shell('stat -c %d -- ' + q(dstDir)).trim()
    expect(srcDev).not.toBe(dstDev)

    const result = await ops.move(srcDir + '/top.txt', dstDir + '/top.txt')
    expect(result).toEqual({ ok: false, code: E_CROSS_DEVICE })

    // 源文件还在且内容完整（这正是修前丢掉的那个文件）
    expect(exists(srcDir + '/top.txt')).toBe(true)
    expect(shell('cat ' + q(srcDir + '/top.txt')).trim()).toBe('KEEP-ME')
    // 目标侧没有被写出半棵树
    expect(lsNames(dstDir)).toEqual([])

    shell('rm -rf -- ' + q(srcDir))
    shell('rm -rf -- ' + q(dstDir))
    expect(exists(srcDir)).toBe(false)
    expect(exists(dstDir)).toBe(false)
  }, 120_000)

  /*
   * 【复审 I5】真机：递归删除中途失败必须报「已删 N / 剩余 M」，不能说「保持原样」。
   *
   * 复审实测（修前）：父目录含 chmod 500 子目录时 rm -rf 返回 1，但部分内容
   * 已经删掉；而当时的错误码统一是 E_OP_FAILED，文案写着「文件保持原样」。
   */
  it('I5：递归删除中途失败 → E_OP_PARTIAL 且给出「已删 N / 剩余 M」', async () => {
    const root = '/data/local/tmp/adbfm-i5-partial'
    try { shell('rm -rf -- ' + q(root)) } catch { /* 忽略 */ }
    shell('mkdir -p -- ' + q(root + '/a') + ' ' + q(root + '/b') + ' ' + q(root + '/locked'))
    shell('touch -- ' + q(root + '/a/1.txt') + ' ' + q(root + '/b/2.txt') + ' ' + q(root + '/locked/3.txt'))
    /*
     * locked 目录设为 500（可读可进入、不可写）：rm -rf 会先删 a/b，
     * 到 locked 时删不掉里面的 3.txt —— 典型的「删了一部分才失败」。
     * 注意 shell 用户对 /data/local/tmp 有写权限，所以这里必须用 chmod
     * 真的把它变成不可写，否则 rm 会全部成功、用例前提不成立。
     */
    shell('chmod 500 -- ' + q(root + '/locked'))

    const result = await ops.remove(root)

    // 恢复权限以便清理（必须在断言之前，否则清理会失败）
    try { shell('chmod 700 -- ' + q(root + '/locked')) } catch { /* 忽略 */ }

    expect(result.ok).toBe(false)
    if (!result.ok) {
      /*
       * 设备行为可能因 SELinux/版本而异：只要**删掉了一部分**就必须报 E_OP_PARTIAL，
       * 并且两个数字都要给出；如果一项都没删掉，则保持普通失败码。
       * 两种结果都要求「不能声称文件保持原样」。
       */
      if (result.code === E_OP_PARTIAL) {
        expect(result.removed).toBeGreaterThan(0)
        expect(result.remaining).toBeGreaterThan(0)
        // 复核：a/b 真的没了（证明「已删」这个数字是真的）
        expect(exists(root + '/a')).toBe(false)
        expect(exists(root + '/b')).toBe(false)
      } else {
        // 前提不成立（一个都没删掉）时至少要保证没谎报部分完成
        expect(result.removed).toBeUndefined()
      }
    }

    shell('chmod 700 -- ' + q(root + '/locked'))
    shell('rm -rf -- ' + q(root))
    expect(exists(root)).toBe(false)
  }, 120_000)

  /*
   * 【第 2 轮复审 C3 别名】/sdcard 与 /storage/emulated/0 是同一个目录的两种写法。
   *
   * 复审真机实测（修前）：把 /sdcard/... 的目录复制到它自己的 /storage/emulated/0/... 子目录，
   * 词法比较看不出包含关系，于是放行 —— 两秒内目录数从 2 涨到 88，仍然是无界递归。
   * 因此这条必须打在真机上：别名是不是同一个 inode，只有设备能回答。
   */
  it('C3 别名：/sdcard 与 /storage/emulated/0 互写自身子目录 → E_INTO_SELF，设备上不产生递归产物', async () => {
    const viaSdcard = '/sdcard/Download/adbfm-c3-alias'
    const viaStorage = '/storage/emulated/0/Download/adbfm-c3-alias'
    try { shell('rm -rf -- ' + q(viaStorage)) } catch { /* 不存在是常态 */ }
    shell('mkdir -p -- ' + q(viaSdcard + '/A/inner'))
    shell('touch -- ' + q(viaSdcard + '/A/f.txt'))

    // 先证实两种写法确实是同一个目录（前提不成立就直接红，用例不能名不副实）
    const devA = shell('stat -c %d:%i -- ' + q(viaSdcard)).trim()
    const devB = shell('stat -c %d:%i -- ' + q(viaStorage)).trim()
    expect(devA, '两种路径写法不是同一个目录，C3 别名用例失去验证对象').toBe(devB)

    const result = await ops.copy(viaSdcard + '/A', '/storage/emulated/0/Download/adbfm-c3-alias/A/inner')
    expect(result).toEqual({ ok: false, code: E_INTO_SELF })

    // 目标目录必须仍然为空（一条 cp 都没发出去）
    expect(lsNames(viaSdcard + '/A/inner')).toEqual([])
    const depth = shell('cd ' + q(viaSdcard) + ' && find . -type d | awk -F/ "{print NF-1}" | sort -n | tail -1').trim()
    expect(Number(depth)).toBeLessThanOrEqual(3)

    shell('rm -rf -- ' + q(viaStorage))
    expect(exists(viaSdcard)).toBe(false)
  }, 120_000)

  /*
   * 【第 2 轮复审 C2 双轨绕过】fs 通道的**来源**必须和传输通道同一强度。
   *
   * 复审真机实测（修前）：fs:copy 能把 /data/local/tmp/secret.txt 复制到 /sdcard/Download，
   * ok:true —— cp -a 真的发出去了。这与 C2 禁止的 pull 通道等价，
   * 「fs 入参来自用户浏览位置」的理由也不成立（OpDialog 的目标目录是自由文本框）。
   * 这里直接打真机：验证拒绝，同时证明目标目录里确实没多出文件。
   */
  it('C2：fs 复制从 /data/local/tmp 拉出来 → E_PROTECTED_PATH，目标目录无新文件', async () => {
    const secret = '/data/local/tmp/adbfm-c2-secret.txt'
    const dstDir = '/sdcard/Download/adbfm-c2-dst'
    try { shell('rm -rf -- ' + q(dstDir)) } catch { /* 不存在是常态 */ }
    try { shell('rm -f -- ' + q(secret)) } catch { /* 同上 */ }
    shell('echo TOP-SECRET > ' + q(secret))
    shell('mkdir -p -- ' + q(dstDir))
    const before = lsNames(dstDir)

    const result = await service.copy(SERIAL as string, [secret], dstDir)

    expect(result.results).toHaveLength(1)
    expect(result.results[0].ok).toBe(false)
    expect(result.results[0].code).toBe(E_PROTECTED_PATH)
    // 关键：目标目录里一个文件都不能多出来（拒绝必须发生在执行之前）
    expect(lsNames(dstDir)).toEqual(before)

    shell('rm -f -- ' + q(secret))
    shell('rm -rf -- ' + q(dstDir))
    expect(exists(secret)).toBe(false)
    expect(exists(dstDir)).toBe(false)
  }, 120_000)
})
