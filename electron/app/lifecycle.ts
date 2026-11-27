/**
 * 进程生命周期里的纯判定（可测）。
 *
 * ===== 为什么单独抽一个模块 =====
 * 这里的每一条都是「看起来显然、实际写错过」的地方：
 *   - 没拿到单实例锁却继续启动 → 第二个实例先画出窗口再退出，用户看到「闪一下」；
 *   - 关闭按钮直接 close() → 进程真的退出，正在传输的文件变成残片；
 *   - 托盘点击时窗口是 hide 状态，只 focus() 不 show() → 点了托盘什么都没出现。
 * 放进 main.ts 就只能靠肉眼回归（main.ts import electron，纯 node 测试环境 import 即炸）。
 * 抽成不依赖 electron 的纯函数后，这三条都有真门禁（tests/window-lifecycle.test.ts）。
 */

export interface RestorableWindow {
  isMinimized(): boolean
  isVisible(): boolean
  restore(): void
  show(): void
  focus(): void
}

/**
 * 是否允许继续启动。
 *
 * app.quit() 只是**发起**退出，它不会中断当前模块的同步执行：
 * 之后 app.whenReady() 的回调照样会跑。修前正是如此 —— 第二个实例被拒绝后
 * 仍然 createWindow()，窗口先画出来再随进程一起消失，用户看到的就是「闪一下」。
 * 正常应用第二次双击图标应该**毫无反应**，所以拿到锁才建窗口、才起托盘。
 */
export function mayStartApp(gotLock: boolean): boolean {
  return gotLock
}

/**
 * 启动闸门：两道锁都通过才允许继续。
 *
 * ===== 为什么需要第二道 =====
 * Electron 的 requestSingleInstanceLock 把互斥体绑在 userData 目录上，
 * 换一个 --user-data-dir 启动就绕过它了（实测两个实例同时在跑，任务栏 4 个图标）。
 * 第二道锁是命名互斥体，与 userData 无关，见 app/instance-lock.ts。
 *
 * ===== 为什么是 fail-open =====
 * globalLock 为 null 表示「探测失败」（非 Windows / koffi 加载不出来）。
 * 把它当 false 会让应用在任何探测异常下都打不开，且用户看不到任何原因；
 * 多开一个实例的代价远小于「双击没反应」，所以失败一律放行。
 *
 * ===== 为什么有 allowMultiInstance =====
 * 联调时经常要「已装正式版开着 + 再跑一份构建产物」，两者共用同一个桌面会话，
 * 第二道锁会把联调实例直接挡死（spike 文档里踩过：开发实例被静默退出）。
 * 环境变量 ADB_FM_ALLOW_MULTI_INSTANCE=1 时只跳过第二道，Electron 的锁仍然有效。
 */
export function decideStartup(input: {
  electronLock: boolean
  globalLock: boolean | null
  allowMultiInstance: boolean
}): boolean {
  if (!input.electronLock) return false
  if (input.allowMultiInstance) return true
  // null = 探测失败 → 放行（fail-open）
  return input.globalLock !== false
}

/**
 * 主窗口收到 close 时该做什么。
 *
 * 'background' = 退到后台：窗口最小化，任务栏图标保留，进程与 adb 连接继续。
 * 'close'      = 真正关闭（只有托盘「退出」会走到）。
 *
 * ===== 为什么是 minimize 而不是 hide ===== 
 * hide() 会把窗口从任务栏里摘掉 —— 用户要的恰恰是「退到后台后，系统底部的
 * 应用图标还在」，点它就能回来。minimize() 天然满足：窗口不再挡在屏幕上，
 * 任务栏按钮保留，点击即还原。hide() 只能靠托盘找回，发现成本高得多。
 *
 * 用 function 而不是常量是因为它必须调用时求值：退出流程里 isQuitting 会变。
 */
export function closeOutcome(isQuitting: boolean): 'background' | 'close' {
  return isQuitting ? 'close' : 'background'
}

/**
 * 把主窗口从「最小化 / 隐藏」恢复成用户看得见的样子。
 *
 * 三条都要写：hide() 出来的窗口 isVisible() 为 false 但 isMinimized() 也为 false，
 * 只 restore() 不会有任何效果 —— 这正是「点托盘没反应」的成因。
 * 返回 false 表示根本没有窗口（启动早期 / 已经销毁），调用方据此决定是否重建。
 */
export function restoreMainWindow(win: RestorableWindow | undefined): boolean {
  if (win === undefined) return false
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  return true
}
