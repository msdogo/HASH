import type { ScreenSize } from '../../src/shared/mirror'
import { DEFAULT_SCREEN, parseScreenSize } from '../../src/shared/mirror'

/**
 * 投屏前探测设备屏幕方向。
 *
 * ===== 为什么必须先探（用户的观感问题）=====
 * scrcpy 自己知道设备是横是竖，但它建窗口时先按一个默认尺寸建，拿到首帧后才 resize。
 * 本工程又把那个窗口 SetParent 进了自建窗口 —— 于是用户看到的是：
 *   先出现一个竖窗口 → 画面出来 → 窗口突然变成横的。
 * 那一下跳变观感很差，尤其是遥控器这种「物理上就是横的」设备，每次投屏都要闪一次。
 *
 * 所以建窗口**之前**先问一句设备现在多宽多高，直接按其比例建出正确的窗口。
 *
 * ===== 为什么读 dumpsys window displays 的 cur= =====
 * `wm size` 只给 Physical size（不随旋转变），横屏设备会得到竖的尺寸，等于没探。
 * `dumpsys input` 的 SurfaceOrientation 给 0/1/2/3，还要再配物理尺寸换算，多一层易错。
 * `cur=` 是现成的「当前生效分辨率」，一个正则就够，且同时覆盖横竖两种情形。
 */

/** 执行一条 adb 命令所需的最小面（AdbClient 天然满足它）。 */
export interface OrientationRunner {
  run(
    args: string[],
    opts: { adbPath: string; timeoutMs: number },
  ): Promise<{ code: number | null; stdout: string; stderr: string }>
}

export interface OrientationDeps {
  clientFor: (serial: string) => OrientationRunner
}

/**
 * 探测超时。
 *
 * 实测 dumpsys window displays 在本机约 140ms；
 * 3 秒是「设备卡住但还没掉线」的容忍上限 ——
 * 超时就走回退值，绝不让探测拖住投屏。
 */
const PROBE_TIMEOUT_MS = 3_000

export interface OrientationProbe {
  /**
   * 探测一台设备当前的屏幕尺寸。
   *
   * **永不 reject**：探测失败（adb 报错、输出格式变了、设备卡住）
   * 一律返回 DEFAULT_SCREEN。投屏本身不该因为「问一句方向」而失败 ——
   * 那会把一个观感优化变成新的故障点。
   */
  screenOf: (serial: string, adbPath: string) => Promise<ScreenSize>
}

export function createOrientationProbe(deps: OrientationDeps): OrientationProbe {
  return {
    async screenOf(serial: string, adbPath: string): Promise<ScreenSize> {
      if (adbPath === '') return DEFAULT_SCREEN
      try {
        const result = await deps.clientFor(serial).run(['shell', 'dumpsys', 'window', 'displays'], {
          adbPath,
          timeoutMs: PROBE_TIMEOUT_MS,
        })
        if (result.code !== 0) return DEFAULT_SCREEN
        return parseScreenSize(result.stdout) ?? DEFAULT_SCREEN
      } catch {
        /*
         * 超时 / 设备掉线 / client 抛错：全部走回退。
         * 刻意不区分原因 —— 调用方（mirrorService.start）对它们要做的事完全一样，
         * 而把错误码传出去只会诱使上层加「探测失败就别投屏」的错误逻辑。
         */
        return DEFAULT_SCREEN
      }
    },
  }
}
