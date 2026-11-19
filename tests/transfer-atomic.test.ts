import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  PART_SUFFIX,
  cleanupPartFile,
  isPartPath,
  makePartPath,
  promotePartFile,
} from '../electron/transfer/atomic'

/*
 * 审查 I2：取消/中断销毁旧文件是**数据丢失级**缺陷。
 *
 * 复审系统级实测：中断 push 后设备留 155903007 字节同名截断文件；
 * pull 后本地留 183609456/314572800。更严重的是覆盖场景下**旧文件已被截断**
 * —— 取消 = 既没传完、又把原有文件毁了。
 *
 * 修法：先写临时名（xxx.adbfm-part），成功后再原子改名为目标名。
 * 失败/取消时删临时文件，目标文件保持原样。
 */

const dirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'task8-atomic-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function md5(file: string): string {
  return createHash('md5').update(readFileSync(file)).digest('hex')
}

describe('临时文件命名', () => {
  it('PART_SUFFIX 固定且能被 isPartPath 识别', () => {
    expect(PART_SUFFIX).toBe('.adbfm-part')
    const part = makePartPath('/sdcard/Download/中文 文件.bin')
    expect(part).toBe('/sdcard/Download/中文 文件.bin.adbfm-part')
    expect(isPartPath(part)).toBe(true)
    expect(isPartPath('/sdcard/Download/中文 文件.bin')).toBe(false)
  })

  it('Windows 本地路径也保留扩展名不动（只在末尾追加）', () => {
    expect(makePartPath('C:\\Downloads\\a.bin')).toBe('C:\\Downloads\\a.bin.adbfm-part')
  })
})

describe('promotePartFile：原子改名', () => {
  it('成功后目标存在、临时文件消失', () => {
    const dir = tmpDir()
    const target = path.join(dir, 'a.bin')
    const part = makePartPath(target)
    writeFileSync(part, 'hello')
    promotePartFile(part, target)
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('hello')
    expect(existsSync(part)).toBe(false)
  })

  it('覆盖已存在的目标：旧内容被新内容替换（这是成功的覆盖，不是意外）', () => {
    const dir = tmpDir()
    const target = path.join(dir, 'a.bin')
    writeFileSync(target, 'OLD')
    const part = makePartPath(target)
    writeFileSync(part, 'NEW')
    promotePartFile(part, target)
    expect(readFileSync(target, 'utf8')).toBe('NEW')
  })
})

describe('cleanupPartFile：取消/失败时只删临时文件', () => {
  it('删掉临时文件，且绝不碰目标文件（I2 的核心不变量）', () => {
    const dir = tmpDir()
    const target = path.join(dir, 'old.bin')
    writeFileSync(target, 'PRECIOUS')
    const before = md5(target)
    const part = makePartPath(target)
    writeFileSync(part, 'half-written-garbage')

    cleanupPartFile(part)

    expect(existsSync(part)).toBe(false)
    // 取消后旧文件必须逐字节与取消前一致
    expect(existsSync(target)).toBe(true)
    expect(md5(target)).toBe(before)
    expect(readFileSync(target, 'utf8')).toBe('PRECIOUS')
  })

  it('临时文件不存在时也不抛错（重复清理、路径不存在）', () => {
    const dir = tmpDir()
    expect(() => cleanupPartFile(path.join(dir, 'nope.adbfm-part'))).not.toThrow()
  })
})
