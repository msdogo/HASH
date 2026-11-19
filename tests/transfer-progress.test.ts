import { describe, it, expect } from 'vitest'
import {
  PROGRESS_MIN_INTERVAL_MS,
  PROGRESS_MIN_PERCENT_STEP,
  ProgressGate,
  formatBytes,
  parseProgressTicks,
  parseTransferSummary,
  progressView,
} from '../src/shared/transfer'

/*
 * ===== 裁决 1：真机原始字节（不是想象出来的格式）=====
 *
 * 采集环境：adb 1.0.41 (35.0.2-12147458)，DJI RC Plus 2 (rc701)，Windows 11，
 * 采集方式：`adb -s <serial> push ... > out.bin 2> err.bin`，对 err.bin 做 od -c。
 *
 * 结论先行（推翻了简报的假设）：
 *   1. 进度【不在 stdout】，而在 **stderr**；
 *   2. 全程 **没有任何百分比行**，连 \r 覆盖刷新的进度行都没有；
 *   3. 整个传输只有传输结束时的 **一行汇总**，以 \r\n 结尾
 *      （\r 是 adb 自己写的，Windows 上 adb 不把它翻成 \r\n 的 \n，实测是 \r\n 两字节）；
 *   4. 因此「按百分比推送进度」在 adb 1.0.41 上根本不可能 —— 进度只能靠轮询目标文件大小。
 * adb.exe 里确实存在 "[%3d%%]" 这个格式串，但实测（含 400MB 不可压缩文件、14.8s 传输、
 * push/pull 两个方向、带/不带 -p）它一次都没输出过，所以下面把它当【兼容路径】而不是主路径。
 */

/** 真机 push 50MB 的 stderr 原始字节（77 字节）。 */
const REAL_PUSH_50M = 'big-50m.bin: 1 file pushed, 0 skipped. 25.1 MB/s (52428800 bytes in 1.992s)\r\n'

/** 真机 push 400MB 不可压缩文件的 stderr 原始字节（80 字节，14.835s，仍然只有汇总行）。 */
const REAL_PUSH_400M = 'big-400r.bin: 1 file pushed, 0 skipped. 27.0 MB/s (419430400 bytes in 14.835s)\r\n'

/** 真机 pull 400MB 的 stderr 原始字节（100 字节；注意带着完整的远程路径）。 */
const REAL_PULL_400M = '/sdcard/Download/adb-fm-bigr.bin: 1 file pulled, 0 skipped. 34.2 MB/s (419430400 bytes in 11.694s)\r\n'

/** 真机一次 push 两个文件：每文件一行 + 一行总计（均以 \r\n 结尾）。 */
const REAL_PUSH_MULTI =
  'a.txt: 1 file pushed, 0 skipped. 0.0 MB/s (1 bytes in 0.000s)\r\n' +
  'b.txt: 1 file pushed, 0 skipped. 0.0 MB/s (2 bytes in 0.000s)\r\n' +
  '2 files pushed, 0 skipped. 0.0 MB/s (3 bytes in 0.046s)\r\n'

/** 真机 pull 一个不存在的文件时的原始错误（同样在 stderr，且以 \r\n 结尾）。 */
const REAL_PULL_MISSING =
  "adb: error: failed to stat remote object '/sdcard/Download/nope-xyz.bin': No such file or directory\r\n"

describe('裁决 1：adb 传输汇总行解析（真机字节离线回归）', () => {
  it('解析 push 汇总行：文件名、字节数、耗时、方向', () => {
    const summary = parseTransferSummary(REAL_PUSH_50M)
    expect(summary).not.toBeNull()
    expect(summary?.direction).toBe('push')
    expect(summary?.bytes).toBe(52428800)
    expect(summary?.seconds).toBeCloseTo(1.992, 3)
    expect(summary?.skipped).toBe(0)
    expect(summary?.files[0]?.name).toBe('big-50m.bin')
  })

  it('解析 pull 汇总行：名字里带完整远程路径也认得', () => {
    const summary = parseTransferSummary(REAL_PULL_400M)
    expect(summary?.direction).toBe('pull')
    expect(summary?.bytes).toBe(419430400)
    expect(summary?.files[0]?.name).toBe('/sdcard/Download/adb-fm-bigr.bin')
  })

  it('多文件 push：单文件行与总计行都解析出来，总计只算总计行', () => {
    const summary = parseTransferSummary(REAL_PUSH_MULTI)
    expect(summary?.files.map((f) => f.name)).toEqual(['a.txt', 'b.txt'])
    expect(summary?.files.length).toBe(2)
    // 汇总行的字节数取【总计行】的 3，而不是最后一条单文件行的 2
    expect(summary?.bytes).toBe(3)
    expect(summary?.direction).toBe('push')
  })

  it('真实错误输出里没有汇总行 → null（由调用方按退出码判失败）', () => {
    expect(parseTransferSummary(REAL_PULL_MISSING)).toBeNull()
  })

  it('\r\n 行尾被正确切分（不能把 \r 留在数字里）', () => {
    const summary = parseTransferSummary(REAL_PUSH_400M)
    expect(summary?.seconds).toBeCloseTo(14.835, 3)
    expect(summary?.bytes).toBe(419430400)
  })

  it('空输入与垃圾输入不抛错', () => {
    expect(parseTransferSummary('')).toBeNull()
    expect(parseTransferSummary('random noise')).toBeNull()
  })
})

describe('裁决 1：百分比进度行（兼容路径，真机未观察到）', () => {
  /*
   * adb.exe 里存在 "[%3d%%]" 格式串，某些打包版本/平台确实会按百分比刷新。
   * 这条路径【不是】本机实测格式（实测只有汇总行），保留它只是为了在别的 adb 版本上
   * 不至于完全看不懂输出；生产的主进度通道是轮询（见 runner）。
   */
  it('同一行内用 \r 覆盖的多条进度只取每段', () => {
    const raw = '[ 10%] /sdcard/a.bin\r[ 45%] /sdcard/a.bin\r[100%] /sdcard/a.bin'
    expect(parseProgressTicks(raw)).toEqual([10, 45, 100])
  })

  it('没有百分比行时返回空数组（真机情形，必须不抛错）', () => {
    expect(parseProgressTicks(REAL_PUSH_400M)).toEqual([])
  })

  it('接受带空格对齐的写法', () => {
    expect(parseProgressTicks('[  5%] x')).toEqual([5])
    expect(parseProgressTicks('[5%] x')).toEqual([5])
  })
})

describe('裁决 5：进度展示态（已知 / 未知 / 超大）', () => {
  it('totalBytes 已知 → 确定态百分比', () => {
    expect(progressView(50, 200)).toEqual({ kind: 'determinate', percent: 25 })
  })

  it('totalBytes 未知（null）→ 不确定态，既不是 0% 也不是 100%', () => {
    expect(progressView(12345, null)).toEqual({ kind: 'indeterminate' })
    expect(progressView(0, null)).toEqual({ kind: 'indeterminate' })
  })

  it('totalBytes 为 0 / 负数 / NaN → 不确定态（不产生 0% 或 Infinity）', () => {
    expect(progressView(0, 0)).toEqual({ kind: 'indeterminate' })
    expect(progressView(5, -1)).toEqual({ kind: 'indeterminate' })
    expect(progressView(5, Number.NaN)).toEqual({ kind: 'indeterminate' })
  })

  it('超过 JS 安全整数的超大文件 → 降级为不确定态（不做会溢出的算术）', () => {
    const huge = Number.MAX_SAFE_INTEGER + 2
    expect(progressView(10, huge)).toEqual({ kind: 'indeterminate' })
  })

  it('百分比被夹在 0..100（轮询可能读到超过总长的瞬时值）', () => {
    expect(progressView(300, 100)).toEqual({ kind: 'determinate', percent: 100 })
    expect(progressView(-5, 100)).toEqual({ kind: 'determinate', percent: 0 })
  })

  it('2GB 以上的已知大小仍然是确定态（number 足够，JS 安全整数到 9PB）', () => {
    const gb3 = 3 * 1024 * 1024 * 1024
    expect(progressView(gb3 / 2, gb3)).toEqual({ kind: 'determinate', percent: 50 })
  })
})

describe('裁决 6：进度推送闸门', () => {
  it('默认阈值：≥100ms 且 ≥1%', () => {
    expect(PROGRESS_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(100)
    expect(PROGRESS_MIN_PERCENT_STEP).toBe(1)
  })

  it('密集输入（1ms 一次、每次 +1%）时推送次数被压到每秒 ~10 次以内', () => {
    const gate = new ProgressGate()
    let accepted = 0
    for (let t = 0; t < 1000; t++) {
      if (gate.accept(t / 10, t)) accepted += 1
    }
    // 1000 次输入 / 100ms 窗口 → 理论上限 10 次，允许 11 次（含 t=0 那次）
    expect(accepted).toBeLessThanOrEqual(11)
    expect(accepted).toBeGreaterThanOrEqual(9)
  })

  it('进度几乎不动时不刷屏（1% 步长以下不推）', () => {
    const gate = new ProgressGate()
    expect(gate.accept(0.1, 0)).toBe(true)
    expect(gate.accept(0.2, 500)).toBe(false)
    expect(gate.accept(0.3, 900)).toBe(false)
  })

  it('间隔足够但进度没动 → 不推（避免空转事件）', () => {
    const gate = new ProgressGate()
    expect(gate.accept(10, 0)).toBe(true)
    expect(gate.accept(10, 5000)).toBe(false)
  })

  it('进度到达 100 时一定推（终态不能让界面停在 99%）', () => {
    const gate = new ProgressGate()
    expect(gate.accept(99, 0)).toBe(true)
    expect(gate.accept(99.2, 10)).toBe(false)
    // 即使间隔不足，100% 也必须过闸
    expect(gate.accept(100, 20)).toBe(true)
  })

  it('不确定态（null）只在首次推送（之后不重复刷）', () => {
    const gate = new ProgressGate()
    expect(gate.accept(null, 0)).toBe(true)
    expect(gate.accept(null, 500)).toBe(false)
  })
})

describe('字节格式化', () => {
  it('常见量级', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(52428800)).toBe('50.0 MB')
  })

  it('未知/非法输入给占位而不是 NaN', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
  })
})
