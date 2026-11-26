import type { DeviceSession } from '../../src/shared/types'
import { E_ADB_NOT_FOUND, E_BAD_ARGS, E_DEVICE_OFFLINE, E_NO_SERIAL } from '../../src/shared/errors'
import { isDeviceKey, keyCodeOf, type DeviceKey } from '../../src/shared/device-key'

/**
 * 执行一条 adb 命令所需的最小面（AdbClient 天然满足它）。
 *
 * 只声明用到的那一个方法：服务层不需要知道 client 还有 abort / timeout 之类的细节，
 * 接口越窄，测试里的假 client 就越不会因为 client 加方法而莫名其妙地红。
 */
export interface KeyRunner {
  run(
    args: string[],
    opts: { adbPath: string; timeoutMs: number },
  ): Promise<{ code: number | null; stdout: string; stderr: string }>
}

export interface KeyServiceDeps {
  /** 设备会话表（只读一个 get）。 */
  devices: { get(serial: string): DeviceSession | undefined }
  /** 按 serial 造 client。 */
  clientFor: (serial: string) => KeyRunner
  /** 已解析出的 adb 绝对路径；空串表示还没定位到。 */
  adbPath: () => string
}

/** IPC 层引用的别名（与 capture/apps 的 *Controller 命名保持一致的读法）。 */
export type KeyController = KeyService

export interface KeyService {
  /** 给某台设备发一次按键；失败抛带错误码的 Error（IPC 层收敛成 IpcResult）。 */
  press(serial: string, key: DeviceKey): Promise<void>
}

/**
 * 单条按键命令的超时。
 *
 * `input keyevent` 是设备侧的毫秒级命令；5 秒已经极其宽松 ——
 * 超时只可能是「设备卡死/掉线」，那种情况下等更久也等不到结果。
 */
const KEY_TIMEOUT_MS = 5_000

/**
 * 设备按键服务（P1 第三批：投屏侧边栏的六个按钮）。
 *
 * ===== 安全模型 =====
 * 入参是 **DeviceKey 枚举**，不是字符串、不是数字、不是命令片段。
 * 数字码由 keyCodeOf 在本文件内查表得到 —— 渲染层没有任何途径
 * 把「任意 adb shell 命令」送进来。这是把潜在注入面收成三行查表的关键。
 *
 * ===== 前置顺序为什么是这个次序 =====
 * ① adb 未定位 → 设备表里的状态也不可信（自检都没过），先报这个；
 * ② 会话不存在 → E_NO_SERIAL（不是 E_DEVICE_OFFLINE：后者会让用户
 *    以为设备在、只是掉线了，而实际上是根本没这台设备）；
 * ③ 状态不是 device（offline / unauthorized）→ E_DEVICE_OFFLINE，
 *    文案会引导「检查授权」；
 * ④ 按键名非法 → E_BAD_ARGS，且**不发命令**。
 */
export function createKeyService(deps: KeyServiceDeps): KeyService {
  return {
    async press(serial: string, key: DeviceKey): Promise<void> {
      const adb = deps.adbPath()
      if (adb === '') throw new Error(E_ADB_NOT_FOUND)

      const session = deps.devices.get(serial)
      if (session === undefined) throw new Error(E_NO_SERIAL)
      if (session.status !== 'device') throw new Error(E_DEVICE_OFFLINE)

      if (!isDeviceKey(key)) throw new Error(E_BAD_ARGS)
      const code = keyCodeOf(key)
      if (code === 0) throw new Error(E_BAD_ARGS)

      const result = await deps.clientFor(serial).run(['shell', 'input', 'keyevent', String(code)], {
        adbPath: adb,
        timeoutMs: KEY_TIMEOUT_MS,
      })
      /*
       * 非 0 退出码一律按「设备不可用」处理。
       *
       * 为什么不再细分：input keyevent 失败的唯一现实成因是设备侧拒绝执行
       * （掉线 / 权限 / 正在重启），这几种对用户来说是同一件事 ——
       * 再分几种码只会让每个码的文案都写成「稍后重试」。
       */
      if (result.code !== 0) throw new Error(E_DEVICE_OFFLINE)
    },
  }
}
