import { ERROR_CODES, type ErrorCode } from './errors'

/**
 * 全部用户可见文案（裁决 3：错误码中文人话集中在这里）。
 *
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块。
 * 组件里不得散落硬编码中文 —— tests/ui-contract.test.ts 用静态断言守住这一条。
 */

const messages: Record<string, string> = {
  'app.name': 'ADB 文件管家',
  'app.starting': 'ADB 文件管家启动中…',

  'devices.title': '设备',
  'devices.empty': '尚未发现设备，请用 USB 连接手机并开启 USB 调试',
  'devices.all': '全部设备',
  'devices.adbChecking': '正在查找 adb…',
  'devices.adbUnusable': '无法使用 adb',
  'devices.selectHint': '请选择左侧设备',
  'devices.summary': '共 {total} 台设备 · {online} 台在线',
  'devices.unauthorizedHint': '请在手机上允许 USB 调试',
  'devices.status.device': '在线',
  'devices.status.offline': '离线',
  'devices.status.unauthorized': '未授权',
  'devices.status.recovery': '恢复模式',
  'devices.status.unknown': '未知状态',
  'devices.transport.wireless': '无线',
  'devices.refresh': '刷新',

  // ---- 文件页（任务 7）----
  'files.loading': '正在读取目录…',
  'files.empty': '这个目录是空的',
  'files.emptyHidden': '目录里只有隐藏项，打开「显示隐藏文件」再看',
  'files.retry': '重试',
  'files.refresh': '刷新',
  'files.up': '上一级',
  'files.showHidden': '显示隐藏文件',
  'files.hideHidden': '不显示隐藏文件',
  'files.addressPlaceholder': '输入路径后回车跳转，如 /sdcard/DCIM',
  'files.addressEdit': '编辑路径',
  'files.addressInvalid': '路径格式不合法，未跳转',
  'files.notice.degraded': '部分条目无法读取（{count} 项），已尽力显示',
  'files.notice.exitCode': '该目录有部分内容因权限不足未能读取，已显示读到的条目',
  'files.notice.dismiss': '关闭提示',
  'files.column.name': '名称',
  'files.column.size': '大小',
  'files.column.mtime': '修改时间',
  'files.column.mode': '权限',
  'files.unknownMeta': '未知',
  'files.dirSize': '—',
  'files.open': '打开',

  'files.summary': '{dirs} 个文件夹 · {files} 个文件',
  'files.linkTo': '指向 {target}',
  'files.sortHint': '点击切换排序方向',
  'files.selected': '已选 {count} 项',
  'files.scrollToTop': '回到顶部',
}

/**
 * 错误码 → 一句用户能看懂的中文。
 *
 * 写法约定：说「用户该做什么」而不是「程序哪里错了」。
 * ERROR_CODES 里的每个码都必须在这里有一句，且不得等于码本身（errors/i18n 测试会逐条断言）。
 */
const errorTexts: Record<ErrorCode, string> = {
  E_NO_SERIAL: '没有指定设备序列号，无法执行命令。请重新选择设备后重试',
  E_TIMEOUT: '命令执行超时，设备可能没有响应。请检查连接后重试',
  E_ABORTED: '操作已被取消，未完成的部分不会生效',
  E_SHUTDOWN: '应用正在退出，该操作已取消，请重新启动应用后再试',
  E_INVALID_PATH: '路径不合法，或含有无法通过 adb 传输的字符（换行、回车、空字符）',
  E_ADB_NOT_FOUND: '没有找到可用的 adb。请安装 Android platform-tools，或在设置里指定 adb 路径',
  E_ADB_NOT_EXECUTABLE: '找到的 adb 文件无法运行，请确认它是完整的 adb.exe 而不是空文件或快捷方式',
  E_ADB_BAD_OUTPUT: 'adb 版本输出无法识别，文件可能已损坏或不是官方版本',
  E_ADB_TIMEOUT: 'adb 自检超时没有响应，可能被其它调试工具占用，请稍后重试',
  E_ADB_SHIM_UNSUPPORTED: '检测到 scoop/npm 包装脚本，暂不支持，请选择 platform-tools 里的 adb.exe',
  E_NO_PERMISSION: '没有访问该目录的权限，普通模式读不了系统目录',
  E_NOT_FOUND: '这个路径不存在，可能已被删除或被移动',
  E_PARSE_DEGRADED: '目录内容无法解析，设备的文件系统格式可能与预期不符',
  E_BAD_ARGS: '请求参数不合法，这是程序内部错误，请重试或重启应用',
  E_LIST_FAILED: '列出目录失败，请稍后重试，或换一个目录',
  E_UNKNOWN: '发生未知错误，请重试；如果一直失败，请重启应用',
}

/** 取一条已注册文案；未注册时原样返回 key（便于开发期发现漏登记）。 */
export function t(key: string): string {
  return messages[key] ?? key
}

/** 取文案并替换 {name} 占位；未注册的 key 原样返回。 */
export function tf(key: string, params: Record<string, string | number>): string {
  let text = t(key)
  if (text === key) return text
  for (const [name, value] of Object.entries(params)) {
    text = text.split('{' + name + '}').join(String(value))
  }
  return text
}

/**
 * 错误码 → 中文人话。表外码回退成「未知错误（原码）」，
 * 既保证界面永远有话说，又保留原始码方便「复制错误」定位。
 */
export function errorText(code: string): string {
  if ((ERROR_CODES as readonly string[]).includes(code)) {
    return errorTexts[code as ErrorCode]
  }
  return '未知错误（' + code + '），请重试或重启应用'
}

/** 仅测试与 i18n 覆盖用。 */
export function setMessages(next: Record<string, string>): void {
  Object.assign(messages, next)
}