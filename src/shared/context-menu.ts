/**
 * 文件列表右键菜单的纯逻辑（R5 事项 2）。
 *
 * ===== 用户裁决（已确认）=====
 * | 选中数量 | 菜单项 |
 * | 1 项     | 重命名、删除、下载到本地 |
 * | > 1 项   | 只显示删除、下载到本地（重命名**不出现**，不是变灰） |
 *
 * 右键的选中语义（Windows 资源管理器惯例）：
 * - 右键**未选中**的行 → 先把它设为唯一选中项，再弹菜单；
 * - 右键**已选中**的行（当前多选）→ 保持多选不变，菜单作用于整批。
 *
 * ===== 为什么全在这里（shared）=====
 * 本工程没有 jsdom，SSR 只跑 render 不跑事件回调：写在组件里 = 零门禁。
 * 抽成纯函数后，「哪几项、什么顺序、会翻到哪边」都能表驱动断言。
 *
 * 红线：不得 import 任何 node 内置模块，也不得引用 DOM 类型（主进程工程也要编译它）。
 */

/** 菜单动作标识（与 FilesPage 里复用的既有 handler 一一对应）。 */
export type MenuActionId = 'rename' | 'delete' | 'download'

/** 菜单文案的 i18n key —— 复用工具条已有的三个 key，不新造重复文案。 */
export type MenuLabelKey = 'op.toolbar.rename' | 'op.toolbar.delete' | 'op.toolbar.download'

export interface MenuItem {
  id: MenuActionId
  labelKey: MenuLabelKey
  /**
   * 是否置灰。
   *
   * 用户裁决落点是**出现 / 不出现**（多选时重命名整项不出现），不是变灰，所以这里恒为 false。
   * 保留该字段是为了让调用方对三项一视同仁地渲染（将来若有单项禁用，不必改签名）；
   * 但**不要**用它来表达「多选时重命名不可用」—— 那条必须由 menuItemsFor 直接不返回该项。
   */
  disabled: boolean
}

/** 单选时可用的全部动作，按菜单里的显示顺序排列。 */
export const SINGLE_SELECTION_ACTIONS: readonly MenuActionId[] = ['rename', 'delete', 'download']

/** 多选时可用的动作（重命名被整项剔除）。 */
export const MULTI_SELECTION_ACTIONS: readonly MenuActionId[] = ['delete', 'download']

const LABEL_KEYS: Record<MenuActionId, MenuLabelKey> = {
  rename: 'op.toolbar.rename',
  delete: 'op.toolbar.delete',
  download: 'op.toolbar.download',
}

function itemOf(id: MenuActionId): MenuItem {
  return { id, labelKey: LABEL_KEYS[id], disabled: false }
}

/**
 * 当前选中数量下的菜单项（顺序即渲染顺序）。
 *
 * 0 项 → 空表：右键只发生在某一行上，而右键语义会把该行变成选中项，
 * 所以「0 项弹出菜单」本来就不该发生；返回空表让调用方能安全地用
 * items.length === 0 决定「根本不渲染」，而不是渲染一个没有任何动作的空框。
 */
export function menuItemsFor(selectedCount: number): MenuItem[] {
  if (selectedCount <= 0) return []
  if (selectedCount === 1) return SINGLE_SELECTION_ACTIONS.map(itemOf)
  return MULTI_SELECTION_ACTIONS.map(itemOf)
}

/* ============ 右键与左键的分界 ============ */

/**
 * 这次 mousedown 该不该改变选中项 —— **只有主键（左键）才改**。
 *
 * ===== 这是 R5 实装时踩到的真坑（不是防御性代码）=====
 * 浏览器里右键**也会**先发 mousedown（button === 2），而 FileTable 的行用
 * onMouseDown 做选中。于是「多选 3 项 → 右键其中一项」的真实时序是：
 *   1. mousedown(button=2) → onSelect(entry, 'replace') → 选中被塌缩成 1 项；
 *   2. contextmenu → onContextMenuRow → 判定「这一行已在选中集合里」→ keep；
 * 结果是用户裁决要的「右键已选中的行保持多选」永远走不到：
 * 菜单会按 3 项算（渲染期闭包里还是旧的 selected），实际却只剩 1 项被选中，
 * 点「删除」只会删掉那一项 —— 一个静默的数据偏差，比菜单项错更危险。
 *
 * 修法：右/中键的 mousedown 一律不参与选中（与 Windows 资源管理器一致：
 * 右键从不改变选择，除非右键的是未选中的行 —— 那一条由 contextSelectionFor 负责，
 * 它发生在 contextmenu 事件里、而不是 mousedown 里）。
 */
export function isPrimaryPointerButton(button: number): boolean {
  return button === 0
}

/* ============ 右键的选中语义 ============ */

/** 右键时对选中集合要做什么：保持原样 / 把这一行变成唯一选中项。 */
export type ContextSelection = 'keep' | 'replace'

/**
 * 右键之后「选中数量」会变成多少 —— 菜单项数量就是按它算的。
 *
 * 为什么单独成一个函数而不是让调用方写 `replace ? 1 : selected.length`：
 * 菜单项的条数必须与「右键之后实际选中的项数」严格同源。
 * 两处各写一遍的漂移形态很具体：右键一个未选中的行时，选中项变成 1，
 * 若是仍按旧的 selected.length（比如 4）去取菜单，用户会拿到「删除/下载」两项，
 * 而实际只选中了 1 个文件 —— 重命名入口凭空消失。
 */
export function selectedCountAfterContext(clickedName: string, selected: readonly string[]): number {
  return contextSelectionFor(clickedName, selected) === 'replace' ? 1 : selected.length
}

/**
 * 右键某一行时该怎么处理选中项。
 *
 * - 该行**已在**选中集合里 → keep（多选后右键删除符合直觉，不必重选一遍）；
 * - 该行**不在**选中集合里 → replace（先把它设为唯一选中项，再弹菜单）。
 *
 * 注意 keep 的判据只看「在不在集合里」，不看集合大小：
 * 只选中一行时右键它，结果同样是「保持不动」。
 */
export function contextSelectionFor(clickedName: string, selected: readonly string[]): ContextSelection {
  for (const name of selected) {
    if (name === clickedName) return 'keep'
  }
  return 'replace'
}

/* ============ 视口夹取（position: fixed 坐标系） ============ */

/**
 * 菜单保持的视口边距（px）。
 *
 * 刻意不是 0：贴着窗口边缘弹出来的菜单，最后一行的 hover 背景会被窗口边框切掉，
 * 看起来像渲染错误。8px 与 Windows 资源管理器的留白相近。
 */
export const MENU_VIEWPORT_MARGIN = 8

/** 菜单一项的高度（px）—— 与组件里的 h-7（28px）必须一致，两处各写一个数字就会算错翻转位置。 */
export const MENU_ITEM_HEIGHT = 28

/** 菜单上下内边距（px）—— 对应组件的 py-1。 */
export const MENU_PADDING_Y = 8

/** 菜单边框总高度（px）—— 对应组件的上下各 1px 边框。 */
export const MENU_BORDER = 2

/** 菜单最小宽度（px）：三项中文文案「下载到本地」必须放得下且不换行。 */
export const MENU_MIN_WIDTH = 176

/** 菜单外框尺寸：**先算尺寸再夹取位置**，否则没有 width/height 就没法判断会不会溢出。 */
export function menuBoxSize(itemCount: number): { width: number; height: number } {
  const count = itemCount > 0 ? itemCount : 0
  return { width: MENU_MIN_WIDTH, height: count * MENU_ITEM_HEIGHT + MENU_PADDING_Y + MENU_BORDER }
}

export interface MenuClampInput {
  /** 右键点在视口坐标系里的位置（clientX）。 */
  x: number
  /** 右键点在视口坐标系里的位置（clientY）。 */
  y: number
  /** 菜单外框宽高（由 menuBoxSize 算）。 */
  width: number
  height: number
  /** 视口尺寸（window.innerWidth / innerHeight）。 */
  viewport: { width: number; height: number }
  /** 覆盖边距（缺省 MENU_VIEWPORT_MARGIN）。 */
  margin?: number
}

export interface MenuPoint {
  x: number
  y: number
}

/**
 * 把菜单放进视口：默认在光标右下展开，越界就翻到另一侧，仍放不下就贴边。
 *
 * 三条规则（每条一个用例）：
 * 1. **放得下就原样**（右下展开，指针落在菜单左上角）；
 * 2. **右侧/下方放不下就翻转**：翻到光标左侧/上方 —— 资源管理器同款，
 *    比「夹回边界」更符合直觉（夹回边界会让菜单盖住光标右侧的文件名）；
 * 3. **翻转后还溢出（菜单比视口还大）→ 贴住左上边距**，
 *    至少保证第一项可见、可点。
 *
 * 入参用视口坐标（clientX/clientY）而不是滚动容器相对坐标：虚拟列表的滚动容器
 * 参与 transform 与滚动，用相对坐标在滚动后必然错位。
 */
export function clampMenuPosition(input: MenuClampInput): MenuPoint {
  const margin = input.margin ?? MENU_VIEWPORT_MARGIN
  return {
    x: placeOnAxis(input.x, input.width, input.viewport.width, margin),
    y: placeOnAxis(input.y, input.height, input.viewport.height, margin),
  }
}

/** 单个轴上的放置：放得下 → 原点；放不下 → 翻到另一侧；都放不下 → 贴边距。 */
function placeOnAxis(point: number, size: number, viewportSize: number, margin: number): number {
  // 菜单比视口还大：翻转与夹取都无解，只能贴住左上，保证顶/首项可点
  if (size + margin * 2 > viewportSize) return margin
  const flipped = point + size + margin > viewportSize ? point - size : point
  const lower = margin
  const upper = viewportSize - margin - size
  const clamped = flipped < lower ? lower : flipped > upper ? upper : flipped
  // 取整：clientX 可能是小数，left 带小数的菜单在 1px 边框上会糊
  return Math.round(clamped)
}
