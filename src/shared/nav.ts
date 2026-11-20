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

/** 三个互斥页面。设置页是后来新增的第三页（R2-2）。 */
export type Page = 'files' | 'overview' | 'settings'

/**
 * 点顶栏「⚙设置」之后去哪。
 *
 * 规格：设置在设置页时要能**出来**，所以它是 toggle ——
 * 已在设置页再点一次回文件页，否则进设置页。
 * 修前写死 setPage('settings')，用户唯一的出路是去点「当前设备」页签，
 * 那不是习惯动作（用户实测反馈）。
 */
export function pageAfterSettingsClick(current: Page): Page {
  return current === 'settings' ? 'files' : 'settings'
}

/**
 * 点左侧设备列表里的某台设备之后去哪。
 *
 * 用户要的是「点设备就回到那台设备上次待的地方」：先回文件页，目录 / 滚动位置
 * 由 fileStore 的按 serial 分片（views[serial]）自动恢复，这里不做任何记忆。
 *
 * 因此目标与「当前在哪一页」**无关**：在设置页点设备必须离开设置页
 * （这正是修前那个「点了还在设置页」的缺陷）。参数保留是为了让「无关」这件事
 * 本身可被测到（三个页面都得到同一个目标），与 downloadDirForDownload 丢弃
 * 本地面板目录的写法同源。
 */
export function pageAfterSelectDevice(current: Page): Page {
  void current
  return 'files'
}
