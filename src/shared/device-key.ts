/**
 * 设备按键的**唯一事实源**（渲染层与主进程共用）。
 *
 * ===== 为什么必须是枚举，而不是任意字符串/数字 =====
 * 如果渲染层能把「按键」传成任意字符串，它就能传 `4; rm -rf /sdcard` ——
 * 那等于给渲染层开了一个 adb shell 注入面。本项目的红线是
 * 「渲染层零 Node 权限、一切能力经白名单暴露」，按键也必须遵守。
 *
 * 所以：渲染层只能传下面六个**字面量**之一，数字码由主进程用本表映射。
 * 这不是「多此一举的类型体操」，而是把一个潜在注入面变成三行查表。
 */

export const DEVICE_KEYS = ['back', 'home', 'recents', 'volumeUp', 'volumeDown', 'power'] as const

export type DeviceKey = (typeof DEVICE_KEYS)[number]

/**
 * Android KEYCODE 映射（AOSP `KeyEvent` 常量）。
 *
 * back=4 / home=3 / recents=187 是 Android 4.4 起就稳定的三个；
 * volumeUp=24 / volumeDown=25 / power=26 同样稳定。
 * 用 `satisfies` 而不是 `:` 是为了「键名漏一个就报错」，而不是静默 undefined。
 */
const KEY_CODES = {
  back: 4,
  home: 3,
  recents: 187,
  volumeUp: 24,
  volumeDown: 25,
  power: 26,
} satisfies Record<DeviceKey, number>

/**
 * 枚举内 → KEYCODE；枚举外一律返回 0。
 *
 * 返回 0 而不是抛：调用方（服务层）统一用 `code === 0` 判非法，
 * 这样「未知按键」与「映射缺失」走同一条拒绝路径，不会有一个分支漏掉。
 * 0 不是任何合法 KEYCODE（AOSP 的 KEYCODE_UNKNOWN 是 0，正是「无意义」的意思）。
 */
export function keyCodeOf(key: DeviceKey): number {
  return (KEY_CODES as Record<string, number>)[key] ?? 0
}

/** 这个值是不是合法按键名（zod 之外的运行时兜底，用于服务层防御）。 */
export function isDeviceKey(value: unknown): value is DeviceKey {
  return typeof value === 'string' && (DEVICE_KEYS as readonly string[]).includes(value)
}

/**
 * 侧边栏的显示顺序与图标语义。
 *
 * 顺序按「手指最短路径」排：返回/主页/后台是导航三兄弟，放最上；
 * 音量与电源用得少，放最下。渲染层只遍历这个数组，不在组件里手写六遍。
 */
export const SIDEBAR_KEYS: readonly DeviceKey[] = ['back', 'home', 'recents', 'volumeDown', 'volumeUp', 'power']
