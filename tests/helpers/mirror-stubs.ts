import type { KeyService } from '../../electron/device/keys'
import type { MirrorService } from '../../electron/mirror/service'
import type { DeviceKey } from '../../src/shared/device-key'
import { DEFAULT_SCREEN, type MirrorSession } from '../../src/shared/mirror'

/**
 * HandlerDeps 里「按键 + 投屏」三项的测试替身。
 *
 * ===== 为什么单独抽成一个 spread =====
 * registerHandlers 的依赖是**必填**的：这样生产代码（electron/main.ts）漏接一个
 * 就编译失败 —— 这正是我们要的护栏。代价是每个只关心别的通道的 IPC 测试
 * 都要补三项。把这三项收成一次 `...stubMirrorDeps()`，那些测试的正文就不会
 * 被无关的样板淹没，同时仍然是一份显式依赖（不是靠「可选属性」悄悄放行）。
 */
export function stubMirrorDeps(): {
  keys: KeyService
  mirror: MirrorService
  emitMirror: () => void
} {
  const keys: KeyService = {
    press: async (_serial: string, _key: DeviceKey): Promise<void> => undefined,
  }
  const mirror: MirrorService = {
    start: async (serial: string): Promise<MirrorSession> => ({
      serial,
      pid: undefined,
      startedAt: 0,
      token: 'stub',
      source: 'bundled',
      version: '0.0.0',
      title: 'stub',
      screen: DEFAULT_SCREEN,
    }),
    stop: async (): Promise<void> => undefined,
    list: (): MirrorSession[] => [],
    onDeviceChanged: async (): Promise<void> => undefined,
    dispose: async (): Promise<void> => undefined,
  }
  return { keys, mirror, emitMirror: (): void => undefined }
}
