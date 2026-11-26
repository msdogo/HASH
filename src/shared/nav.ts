/**
 * 页面路由的纯逻辑（R3-1）。
 *
 * 为什么单独抽出来：本工程没有 jsdom，SSR（renderToStaticMarkup）只跑一次 render、
 * 拿不到任何 onClick —— 组件里的事件接线**在渲染期不可观测**（详见 progress.md 的
 * 「已知无门禁清单」）。而 R3-1 的缺陷恰恰全在接线里：
 *   点设备只改 activeSerial、不改 page，于是进了设置页就再也出不来。
 *
 * 把「点完之后去哪一页」这个**决定**收成纯函数后，它就有了可复现的行为门禁；
 * 剩下的「onClick 那一行有没有调它」仍然只能靠 code review（如实登记，不造假断言）。
 *
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块。
 */

/**
 * 互斥页面（主窗口内的三页）。
 *
 * 设置**不在这个集合里**：它是独立的子窗口（见 electron/main.ts 的 openSettingsWindow），
 * 不再是一个可以「切进去」的页面。
 *
 * 为什么改成独立窗口：设置页原本占满整个内容区，用户改完下载路径往往想立刻回文件页
 * 确认，而切页会卸载文件页（滚动位置与选中项虽在 store 里，视觉上仍是「重新进来一次」）。
 * 独立窗口让「改设置」与「看文件」可以同时进行 —— 这正是桌面应用相对网页的固有优势。
 */
export type Page = 'files' | 'overview' | 'apps'

/**
 * 所有主窗口页面（表驱动用例据此遍历）。
 *
 * 放在这里而不是让测试自己列：新增一页时，遍历型用例要能自动覆盖到它。
 */
export const PAGES: readonly Page[] = ['files', 'overview', 'apps']

/**
 * 点顶栏「⚙设置」之后做什么。
 *
 * 设置改成独立窗口之后，这个动作**不再改变当前页** —— 用户仍然停在原来的页面，
 * 只是多了一个窗口。所以返回的是「要不要开设置窗口」，而不是目标页。
 *
 * 为什么仍然保留成纯函数：这条判断以前出过缺陷（写死 setPage('settings')
 * 导致用户出不来），现在它至少可以被断言成「无论在哪一页都不改页面」。
 */
export function settingsClickOpensWindow(current: Page): { page: Page; openWindow: true } {
  // 无论在哪一页，页面本身都不变，只是开（或聚焦）设置窗口
  return { page: current, openWindow: true }
}

/**
 * 顶栏「应用」页签被点之后去哪。
 *
 * 它不是 toggle：应用页没有「必须能出来」的问题（左侧设备栏与其它页签一直在），
 * 所以点它就去应用页。已在应用页再点一次没有副作用。
 */
export function pageAfterAppsClick(current: Page): Page {
  void current
  return 'apps'
}

/**
 * 点左侧设备列表里的某台设备之后去哪。
 *
 * 用户要的是「点设备就回到那台设备上次待的地方」：先回文件页，目录 / 滚动位置
 * 由 fileStore 的按 serial 分片（views[serial]）自动恢复，这里不做任何记忆。
 *
 * 因此目标与「当前在哪一页」**无关**：在应用页点设备必须回文件页。
 * 参数保留是为了让「无关」这件事本身可被测到（三个页面都得到同一个目标）。
 */
export function pageAfterSelectDevice(current: Page): Page {
  void current
  return 'files'
}
