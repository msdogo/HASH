import type { AdbState, DeviceSession, DeviceSnapshot, DeviceStatus } from './types'

/**
 * 设备栏的纯逻辑（裁决 8）。
 *
 * 为什么放在 src/shared：测试工程 import 不了 src/ 下非 shared 的目录（TS6307），
 * 而 jsdom 会破坏 tsconfig 的工程划分。把「状态点映射 / 型号回退 / 排序」抽成纯函数，
 * 两端都能测；React 组件只做渲染，不再藏判断。
 *
 * 本文件不得 import 任何 node 内置模块。
 */

/** 状态点的语义类别（规格 9.2：绿=在线 灰=离线 黄=未授权 蓝=无线 转圈=忙碌）。 */
export type DotKind = 'online' | 'offline' | 'unauthorized' | 'wireless' | 'recovery' | 'busy' | 'unknown'

/** 语义类别 → Tailwind 背景类。组件直接取用，颜色不散落在 JSX 里。 */
export const DOT_CLASS: Record<DotKind, string> = {
  online: 'bg-emerald-400',
  offline: 'bg-neutral-500',
  unauthorized: 'bg-amber-400',
  wireless: 'bg-sky-400',
  recovery: 'bg-sky-400',
  busy: 'bg-amber-300 animate-pulse',
  unknown: 'bg-neutral-600',
}

/** 状态点的中文名（走 i18n 的 key，值在 shared/i18n.ts）。 */
export const DOT_LABEL_KEY: Record<DotKind, string> = {
  online: 'devices.status.device',
  offline: 'devices.status.offline',
  unauthorized: 'devices.status.unauthorized',
  wireless: 'devices.status.device',
  recovery: 'devices.status.recovery',
  busy: 'devices.status.device',
  unknown: 'devices.status.unknown',
}

/** 设备行显示所需的最小信息。 */
export interface DeviceDotInput {
  status: DeviceStatus
  transport: DeviceSession['transport']
  /** 该设备有传输任务在跑（本任务还没有队列，先留出接口）。 */
  busy?: boolean
}

/**
 * 状态点判定。
 * 忙碌优先于一切：设备在线但正在传输时，用户最需要知道的是「它在忙」。
 * 在线状态下再按有线/无线分色（规格 9.2：蓝=无线）。
 */
export function statusDot(input: DeviceDotInput): DotKind {
  if (input.busy === true) return 'busy'
  switch (input.status) {
    case 'device':
      return input.transport === 'wireless' ? 'wireless' : 'online'
    case 'unauthorized':
      return 'unauthorized'
    case 'offline':
      return 'offline'
    case 'recovery':
      return 'recovery'
    default:
      return 'unknown'
  }
}

/** 取 serial 末尾 n 位（型号缺失时的回退显示）。 */
export function serialTail(serial: string, n = 4): string {
  return serial.length <= n ? serial : serial.slice(-n)
}

/**
 * 设备行的主标题（裁决 9）。
 * 有型号显示型号；型号缺失/为空/全空白时回退 serial 后 4 位 ——
 * 绝不显示空字符串（那会让整行只剩一个状态点，用户分不清是哪台）。
 */
export function deviceLabel(device: { serial: string; model?: string }): string {
  const model = (device.model ?? '').trim()
  return model !== '' ? model : serialTail(device.serial)
}

/** 排序权重：在线的排最前，掉线的沉底。 */
const STATUS_RANK: Record<DeviceStatus, number> = {
  device: 0,
  unauthorized: 1,
  recovery: 2,
  offline: 3,
  unknown: 4,
}

/**
 * 设备栏排序：先按状态权重，再按显示名（不区分大小写）。
 * 不修改入参数组 —— store 里的数组可能正被 React 渲染。
 */
export function sortDevices(list: readonly DeviceSession[]): DeviceSession[] {
  return [...list].sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status]
    if (rank !== 0) return rank
    return deviceLabel(a).localeCompare(deviceLabel(b), 'zh-CN')
  })
}

/** 设备栏统计（顶部「共 N 台 · M 台在线」）。 */
export function summarize(list: readonly DeviceSession[]): {
  total: number
  online: number
  unauthorized: number
} {
  let online = 0
  let unauthorized = 0
  for (const device of list) {
    if (device.status === 'device') online += 1
    if (device.status === 'unauthorized') unauthorized += 1
  }
  return { total: list.length, online, unauthorized }
}

/**
 * 当前活动设备。
 * 原设备还在就保持（用户选中的不能被一次轮询抢走）；
 * 原设备消失才回退到第一台；一台都没有则为 null。
 */
export function nextActiveSerial(
  active: string | null,
  list: readonly { serial: string }[],
): string | null {
  if (active !== null && list.some((d) => d.serial === active)) return active
  return list.length > 0 ? list[0].serial : null
}

/**
 * 单台设备的指纹（裁决 5：不变就不推送）。
 *
 * lastSeenAt 必须排除：每轮轮询都会刷新它，算进去等于每 3 秒推一次，设备栏白抖。
 */
export function deviceFingerprint(device: DeviceSession): string {
  return [
    device.serial,
    device.status,
    device.transport,
    device.model ?? '',
    device.android ?? '',
    device.battery === undefined ? '' : String(device.battery),
    device.storage === undefined ? '' : device.storage.usedKb + '/' + device.storage.totalKb,
  ].join('\u0001')
}

/** adb 状态指纹。 */
function adbFingerprint(adb: AdbState): string {
  switch (adb.state) {
    case 'ok':
      return 'ok\u0001' + adb.path + '\u0001' + adb.version + '\u0001' + adb.source
    case 'error':
      return 'error\u0001' + adb.code
    default:
      return 'checking'
  }
}

/**
 * 整份快照的指纹。
 *
 * 设备按 serial 排序后再拼接：设备在 adb 设备表里的顺序可能抖动，
 * 顺序变化不是「状态变化」，不该触发一次全量推送（排序是展示层的事）。
 */
export function snapshotFingerprint(snapshot: DeviceSnapshot): string {
  const devices = [...snapshot.devices]
    .sort((a, b) => (a.serial < b.serial ? -1 : a.serial > b.serial ? 1 : 0))
    .map(deviceFingerprint)
    .join('\u0002')
  return devices + '\u0003' + adbFingerprint(snapshot.adb)
}