import type { RunResult } from '../adb/client'
import { E_INVALID_PATH, shellQuote } from '../adb/shellsafe'
import {
  assertSafeRemotePath,
  checkName,
  isProtectedRemotePath,
  remoteParent,
} from '../../src/shared/path-guard'
import {
  E_ALREADY_EXISTS,
  E_NO_PERMISSION,
  E_NO_SPACE,
  E_NOT_FOUND,
  E_OP_FAILED,
  E_PROTECTED_PATH,
  E_READ_ONLY,
} from '../../src/shared/errors'
import { E_PATH_UNSAFE } from '../../src/shared/path-guard'

/**
 * 错误码在这里**原样再导出一次**，方便调用方只 import 本模块。
 * 值仍然来自 shared/errors 的单一事实源 —— 不是副本，是同一批常量。
 */
export {
  E_ALREADY_EXISTS,
  E_NO_SPACE,
  E_NOT_FOUND,
  E_OP_FAILED,
  E_PROTECTED_PATH,
  E_PATH_UNSAFE,
  E_READ_ONLY,
}

/**
 * 远程（设备侧）文件操作：新建 / 重命名 / 移动 / 复制 / 删除（任务 9）。
 *
 * ===== 三条不可越过的红线 =====
 *
 * 1. **所有动态路径都过 assertSafeRemotePath**（裁决 2）。本模块里没有任何一处
 *    自己拼路径再发命令的旁路：拼接在函数入口完成，校验紧随其后。
 *
 * 2. **删除是唯一不可逆操作**（裁决 1）。因此删除前一定先 stat：
 *    - 不存在就报 E_NOT_FOUND，而不是让 rm 静默成功（用户会以为删掉了）；
 *    - 是符号链接就只删链接本身（rm 默认不跟随操作数链接，这一点用 rm -f 显式钉住，
 *      而不是依赖「rm 的默认行为」这个隐含假设）；
 *    - 受保护的根路径（/sdcard、/storage/emulated/0 …）直接 E_PROTECTED_PATH，
 *      连 stat 都不发。
 *
 * 3. **目标已存在一律拒绝**（裁决 3）。这是「重命名/移动不能毁原文件」的关键：
 *    toybox 的 mv -n 在目标已存在时**静默返回 0 且什么都不做**，
 *    所以只看退出码会把「什么都没发生」当成成功。必须先 stat 目标。
 *    即便前置检查通过，mv 之后仍然复核源/目标状态 —— 工具链退化
 *    （mv 返回 0 却没动）必须报 E_OP_FAILED，而不是假装成功。
 *
 * ===== 为什么移动不做「复制+删除」兜底 =====
 * 同一次 adb shell 里的 mv 是内核 rename(2)，同一文件系统内原子；
 * 跨文件系统时 toybox 会退化成「复制+删除」。两种情况我们都**不自己实现复制+删除**：
 * 自实现的那条路径一旦在中间失败，就会出现「源被删了、目标只写了一半」——
 * 那正是裁决 3 要防的。相反，mv 自身失败时源文件一定还在（rename 的原子性），
 * 我们只需**复核**并如实报错。
 */

/** 设备上一个路径的存在性/类型。 */
export type RemoteKind = 'file' | 'dir' | 'link'

/** 操作结果（与 shared/fs-ops 的 OpItemResult 同构，只是不带 name）。 */
export type OpResult = { ok: true } | { ok: false; code: string }

/**
 * 操作所依赖的最小客户端契约（AdbClient 满足它；测试可注入假 fs）。
 *
 * 注意这**不是** fs/remote 的 ShellRunner：那个还带了时区缓存等列表专用能力，
 * 写操作一条都不需要。收窄接口让假实现只要 3 行就够。
 */
export interface OpsRunner {
  readonly serial?: string
  run(args: string[], opts: { adbPath: string; timeoutMs?: number }): Promise<RunResult>
}

/** 操作的依赖。 */
export interface RemoteOpsDeps {
  client: OpsRunner
  adbPath: string
  /** 单条命令超时（大目录的 rm -rf 可能很久）；缺省 60s。 */
  timeoutMs?: number
}

/** 操作命令的缺省超时：递归删一个上万条目的目录，低速设备上十几秒很常见。 */
export const OPS_TIMEOUT_MS = 60_000

/* ============ 命令构造（纯函数，便于逐字节断言） ============ */

/**
 * 校验并转义一个**操作路径**。受保护路径在这里统一拒绝。
 *
 * 单独抽出来是因为「受保护」这条必须覆盖**所有**写操作：
 * 删除、移动（源与目标）、改名（源与目标）。散在各处写一遍必然漏一处。
 */
function opPath(path: string): string {
  /*
   * 顺序有讲究（三条判据要各自给出**最准确**的错误码）：
   * 1. 含 '..' 段 → E_PATH_UNSAFE。必须排在最前：/sdcard/../../system 归一化后
   *    正好落在受保护名单里，先查保护名单就会把「穿越企图」误报成「这是系统目录」，
   *    用户据此得到的建议（"别动系统目录"）与真实问题（"你的路径有问题"）不符。
   * 2. 受保护的根路径 → E_PROTECTED_PATH。这一步要**早于** assertSafeRemotePath，
   *    因为后者把 '/' 当「不是可操作对象」判为 E_INVALID_PATH ——
   *    对用户来说 "不许删根目录" 比 "路径不合法" 准确得多。
   * 3. 其余语法问题（空、相对、控制字符、超长）交给统一闸门。
   */
  if (path.split('/').some((seg) => seg === '..')) throw new Error(E_PATH_UNSAFE)
  if (isProtectedRemotePath(path)) throw new Error(E_PROTECTED_PATH)
  return shellQuote(assertSafeRemotePath(path))
}

/** mkdir 命令。名字单独校验：它不能包含 '/'（否则「新建 a/b」会变成在别处建目录）。 */
export function opsMkdirCommand(target: string): string {
  return 'mkdir -- ' + opPath(target)
}

/** 移动/改名命令。带 -n：目标已存在时绝不做任何替换。 */
export function opsMoveCommand(from: string, to: string): string {
  return 'mv -n -- ' + opPath(from) + ' ' + opPath(to)
}

/** 复制命令。cp -a 保留时间戳与权限（Android 上 a 等价于 -dR --preserve=all）。 */
export function opsCopyCommand(from: string, to: string): string {
  return 'cp -a -- ' + opPath(from) + ' ' + opPath(to)
}

/**
 * 删除命令。
 *
 * recursive 只对**目录**打开：文件用 rm -f 更安全（即使将来有人误传目录，
 * 非递归的 rm 会报 "Is a directory" 而不是把内容删掉）。
 */
export function opsRemoveCommand(target: string, recursive: boolean): string {
  return (recursive ? 'rm -rf -- ' : 'rm -f -- ') + opPath(target)
}

/** stat 类型探测命令（%F 给 "directory" / "regular file" / "symbolic link"）。 */
export function opsIfExistsCommand(target: string): string {
  return 'stat -c %F -- ' + shellQuote(assertSafeRemotePath(target))
}

/* ============ 编排 ============ */

/** 把 stat 的 %F 输出归类；认不出来按普通文件处理（保守：不会误开递归）。 */
export function classifyKind(stdout: string): RemoteKind {
  const text = stdout.trim().toLowerCase()
  if (text.includes('symbolic link')) return 'link'
  if (text.includes('directory')) return 'dir'
  return 'file'
}

/** 把非零退出的 stderr 归类成错误码（与 fs/remote 的 classifyError 同构，但只管写操作）。 */
export function classifyFailure(stderr: string): string {
  if (/permission denied|operation not permitted/i.test(stderr)) return E_NO_PERMISSION
  if (/no such file or directory|not found/i.test(stderr)) return E_NOT_FOUND
  if (/read-only file system/i.test(stderr)) return E_READ_ONLY
  if (/no space left/i.test(stderr)) return E_NO_SPACE
  return E_OP_FAILED
}

export class RemoteOps {
  private readonly client: OpsRunner
  private readonly adbPath: string
  private readonly timeoutMs: number

  constructor(deps: RemoteOpsDeps) {
    this.client = deps.client
    this.adbPath = deps.adbPath
    this.timeoutMs = deps.timeoutMs ?? OPS_TIMEOUT_MS
  }

  /** 跑一条 shell 命令。不抛异常：网络/超时也折算成 code:null。 */
  private async shell(command: string): Promise<RunResult> {
    try {
      return await this.client.run(['shell', command], { adbPath: this.adbPath, timeoutMs: this.timeoutMs })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { code: null, stdout: '', stderr: message }
    }
  }

  /** 探测路径类型；不存在返回 undefined。 */
  async statKind(path: string): Promise<RemoteKind | undefined> {
    const result = await this.shell(opsIfExistsCommand(path))
    if (result.code !== 0) return undefined
    return classifyKind(result.stdout)
  }

  /**
   * 目录里有没有子项（删除确认框要用，裁决 1）。
   *
   * **探测失败按「非空」处理**（返回 true）：确认框多一句「该目录非空」
   * 只是保守，而反过来（把非空目录说成空）会让用户误删几百张照片。
   *
   * 操作数必须补尾斜杠（/sdcard 这类是符号链接，不补就列不出内容）——
   * 这里直接复用 fs/remote 的 lsOperand 语义，避免又写一份路径规则。
   */
  async dirHasEntries(dir: string): Promise<boolean> {
    let operand: string
    try {
      const safe = assertSafeRemotePath(dir)
      operand = safe === '/' ? '/' : safe + '/'
    } catch {
      return true
    }
    const result = await this.shell('LC_ALL=C ls -1A -- ' + shellQuote(operand))
    if (result.code !== 0) return true
    return result.stdout.replace(/[\r\n]+/g, '') !== ''
  }

  /** 新建目录（不递归建父级：父目录必须已存在，错误更明确）。 */
  async mkdir(dir: string, name: string): Promise<OpResult> {
    const nameVerdict = checkName(name)
    if (!nameVerdict.ok) return { ok: false, code: nameVerdict.code }
    let target: string
    try {
      target = assertSafeRemotePath(remoteJoin(dir, name))
    } catch (err) {
      return { ok: false, code: errorCodeOf(err) }
    }
    // 目标已存在 → 拒绝（mkdir 自己会报 File exists，但错误码不如这里精确）
    if ((await this.statKind(target)) !== undefined) return { ok: false, code: E_ALREADY_EXISTS }
    let command: string
    try {
      command = opsMkdirCommand(target)
    } catch (err) {
      return { ok: false, code: errorCodeOf(err) }
    }
    const result = await this.shell(command)
    if (result.code !== 0) return { ok: false, code: classifyFailure(result.stderr) }
    // 复核：命令返回 0 但目录没出现，属于协议层异常，必须如实报失败
    return (await this.statKind(target)) === 'dir' ? { ok: true } : { ok: false, code: E_OP_FAILED }
  }

  /**
   * 重命名（同一目录内改名）。新名字不能含 '/'，否则就变成「移动」了。
   * 语义上等价于 move，直接复用 —— 少一条独立路径就少一处漏检查的机会。
   */
  async rename(source: string, newName: string): Promise<OpResult> {
    const nameVerdict = checkName(newName)
    if (!nameVerdict.ok) return { ok: false, code: nameVerdict.code }
    let parent: string | null
    try {
      parent = remoteParent(assertSafeRemotePath(source))
    } catch (err) {
      return { ok: false, code: errorCodeOf(err) }
    }
    if (parent === null) return { ok: false, code: E_INVALID_PATH }
    return this.move(source, remoteJoin(parent, newName))
  }

  /**
   * 移动 / 改名（裁决 3：原子语义，失败不能毁原文件）。
   *
   * 步骤与理由：
   * 1. 先 stat 源：不存在立刻 E_NOT_FOUND（否则 mv 会失败，但错误码不够精确）；
   * 2. 再 stat 目标：**已存在就拒绝**。这一条不能省 ——
   *    toybox 的 mv -n 在目标存在时返回 0 且什么都不做，只看退出码会误判成功；
   * 3. 跑 mv -n --（-n 是第二道保险）；
   * 4. **复核**：源必须消失、目标必须出现。任一条不成立就是 E_OP_FAILED ——
   *    此时源文件仍在（rename 的原子性保证），用户的内容没有任何损失。
   */
  async move(source: string, target: string): Promise<OpResult> {
    let from: string
    let to: string
    try {
      from = assertSafeRemotePath(source)
      to = assertSafeRemotePath(target)
      // 受保护路径在做任何探测之前就拒（连 stat 都不发）
      if (isProtectedRemotePath(from) || isProtectedRemotePath(to)) {
        return { ok: false, code: E_PROTECTED_PATH }
      }
    } catch (err) {
      return { ok: false, code: errorCodeOf(err) }
    }

    const sourceKind = await this.statKind(from)
    if (sourceKind === undefined) return { ok: false, code: E_NOT_FOUND }
    if ((await this.statKind(to)) !== undefined) return { ok: false, code: E_ALREADY_EXISTS }

    let command: string
    try {
      command = opsMoveCommand(from, to)
    } catch (err) {
      return { ok: false, code: errorCodeOf(err) }
    }
    const result = await this.shell(command)
    if (result.code !== 0) {
      // 失败时源一定还在（mv 没能完成 rename），这里只负责如实报错，绝不做任何清理
      return { ok: false, code: classifyFailure(result.stderr) }
    }

    // 复核：mv 返回 0 不等于真的搬了（-n 静默跳过、或工具链退化）
    const afterSource = await this.statKind(from)
    const afterTarget = await this.statKind(to)
    if (afterSource !== undefined || afterTarget === undefined) {
      return { ok: false, code: E_OP_FAILED }
    }
    return { ok: true }
  }

  /**
   * 复制（同一设备内的 cp，不经过 USB，所以不排队、没有进度）。
   *
   * 目标已存在一律拒绝：cp -a 到已存在的目标会覆盖，与本任务「默认不覆盖」一致。
   */
  async copy(source: string, target: string): Promise<OpResult> {
    let from: string
    let to: string
    try {
      from = assertSafeRemotePath(source)
      to = assertSafeRemotePath(target)
    } catch (err) {
      return { ok: false, code: errorCodeOf(err) }
    }
    if ((await this.statKind(from)) === undefined) return { ok: false, code: E_NOT_FOUND }
    if ((await this.statKind(to)) !== undefined) return { ok: false, code: E_ALREADY_EXISTS }

    let command: string
    try {
      command = opsCopyCommand(from, to)
    } catch (err) {
      return { ok: false, code: errorCodeOf(err) }
    }
    const result = await this.shell(command)
    if (result.code !== 0) return { ok: false, code: classifyFailure(result.stderr) }
    return (await this.statKind(to)) !== undefined ? { ok: true } : { ok: false, code: E_OP_FAILED }
  }

  /**
   * 删除（唯一不可逆操作，裁决 1）。
   *
   * 三条硬性前置：
   * 1. 受保护路径 → E_PROTECTED_PATH（在白名单里，永远不删）；
   * 2. stat 确认存在 → 不存在报 E_NOT_FOUND（不让 rm 静默成功）；
   * 3. **符号链接只用 rm -f**：rm 默认删链接本身而不跟随，
   *    这里用非递归的 -f 把这个事实钉住 —— 万一真机上 rm 对目录链接的默认行为
   *    与预期不同，也只会失败，不会把链接指向的外部目录递归删掉。
   */
  async remove(target: string): Promise<OpResult> {
    let path: string
    try {
      path = assertSafeRemotePath(target)
    } catch (err) {
      return { ok: false, code: errorCodeOf(err) }
    }
    if (isProtectedRemotePath(path)) return { ok: false, code: E_PROTECTED_PATH }

    const kind = await this.statKind(path)
    if (kind === undefined) return { ok: false, code: E_NOT_FOUND }

    const recursive = kind === 'dir'
    let command: string
    try {
      command = opsRemoveCommand(path, recursive)
    } catch (err) {
      return { ok: false, code: errorCodeOf(err) }
    }
    const result = await this.shell(command)
    if (result.code !== 0) return { ok: false, code: classifyFailure(result.stderr) }
    return { ok: true }
  }
}

/** 从异常里取错误码（本模块只抛已知码，别的都算 E_OP_FAILED）。 */
function errorCodeOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message === E_PROTECTED_PATH || message === E_INVALID_PATH) return message
  if (message === 'E_PATH_UNSAFE') return message
  return E_OP_FAILED
}

/** 基目录 + 名字 → 完整路径（不校验，交由调用方统一 assertSafeRemotePath）。 */
function remoteJoin(dir: string, name: string): string {
  const base = dir === '/' ? '' : dir.replace(/\/+$/, '')
  return base + '/' + name
}
