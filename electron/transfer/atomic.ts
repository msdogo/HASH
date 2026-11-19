import { renameSync, rmSync, existsSync } from 'node:fs'

/**
 * 原子落盘（审查 I2）。
 *
 * ===== 为什么必须有这一层 =====
 * 复审系统级实测推翻了首版报告的结论：adb 中断会留下同名截断文件
 * （设备侧 155903007 字节、本地侧 183609456/314572800），并不是「adb 自己会清干净」。
 * 更严重的是覆盖场景：adb 会先截断目标再写，所以「取消一个覆盖传输」=
 * 既没传完、又把原有文件毁了 —— 这是数据丢失级缺陷，比进度显示问题严重得多。
 *
 * 修法：先写临时名，成功后原子改名。
 *   - push：adb push 源 目标.adbfm-part → 成功后 adb shell mv 到目标
 *   - pull：adb pull 源 目标.adbfm-part → 成功后 fs.renameSync 到目标
 * 失败或取消时只删临时文件，目标文件从头到尾没被碰过。
 *
 * 这不违反裁决 8（不做断点续传）：临时文件是一次性的，从不被续写。
 */

/** 临时文件后缀。固定值，便于诊断与清理残留。 */
export const PART_SUFFIX = '.adbfm-part'

/** 由目标路径算出临时路径（只在末尾追加，不动扩展名）。 */
export function makePartPath(targetPath: string): string {
  return targetPath + PART_SUFFIX
}

/** 该路径是否是本模块的临时文件。 */
export function isPartPath(targetPath: string): boolean {
  return targetPath.endsWith(PART_SUFFIX)
}

/**
 * 把临时文件原子改名为目标文件（本地侧）。
 *
 * rename 在同一文件系统上是原子的：要么完全没发生，要么一次性生效，
 * 不存在「目标被截断但内容只写了一半」的中间态。
 */
export function promotePartFile(partPath: string, targetPath: string): void {
  try {
    renameSync(partPath, targetPath)
    return
  } catch (err) {
    // Windows 上偶发 EPERM/EEXIST（目标被占用或已存在）：删掉目标再试一次。
    // 顺序很重要：先确认临时文件还在再删目标 —— 否则临时文件丢了、目标又被删，
    // 才是真的把用户数据弄没了。
    if (!existsSync(partPath)) throw err
    rmSync(targetPath, { force: true })
    renameSync(partPath, targetPath)
  }
}

/**
 * 清理临时文件（取消/失败路径）。
 *
 * 红线：只删临时文件，绝不碰目标文件。哪怕目标看起来是本任务写的也不能删 ——
 * 覆盖场景下目标就是用户的原文件，删了就真没了。
 * 临时文件本来就不存在时静默返回（重复清理、竞态删除都是正常的）。
 */
export function cleanupPartFile(partPath: string): void {
  if (!isPartPath(partPath)) return
  try {
    rmSync(partPath, { force: true })
  } catch {
    // 清理失败不该让取消流程再抛一次错：用户要的是「停下」。
    // 残留的 .adbfm-part 带上固定后缀，既会被下次传输覆盖，也能被人工识别。
  }
}
