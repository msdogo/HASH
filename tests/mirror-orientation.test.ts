import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MAX_SIZE,
  DEFAULT_SCREEN,
  parseScreenSize,
  videoSizeFor,
} from '../src/shared/mirror'
import { createOrientationProbe, type OrientationRunner } from '../electron/mirror/orientation'

/**
 * 投屏前「先问方向」的门禁。
 *
 * ===== 这一组用例在锁什么 =====
 * 用户报的观感问题是「点投屏先出现竖窗口，然后突然变横」。
 * 根因是窗口尺寸写死 480×900，与设备方向无关。
 * 修法是建窗口**之前**先探一次屏幕尺寸。这组用例锁三件事：
 *   1. 解析器认 cur=（当前生效分辨率），不认 init= / Physical size（不随旋转变）；
 *   2. 视频尺寸按 scrcpy 的 --max-size 语义（长边缩到 maxSize）；
 *   3. 探测失败**永不 reject**，一律回退 DEFAULT_SCREEN ——
 *      观感优化不能变成新的故障点。
 */

describe('parseScreenSize', () => {
  it('横屏设备：认 cur= 而不是 init=（遥控器实战值）', () => {
    // 实测 DJI RC Plus 2：物理 1200x1920，横过来后 cur=1920x1200
    const stdout = '    init=1200x1920 400dpi cur=1920x1200 app=1920x1160 rng=1200x1040-1920x1760\r\n'
    expect(parseScreenSize(stdout)).toEqual({ width: 1920, height: 1200 })
  })

  it('竖屏设备：横竖两值相同时照样解析（MI 6 实战值）', () => {
    const stdout = '    init=1080x1920 480dpi cur=1080x1920 app=1080x1920\r\n'
    expect(parseScreenSize(stdout)).toEqual({ width: 1080, height: 1920 })
  })

  it('多显示器：取第一个 cur=（主屏排在前面）', () => {
    const stdout = 'DisplayDeviceInfo{ cur=1920x1200 }\nDisplayDeviceInfo{ cur=800x1280 }\n'
    expect(parseScreenSize(stdout)).toEqual({ width: 1920, height: 1200 })
  })

  it('输出里没有 cur= → null（调用方回退默认值）', () => {
    expect(parseScreenSize('Physical size: 1080x1920')).toBeNull()
    expect(parseScreenSize('')).toBeNull()
  })

  it('退化数值（0 或非数字）→ null，绝不返回 0 宽高', () => {
    // 0 宽高会让窗口算出 0×0 —— 用户会以为程序没启动
    expect(parseScreenSize('cur=0x1920')).toBeNull()
    expect(parseScreenSize('cur=1920x0')).toBeNull()
  })
})

describe('videoSizeFor', () => {
  it('横屏 1920x1200 → 1024x640（与生产实测的 scrcpy 子窗口尺寸一致）', () => {
    expect(videoSizeFor({ width: 1920, height: 1200 }, DEFAULT_MAX_SIZE)).toEqual({
      width: 1024,
      height: 640,
    })
  })

  it('竖屏 1080x1920 → 576x1024（长边缩到 maxSize）', () => {
    expect(videoSizeFor({ width: 1080, height: 1920 }, DEFAULT_MAX_SIZE)).toEqual({
      width: 576,
      height: 1024,
    })
  })

  it('短边按比例，长边精确等于 maxSize', () => {
    const v = videoSizeFor({ width: 1920, height: 1200 }, DEFAULT_MAX_SIZE)
    expect(Math.max(v.width, v.height)).toBe(DEFAULT_MAX_SIZE)
  })

  it('设备分辨率比 maxSize 小时**不放大**（放大只多传像素，画面不会更清楚）', () => {
    expect(videoSizeFor({ width: 640, height: 480 }, DEFAULT_MAX_SIZE)).toEqual({
      width: 640,
      height: 480,
    })
  })

  it('退化输入返回 0 尺寸（由调用方的 windowFitSize 兜底成能用的默认值）', () => {
    expect(videoSizeFor({ width: 0, height: 0 }, DEFAULT_MAX_SIZE)).toEqual({ width: 0, height: 0 })
  })
})

describe('createOrientationProbe', () => {
  /** 假 runner：记录入参，可指定 stdout / 退出码 / 是否抛错。 */
  function fakeRunner(reply: {
    code?: number | null
    stdout?: string
    throws?: boolean
  }): { runner: OrientationRunner; calls: string[][] } {
    const calls: string[][] = []
    const runner: OrientationRunner = {
      async run(args) {
        calls.push(args)
        if (reply.throws === true) throw new Error('E_TIMEOUT')
        return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: '' }
      },
    }
    return { runner, calls }
  }

  const probeOf = (runner: OrientationRunner) => createOrientationProbe({ clientFor: () => runner })

  it('探测成功：返回设备的当前分辨率', async () => {
    const { runner, calls } = fakeRunner({ stdout: '    init=1200x1920 400dpi cur=1920x1200 app=...' })
    const screen = await probeOf(runner).screenOf('S1', 'C:\\pt\\adb.exe')
    expect(screen).toEqual({ width: 1920, height: 1200 })
    // 必须是 dumpsys window displays（只有它同时给横竖两种情形）
    expect(calls[0]).toEqual(['shell', 'dumpsys', 'window', 'displays'])
  })

  it('adb 未定位（空路径）→ 回退默认值，且**不发命令**', async () => {
    const { runner, calls } = fakeRunner({ stdout: 'cur=1920x1200' })
    const screen = await probeOf(runner).screenOf('S1', '')
    expect(screen).toEqual(DEFAULT_SCREEN)
    expect(calls).toHaveLength(0)
  })

  it('命令非 0 退出 → 回退默认值（不抛）', async () => {
    const { runner } = fakeRunner({ code: 1, stdout: 'cur=1920x1200' })
    expect(await probeOf(runner).screenOf('S1', 'adb')).toEqual(DEFAULT_SCREEN)
  })

  it('输出解析不出 cur= → 回退默认值', async () => {
    const { runner } = fakeRunner({ stdout: 'error: no devices' })
    expect(await probeOf(runner).screenOf('S1', 'adb')).toEqual(DEFAULT_SCREEN)
  })

  it('runner 抛错（超时/掉线）→ 回退默认值，绝不 reject', async () => {
    // 这条是红线：观感优化不能变成新的故障点
    const { runner } = fakeRunner({ throws: true })
    await expect(probeOf(runner).screenOf('S1', 'adb')).resolves.toEqual(DEFAULT_SCREEN)
  })
})
