/**
 * 窗口控制（自绘顶栏用）。
 *
 * ===== 为什么单独抽一个模块 =====
 * main.ts 里的这段逻辑如果要测，就得先 import electron —— 而 electron 在主进程
 * 之外（纯 node 测试环境）import 即炸。抽成「只依赖注入的窗口接口」之后，
 * 「没有窗口时不能抛异常」「最大化与还原是同一个按钮」「命令只作用于发起它的窗口」
 * 这些容易写错的地方就有了真门禁（tests/window-controller.test.ts）。
 */

/** 控制器需要的窗口能力子集（BrowserWindow 满足它）。 */
export interface WindowLike {
  minimize(): void
  maximize(): void
  unmaximize(): void
  isMaximized(): boolean
}

export interface WindowController {
  /** 最小化 pick() 选中的窗口。 */
  minimize(): void
  /** 切换最大化；返回切换后的状态（渲染层据此换图标）。 */
  toggleMaximize(): boolean
  isMaximized(): boolean
}

/**
 * 造一个窗口控制器。
 *
 * ===== 为什么 pick 是函数而不是一个窗口实例 ===== 
 * 窗口可能在任意时刻被销毁（退出流程中）。构造时缓存一个实例，
 * 那么它一旦销毁，之后所有调用都会抛 "Object has been destroyed"。
 *
 * ===== 为什么 pick 必须**按调用方**取窗口 ===== 
 * 应用有不止一个窗口（主窗口 + 设置子窗口）。如果一律取 getAllWindows()[0]，
 * 那么在设置窗口里点最小化，最小化的会是主窗口 —— 这是多窗口最容易踩的坑，
 * 而且很难靠肉眼发现（两个窗口同时在屏幕上时才会暴露）。
 * 所以调用方传入 pick（通常是「按 event.sender 反查它的 BrowserWindow」）。
 *
 * pick() 可能返回 undefined（窗口正在销毁、或启动早期还没有窗口）——
 * 那种情况下所有操作都必须是**安全空操作**，不能抛：
 * 用户点最小化时窗口刚好没了，程序不该因此崩掉。
 */
export function createWindowController(pick: () => WindowLike | undefined): WindowController {
  return {
    minimize: () => { pick()?.minimize() },
    toggleMaximize: () => {
      const win = pick()
      if (win === undefined) return false
      // 用 isMaximized 判断而不是自己记状态：用户可能双击标题栏或用系统快捷键，
      // 渲染层那份状态随时会过期。
      if (win.isMaximized()) {
        win.unmaximize()
        return false
      }
      win.maximize()
      return true
    },
    isMaximized: () => pick()?.isMaximized() ?? false,
  }
}

/**
 * 按「发起命令的那个 webContents」取它所属的窗口。
 *
 * 抽成纯函数是为了能测：真实实现要摸 electron 的 webContents → BrowserWindow 映射。
 * findWindow 返回 undefined（窗口已销毁 / 来源不是窗口）时一律按「没有窗口」处理。
 */
export function controllerForSender<TWindow>(
  resolve: () => TWindow | undefined,
  adapt: (window: TWindow) => WindowLike,
): WindowController {
  return createWindowController(() => {
    const window = resolve()
    return window === undefined ? undefined : adapt(window)
  })
}