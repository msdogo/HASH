import { describe, it, expect, afterEach } from 'vitest'
import { adbChildCount } from '../electron/adb/children'
import { startScrcpy } from '../electron/mirror/runner'

/**
 * 投屏子进程必须进**全局跟踪集合**。
 *
 * ===== 为什么这条是红线而不是形式主义 =====
 * 应用退出的清理由 `shutdownChildren()` 兜底（electron/adb/children.ts），
 * 它只杀 `live` 集合里的进程。如果 scrcpy 走了裸 `spawn` 而不是 `spawnTracked`，
 * 那么「关掉整个应用」之后任务管理器里就会留下 scrcpy.exe ——
 * 它仍占着 ADB 通道，下次投屏会表现为「设备连上了但画面不出来」，
 * 而且用户完全看不出是上一次的残留。
 *
 * 这里用一个**无害的替身进程**（node 自己 sleep）验证跟踪语义，
 * 不依赖真设备：跟踪与否和进程是什么无关。
 */
describe('scrcpy 子进程进全局跟踪集合', () => {
  const started: Array<{ kill: () => Promise<void> }> = []

  afterEach(async () => {
    for (const h of started.splice(0)) {
      try {
        await h.kill()
      } catch {
        // 已退出
      }
    }
  })

  it('startScrcpy 起的进程计入 adbChildCount，kill 后清零', async () => {
    const before = adbChildCount()

    /*
     * 用 node 自己当替身：起一个「睡 60 秒」的脚本。
     *
     * 标记必须**唯一**：tests/children-shutdown.test.ts 会扫 wmic 里所有
     * 带 'setTimeout' 字样的 node 进程来断言「系统层面没有残留」。
     * 如果这里也用 setTimeout，那条用例会数到本文件起的替身进程而误报
     * （实测踩过：整个套件 1 failed，单跑该文件却通过）。
     * 换一个不可能与它撞车的标记，两个文件就能共存。
     */
    const handle = startScrcpy({
      scrcpyPath: process.execPath,
      adbPath: 'C:\\adb.exe',
      args: ['-e', 'setInterval(function adbfmMirrorTrackingProbe() {}, 60000)'],
    })
    expect(handle).not.toBeNull()
    if (handle === null) return
    started.push(handle)

    expect(adbChildCount()).toBe(before + 1)

    await handle.kill()
    // killTree 是异步的；等它把集合里的登记摘掉
    for (let i = 0; i < 40 && adbChildCount() > before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(adbChildCount()).toBe(before)
  }, 30_000)
})
