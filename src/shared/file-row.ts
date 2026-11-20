/**
 * 文件列表行（FileTable 的每一行）的 class 拼装 —— 纯函数，可单测（R4 事项 3）。
 *
 * ===== 为什么这行 class 必须搬到 shared =====
 * 行是 `tabIndex={0}` 的 div（Enter 打开，规格 9.5），所以浏览器会给它**默认焦点环**：
 * 用户鼠标点一下（尤其多选时 Shift/Ctrl 连点）就会看到一圈黄色描边。
 * 修法是给行加 outline-none（鼠标点击不含 :focus-visible，黄框消失），
 * 同时保留 focus-visible 的细蓝内描边（Tab 聚焦仍然看得见，键盘可达性不退化）。
 *
 * 这两条互相对冲的约束（"鼠标别显示环" vs "键盘必须显示环"）是本事项唯一容易写反的地方，
 * 而组件本体在无 jsdom 的工程里观测不到 class 到底拼成什么，所以把它抽成纯函数：
 * 测试可以直接对字符串做断言（这不等于 toContain(源码文本) —— 断的是**函数返回值**，
 * 不是源码里出现过某个词；把实现改坏一条用例就红）。
 */

/** 行与列共用的基础排版（不含任何状态色）。 */
export const ROW_BASE_CLASS = 'flex cursor-default select-none items-center gap-2 px-3 text-sm'

/**
 * 焦点相关的 class。
 *
 * - `outline-none`：去掉浏览器默认焦点环 —— 用户实测报告的那圈黄框就是它。
 *   只影响 :focus，不影响 :focus-visible。
 * - `focus-visible:ring-1 focus-visible:ring-sky-500 focus-visible:ring-inset`：
 *   **只有键盘（Tab）聚焦时**才画的细蓝内描边。刻意用 ring-inset 而不是外描边：
 *   行与行是紧贴的虚拟列表，外描边会被下一行盖掉一半。
 * - 故意不用裸 `ring-1`：那会在鼠标点击时也画环，等于把黄框换个颜色接着显示。
 */
export const ROW_FOCUS_CLASS =
  'outline-none focus-visible:ring-1 focus-visible:ring-sky-500 focus-visible:ring-inset'

/** 选中态（多选/当前行）。 */
export const ROW_ACTIVE_CLASS = 'bg-neutral-200 text-neutral-900'

/** 未选中态（含 hover）。 */
export const ROW_IDLE_CLASS = 'text-neutral-700 hover:bg-neutral-200/50'

/**
 * 一行的完整 class。
 *
 * 焦点类**始终**附带（选中与未选中都要有）：否则「选中后再 Tab 过去」就看不到焦点了，
 * 而多选场景正是用户最容易用键盘确认当前行的地方。
 */
export function rowClassName(active: boolean): string {
  return ROW_BASE_CLASS + ' ' + ROW_FOCUS_CLASS + ' ' + (active ? ROW_ACTIVE_CLASS : ROW_IDLE_CLASS)
}
