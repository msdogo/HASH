/**
 * 设备栏右键菜单的纯逻辑。
 *
 * ===== 为什么需要「设备栏右键」这条入口 =====
 * 工具条上的「投屏」按的是**当前选中设备**；而「我想投屏另一台」这个场景下，
 * 用户的第一反应是直接在那台设备上点，不是先切选中再回来点按钮。
 * 右键菜单把「对这台设备做点什么」这个动作放在它自己身上 —— 这是
 * 资源管理器 / 各种设备管理器一贯的交互，不需要教。
 *
 * ===== 为什么判断放这里 =====
 * 本工程没有 jsdom：SSR 只跑一次 render，组件里的 onClick/onContextMenu 观测不到。
 * 「这台设备当前能做什么」抽成纯函数后就有了可复现的门禁；
 * 剩下「那一行有没有接这个回调」仍然只能靠 review（如实登记，不造假断言）。
 */

/** 右键菜单里可用的动作。 */
export type DeviceMenuAction = 'mirror' | 'mirrorStop'

export interface DeviceMenuItem {
  id: DeviceMenuAction
  /** i18n key（文案集中在 i18n，组件里不写中文）。 */
  labelKey: 'mirror.open' | 'mirror.close'
}

const LABELS: Record<DeviceMenuAction, DeviceMenuItem['labelKey']> = {
  mirror: 'mirror.open',
  mirrorStop: 'mirror.close',
}

/**
 * 这台设备的右键菜单项。
 *
 * 只有一项，但**区分「投屏」与「关闭投屏」**：
 * 已经投屏中还给「投屏」会让用户点了没反应（service 是幂等的，只会聚焦窗口），
 * 而他真正想做的多半是关掉它。
 *
 * @param online 设备是否处于可用状态（status === 'device'）。
 *   离线设备不提供「投屏」：点了必然失败，不如不给这条（省掉一次「为什么没反应」）。
 * @param mirroring 这台设备是否已在投屏。
 */
export function deviceMenuItemsFor(online: boolean, mirroring: boolean): DeviceMenuItem[] {
  if (mirroring) return [{ id: 'mirrorStop', labelKey: LABELS.mirrorStop }]
  if (!online) return []
  return [{ id: 'mirror', labelKey: LABELS.mirror }]
}
