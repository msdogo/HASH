import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LocalFs } from '../electron/fs/local'

/*
 * R10：本地预检的真读写证明（不是 mock）。
 *
 * 为什么必须用真实临时目录：这里要证明的是「真的去 stat 了、真的把字节数读对了」。
 * mock 掉 fs 就等于把被测的东西测掉了（与 tests/local.test.ts 同一理由）。
 */

let base = ''
let downloadDir = ''
let fs: LocalFs

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'adbfm-file-stat-')))
  downloadDir = path.join(base, 'Downloads')
  mkdirSync(path.join(downloadDir, '一个目录'), { recursive: true })
  writeFileSync(path.join(downloadDir, 'same.bin'), Buffer.alloc(100))
  writeFileSync(path.join(downloadDir, 'other.bin'), Buffer.alloc(200))
  writeFileSync(path.join(downloadDir, 'empty.bin'), '')
  /*
   * 下载目录的**父目录**里放一个同名文件：这是 checkName 闸门的唯一真实证据。
   * 没有它时，'../same.bin' 拼出来指向一个不存在的路径，去掉 checkName 也返回
   * exists:false —— 用例照样绿，闸门等于没测（变异 M10 实测抓到的就是这个）。
   * 放一个真实存在且大小不同的同名文件后，去掉 checkName 就会读到它 → 用例红。
   */
  writeFileSync(path.join(base, 'same.bin'), Buffer.alloc(777))
  /*
   * 目录都建好之后换成 realpath 规范形：Windows 的临时目录是 8.3 短名，
   * 而被测实现返回的是 realpath 之后的值（判定路径 = 执行路径）。
   */
  downloadDir = realpathSync.native(downloadDir)
  fs = new LocalFs({ startDir: () => base })
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('R10 local:file-stat 的本地实现（真读写）', () => {
  it('同名文件存在 → exists:true 且 size 是真字节数', async () => {
    const stat = await fs.fileStat(downloadDir, 'same.bin')
    expect(stat).toEqual({ exists: true, size: 100 })
  })

  it('大小不同的同名文件 → 读到的是它自己的大小（不是被下载的那个）', async () => {
    const stat = await fs.fileStat(downloadDir, 'other.bin')
    expect(stat).toEqual({ exists: true, size: 200 })
  })

  it('0 字节文件也是 exists:true（存在性是存在性，0 不代表「没有」）', async () => {
    const stat = await fs.fileStat(downloadDir, 'empty.bin')
    expect(stat).toEqual({ exists: true, size: 0 })
  })

  it('文件不存在 → exists:false（不是抛错）', async () => {
    const stat = await fs.fileStat(downloadDir, 'nope.bin')
    expect(stat).toEqual({ exists: false })
  })

  it('目录不存在（下载路径被删）→ exists:false，不抛错', async () => {
    const stat = await fs.fileStat(path.join(base, 'gone'), 'same.bin')
    expect(stat).toEqual({ exists: false })
  })

  it('同名目标是**目录** → exists:false（只认普通文件，让传输层去报它自己的错）', async () => {
    const stat = await fs.fileStat(downloadDir, '一个目录')
    expect(stat).toEqual({ exists: false })
  })

  it('非法名字（含分隔符 / .. / 空 / 首尾空白）→ exists:false，绝不上跳或抛错', async () => {
    /*
     * '../same.bin' 是这条用例的**关键一行**：父目录里真的有一个同名的 777 字节文件。
     * 若实现不做名字闸门而直接 path.join，它就会读到那个文件（exists:true, size:777），
     * 于是「查一个下载目录里的名字」变成了「查下载目录外面」。
     */
    for (const bad of ['../same.bin', 'a/b', '..', '.', '', ' same.bin', 'same.bin ']) {
      const stat = await fs.fileStat(downloadDir, bad)
      expect(stat, bad).toEqual({ exists: false })
    }
  })

  it('对照：父目录那个同名文件本身是查得到的（证明上一条不是假绿）', async () => {
    const parent = path.dirname(downloadDir)
    const stat = await fs.fileStat(parent, 'same.bin')
    expect(stat).toEqual({ exists: true, size: 777 })
  })

  it('目录路径不合法（相对路径 / 空串）→ exists:false，不抛错', async () => {
    for (const bad of ['', 'relative/dir', 'C:relative']) {
      const stat = await fs.fileStat(bad, 'same.bin')
      expect(stat, bad).toEqual({ exists: false })
    }
  })
})
