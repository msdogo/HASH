import { toErrorCode } from '../../src/shared/errors'
import { E_ALREADY_EXISTS, E_INVALID_PATH, E_PROTECTED_PATH } from '../../src/shared/errors'
import {
  checkName,
  checkRemotePath,
  isProtectedRemotePath,
  isProtectedTransferPath,
  remoteBaseName,
  remoteJoin,
} from '../../src/shared/path-guard'
import { blockedResults, deleteConfirmSummary, runSequential, type OpItemResult } from '../../src/shared/fs-ops'
import type { FsOpData, FsRemoveFactsData } from '../../src/shared/file-ops'
import { RemoteOps, type OpsRunner } from './operations'

/**
 * 文件操作的服务层：把 IPC 的「用户意图」翻译成 RemoteOps 的一次次调用（任务 9）。
 *
 * ===== 这一层存在的理由 =====
 * IPC handler 不该知道「批量要逐项容错」「删除前要 stat 非空」「受保护路径要先拦」
 * 这些业务规则；RemoteOps 也不该知道「调用方可能一次给了 20 个源」。
 * 把「一次意图 → N 次操作 → N 条结果」的编排收在这里，
 * 于是这些规则**只有一处实现**，也就能被一组测试完整覆盖。
 *
 * ===== 三条贯穿全层的规则 =====
 * 1. **逐项容错**（裁决 4）：任何一项失败都不中断其余，结果数组长度恒等于入参；
 * 2. **先校验后执行**（裁决 1 / 2）：非法路径、受保护路径在做任何 IO 之前就被拦下，
 *    并在结果里单独标出（它们不是「执行失败」，是「根本没有尝试」）；
 * 3. **不覆盖**（裁决 3）：目标已存在一律失败，绝不静默替换用户的文件。
 */

/** 服务依赖。 */
export interface FsOpsDeps {
  /** 按 serial 造 client（getter 形态让测试能直接注入假 fs）。 */
  clientFor: (serial: string) => OpsRunner
  /** 当前 adb 路径（每次现取，理由同 TransferService：自检完成前是空串）。 */
  adbPath: () => string
  /** 单条命令超时（测试可缩短）。 */
  timeoutMs?: number
}

/**
 * 单项的「能不能做」判定。
 *
 * 用判别联合而不是 { ok, code? }：这样 `if (!gate.ok)` 之后 code 一定是 string，
 * 调用点不必再写 `gate.code ?? E_UNKNOWN` —— 那种兜底会把「忘了给码」变成
 * 一个静默的用户可见错误（E_UNKNOWN 提示），而不是编译期就能发现的漏项。
 */
type Gate =
  | { ok: true; path: string }
  | { ok: false; path: string; code: string }

export class FsOpsService {
  constructor(private readonly deps: FsOpsDeps) {}

  /** 造一个 RemoteOps（每次现取 adbPath：自检完成前它是空串）。 */
  private ops(serial: string): RemoteOps {
    return new RemoteOps({ client: this.deps.clientFor(serial), adbPath: this.deps.adbPath(), timeoutMs: this.deps.timeoutMs })
  }

  /**
   * 路径闸门：语法 + 受保护 + （可选的）是否允许受保护。
   *
   * remove/move/rename 都不允许受保护路径；这里统一过一个函数，
   * 避免「删除拦了、移动忘了」这类漏项。
   */
  private gate(path: string): Gate {
    const verdict = checkRemotePath(path)
    if (!verdict.ok) return { path, ok: false, code: verdict.code }
    if (isProtectedRemotePath(verdict.path)) return { path: verdict.path, ok: false, code: E_PROTECTED_PATH }
    return { path: verdict.path, ok: true }
  }


  /**
   * 删除前的确认事实（裁决 1）。
   *
   * 必须在**用户点确认之前**调用：确认框里的「N 项 / 前 3 个名字 / 该目录非空」
   * 全部来自这里的实际检查，而不是界面自己数的。
   *
   * count 只统计**真正会被删的项**：受保护/非法项进 blocked，
   * 否则用户会看到「将删除 3 项」结果只删了 2 项 —— 那是更坏的不一致。
   */
  async removeFacts(serial: string, targets: readonly string[]): Promise<FsRemoveFactsData> {
    const ops = this.ops(serial)
    const candidates: Array<{ name: string; isDir: boolean; nonEmpty: boolean }> = []
    const blocked: OpItemResult[] = []

    for (const target of targets) {
      const gate = this.gate(target)
      if (!gate.ok) {
        blocked.push({ name: remoteBaseName(target) || target, ok: false, code: gate.code })
        continue
      }
      const kind = await ops.statKind(gate.path)
      if (kind === undefined) {
        // 不存在的项：明确标出来，而不是让它悄悄从计数里消失
        blocked.push({ name: remoteBaseName(gate.path), ok: false, code: 'E_NOT_FOUND' })
        continue
      }
      candidates.push({
        name: remoteBaseName(gate.path),
        isDir: kind === 'dir',
        // 符号链接不当目录看：rm 只删链接本身，确认框说「非空目录」会吓到用户
        nonEmpty: kind === 'dir' ? await ops.dirHasEntries(gate.path) : false,
      })
    }

    const facts = deleteConfirmSummary(candidates)
    return { ...facts, blocked }
  }

  /**
   * 删除（不可逆，裁决 1 + 4）。
   *
   * 逐项执行：受保护/非法项直接进 blocked（不发命令），其余逐项 remove。
   * 最终结果 = blocked + 逐项执行结果，**顺序与入参一致**（用户按列表顺序对号入座）。
   */
  async remove(serial: string, targets: readonly string[]): Promise<FsOpData> {
    const ops = this.ops(serial)
    const results: OpItemResult[] = new Array(targets.length)
    const runnable: Array<{ index: number; path: string }> = []

    targets.forEach((target, index) => {
      const gate = this.gate(target)
      if (!gate.ok) {
        results[index] = { name: remoteBaseName(target) || target, ok: false, code: gate.code }
        return
      }
      runnable.push({ index, path: gate.path })
    })

    const executed = await runSequential(runnable.map((item) => item.path), async (path) => {
      const outcome = await ops.remove(path)
      if (outcome.ok) return { name: remoteBaseName(path), ok: true }
      /*
       * 【审查 I5】把「已删 N / 剩余 M」原样带上去。
       *
       * 丢掉这两个数字，界面就只剩一个 E_OP_PARTIAL 码，用户看到的仍是
       * 「操作失败」—— 而真正要传递的信息是「已经删掉了一部分，别直接重试」。
       */
      return {
        name: remoteBaseName(path),
        ok: false,
        code: outcome.code,
        ...(outcome.removed === undefined ? {} : { removed: outcome.removed }),
        ...(outcome.remaining === undefined ? {} : { remaining: outcome.remaining }),
      }
    })
    runnable.forEach((item, i) => {
      results[item.index] = executed[i]
    })

    return { results: results.filter((item) => item !== undefined) }
  }

  /** 新建目录（单个，不是批量：一次只建一个）。 */
  async mkdir(serial: string, dir: string, name: string): Promise<{ ok: true } | { ok: false; code: string }> {
    // 名字先过闸门（含斜杠/控制字符的名字不该走到命令构造）
    const nameVerdict = checkName(name)
    if (!nameVerdict.ok) return { ok: false, code: nameVerdict.code }
    const dirGate = this.gate(dir)
    if (!dirGate.ok) return { ok: false, code: dirGate.code }
    const target = remoteJoin(dirGate.path, name)
    const targetGate = checkRemotePath(target)
    if (!targetGate.ok) return { ok: false, code: targetGate.code }
    if (isProtectedRemotePath(targetGate.path)) return { ok: false, code: E_PROTECTED_PATH }
    return this.ops(serial).mkdir(dirGate.path, name)
  }

  /** 重命名（同目录改名；不覆盖）。 */
  async rename(serial: string, from: string, newName: string): Promise<{ ok: true } | { ok: false; code: string }> {
    const nameVerdict = checkName(newName)
    if (!nameVerdict.ok) return { ok: false, code: nameVerdict.code }
    const gate = this.gate(from)
    if (!gate.ok) return { ok: false, code: gate.code }
    return this.ops(serial).rename(gate.path, newName)
  }

  /**
   * 批量复制 / 移动（裁决 3 + 4）。
   *
   * 每项的完整目标路径 = 目标目录 + 源的名字。目标目录本身先校验一次
   * （不存在/非法就整批失败得更清楚），但**每项仍然逐项执行**：
   * 目标目录里可能有同名文件，那样只有那一项失败，其余照常。
   *
   * 裁决 6：这里是「同一设备内 cp/mv」，不经过 USB，因此不排队、没有进度 ——
   * 它和「本地→手机」的传输是两条通道，那条走传输队列（见 transfer/service）。
   */
  async copyOrMove(
    serial: string,
    sources: readonly string[],
    dstDir: string | undefined,
    kind: 'copy' | 'move',
  ): Promise<FsOpData> {
    if (dstDir === undefined) {
      // 没有目标目录就什么也做不了：每项都给同一个明确的码，而不是抛错
      return { results: sources.map((source) => ({ name: remoteBaseName(source) || source, ok: false, code: E_INVALID_PATH })) }
    }
    const dstGate = this.gate(dstDir)
    if (!dstGate.ok) {
      return { results: sources.map((source) => ({ name: remoteBaseName(source) || source, ok: false, code: dstGate.code })) }
    }
    const ops = this.ops(serial)

    const results = await runSequential(sources, async (source) => {
      const gate = this.gate(source)
      if (!gate.ok) {
        return { name: remoteBaseName(source) || source, ok: false, code: gate.code }
      }
      /*
       * 【第 2 轮复审：C2 绕过】复制/移动的**来源**也要过系统区判定。
       *
       * 复审实测：fs:copy 能把 /data/local/tmp/secret.txt 复制到 /sdcard/Download
       * （ok:true，cp -a 真的发出去了）—— 这等价于 C2 本来禁止的那条 pull 通道，
       * 「fs 宽松、transfer 严格」的双轨只是把攻击面挪了个位置。
       *
       * 而且「fs 入参来自用户浏览位置」这个理由不成立：OpDialog 的目标目录是
       * 自由文本框，用户可以手输任意路径。所以来源必须与传输通道同一强度。
       *
       * 用 isProtectedTransferPath（精确受保护 + 系统区子树）：
       * /data、/data/local/tmp、/system/* 一律拒；/sdcard/** 不受影响。
       */
      if (isProtectedTransferPath(gate.path)) {
        return { name: remoteBaseName(gate.path) || source, ok: false, code: E_PROTECTED_PATH }
      }
      const name = remoteBaseName(gate.path)
      if (name === '') {
        return { name: source, ok: false, code: E_INVALID_PATH }
      }
      const target = remoteJoin(dstGate.path, name)
      const targetGate = checkRemotePath(target)
      if (!targetGate.ok) return { name, ok: false, code: targetGate.code }
      const outcome = kind === 'copy'
        ? await ops.copy(gate.path, targetGate.path)
        : await ops.move(gate.path, targetGate.path)
      return outcome.ok ? { name, ok: true } : { name, ok: false, code: outcome.code }
    })
    return { results }
  }

  /** 批量复制（同设备内 cp）。与 copyOrMove 同一实现，只是方向固定。 */
  async copy(serial: string, sources: readonly string[], dstDir: string | undefined): Promise<FsOpData> {
    return this.copyOrMove(serial, sources, dstDir, 'copy')
  }

  /** 批量移动（同设备内 mv，目标已存在则该项失败且源保持原样）。 */
  async move(serial: string, sources: readonly string[], dstDir: string | undefined): Promise<FsOpData> {
    return this.copyOrMove(serial, sources, dstDir, 'move')
  }

  /** 走 blockedResults 的便捷包装（保留给需要「先分类再执行」的调用方）。 */
  blocked(items: ReadonlyArray<{ name: string; code: string }>): OpItemResult[] {
    return blockedResults(items)
  }
}

/** 把异常翻成错误码（handler 里的统一出口用）。 */
export function opErrorCode(err: unknown): string {
  return toErrorCode(err)
}

/** 供测试与 handler 复用的受保护判定。 */
export { E_ALREADY_EXISTS, E_PROTECTED_PATH }
