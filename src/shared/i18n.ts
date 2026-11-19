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
  'files.linkUnresolved': '无法进入这个快捷方式：没有可用的目标路径',
  'files.linkCycle': '这个快捷方式指向自己或已访问过的目录，已停止跟随',
  'files.scrollToTop': '回到顶部',

  // ---- 传输（任务 8）----
  'transfer.title': '传输',
  'transfer.idle': '传输空闲',
  'transfer.upload': '上传到当前目录',
  /*
   * 【审查 M5】原有一条 'transfer.download': '下载到本地' 已删除：
   * 渲染层没有下载入口（审查 I4 已记为跨任务缺口），留着就是一个没人引用的
   * 「许愿池」key，会让人误以为功能已经接好了。
   * 下载 UI 落地时（任务 9 本地双栏）再连同入口一起加回来。
   */
  'transfer.cancel': '取消',
  'transfer.retry': '重试',
  'transfer.clearFinished': '清除已完成',
  'transfer.direction.push': '上传',
  'transfer.direction.pull': '下载',
  'transfer.status.queued': '排队中',
  'transfer.status.running': '传输中',
  'transfer.status.done': '已完成',
  'transfer.status.failed': '失败',
  'transfer.status.canceled': '已取消',
  'transfer.unknownTotal': '大小未知',
  'transfer.overwrote': '已覆盖同名文件',
  'transfer.summary': '{running} 个传输中 · {queued} 个排队',
  'transfer.queuedOnOffline': '设备离线，等待重连',
  'transfer.noDevice': '请先选择设备',
  /*
   * 【任务 9 / 裁决 7】恢复 transfer.download：
   * 任务 8 审查 I4 记录的「有队列能力、没有界面入口」在本任务补上了 ——
   * 文件页选中项 → 「下载到本地」按钮 → 走队列。留 key 不留入口才是问题，现在两者都有。
   */
  'transfer.download': '下载到本地',

  // ---- 文件操作（任务 9）----
  'op.toolbar.newFolder': '新建文件夹',
  'op.toolbar.rename': '重命名',
  'op.toolbar.delete': '删除',
  'op.toolbar.copyTo': '复制到…',
  'op.toolbar.moveTo': '移动到…',
  'op.toolbar.refresh': '刷新',
  'op.toolbar.download': '下载到本地',
  'op.kind.delete': '删除',
  'op.kind.copy': '复制',
  'op.kind.move': '移动',
  'op.kind.newFolder': '新建文件夹',
  'op.kind.rename': '重命名',
  'op.field.name': '名称',
  'op.field.namePlaceholder': '输入新的名称',
  'op.field.dstPlaceholder': '输入设备上的目标目录，如 /sdcard/Download',
  'op.field.folderPlaceholder': '输入新文件夹的名字',
  'op.confirm': '确定',
  'op.cancel': '取消',
  'op.busy': '处理中…',
  /*
   * 删除确认框（裁决 1 + 规格 §9.6）：
   * 必须说清「将删除 N 项」「前 3 个名字」「其中有非空目录」「有几项被拒绝」。
   * 这几条不是装饰 —— 用户是凭它们判断自己有没有选错的。
   */
  'op.delete.title': '确认删除',
  'op.delete.count': '将删除 {count} 项：',
  'op.delete.more': '…另有 {rest} 项未列出',
  'op.delete.nonEmpty': '其中有非空文件夹，里面的文件会一起被删除，且无法恢复',
  'op.delete.blocked': '{count} 项被安全策略拒绝，不会删除',
  'op.delete.irreversible': '删除后无法恢复，请确认无误',
  'op.result.title': '{ok} 成功 / {failed} 失败',
  /*
   * 【审查 I5】部分完成必须给出计数，不能只显示一个错误码。
   * 用户看到「已删除 2 项，还剩 1 项」才知道现场长什么样；
   * 只看到「操作只完成了一部分」仍然不知道重试会撞上什么。
   */
  'op.result.partial': '已删除 {removed} 项，还剩 {remaining} 项',
  'op.result.allOk': '{ok} 项全部成功',
  'op.result.failures': '失败项',
  'op.result.dismiss': '知道了',
  'op.noSelection': '请先选中要操作的项',
  'op.newFolder.title': '新建文件夹',
  'op.rename.title': '重命名',
  'op.copy.title': '复制到目录',
  'op.move.title': '移动到目录',
  'op.needLocalDir': '请先在本地面板里选择一个目标文件夹',
  'op.downloaded': '已加入下载队列，可在下方查看进度',

  // ---- 本地栏（任务 9 / 裁决 5）----
  'local.title': '本地',
  'local.root': '范围：{root}',
  'local.pickRoot': '更换目录',
  'local.up': '上一级',
  'local.empty': '这个文件夹是空的',
  'local.loading': '正在读取本地目录…',
  'local.restricted': '这个位置在本地选定目录之外，无法访问',
  'local.selectHint': '点击文件夹进入，选中文件后可上传',
  'local.refresh': '刷新',

  // ---- 批量操作与设备总览页（任务 10 / 规格 §9.3）----
  'batch.title': '设备总览',
  'batch.screenshot': '批量截图',
  'batch.install': '批量安装',
  'batch.push': '批量推送',
  'batch.shell': '执行命令',
  'batch.pickFiles': '选择要推送的文件',
  'batch.pickApk': '选择 APK',
  'batch.pickDirTitle': '选择批量截图的保存目录',
  'batch.pickApkTitle': '选择要安装的 APK',
  'batch.apkFilter': 'Android 安装包',
  'batch.confirmDangerousBody': '将在勾选的 {count} 台设备上执行：{command}\n\n影响清单：{devices}\n\n这类命令（kill-server / reboot / root）会中断调试或重启设备，确定执行吗？',
  'batch.dstDir': '目标目录',
  'batch.dstDirPlaceholder': '设备上的目标目录，如 /sdcard/Download',
  'batch.shellPlaceholder': '要在每台设备上执行的命令，如 echo ok',
  'batch.selected': '已选 {count} 台',
  'batch.selectAll': '全选',
  'batch.pickCancelled': '已取消选择，没有执行任何操作',
  'batch.running': '正在执行…',
  'batch.result.title': '{ok} 成功 / {failed} 失败',
  'batch.result.dismiss': '知道了',
  'batch.result.queued': '已加入队列（下载进度见底栏）',
  'batch.result.installed': '安装成功',
  'batch.shellOutput': '输出：{text}',
  'batch.result.filesQueued': '{count} 个文件已加入队列',
  'batch.result.truncated': '输出已截断',
  'batch.result.noOutput': '没有输出',
  'batch.column.device': '设备',
  'batch.column.status': '状态',
  'batch.column.android': 'Android',
  'batch.column.battery': '电量',
  'batch.column.storage': '存储',
  'batch.column.tasks': '任务',
  'batch.unknown': '—',
  'batch.tasks': '{count} 任务',
  'batch.idle': '空闲',
  'batch.storageMissing': '电量与存储暂不可用',

  // ---- 顶栏页面切换（任务 10）----
  'nav.files': '当前设备',
  'nav.overview': '全部设备',
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
  E_LINK_UNRESOLVED: '这个快捷方式（符号链接）没有可用的目标路径，无法进入。可以改用地址栏直接输入完整路径',
  E_LINK_CYCLE: '这个快捷方式指向了自己或已经走过的目录，为避免无限跳转已停止跟随',
  E_NOT_A_DIRECTORY: '这个快捷方式指向的是一个文件而不是目录，因此不能进入。可以双击文件本身来查看或下载它',
  E_SYNC_FAILED: '传输没有完成，可能是中途断开、空间不足或目标位置不可写。可以直接重试这一次传输',
  E_DEVICE_OFFLINE: '设备已断开，这台设备的传输已暂停。重新连接后可以一键重试',
  // ---- 任务 9：文件操作与本地双栏 ----
  E_PATH_UNSAFE: '这个路径里有「..」，会跳出允许访问的位置，已拒绝执行。请改用完整的绝对路径',
  /*
   * 【第 2 轮复审 N2】原文案写死「禁止删除或移动」，于是「上传文件到 /sdcard
   * 被拒」时提示的是一件用户根本没在做的事。文案必须与**动作无关**：
   * 只说明「这是受保护位置」，并给出可用的替代（它的子目录仍然可用）。
   */
  E_PROTECTED_PATH: '这是设备上受保护的系统位置（例如 /sdcard、/storage/emulated/0、/data、/system 本身），不允许对它执行这个操作。它里面的普通子目录（如 /sdcard/Download）仍然可以正常使用',
  E_ALREADY_EXISTS: '目标位置已经有同名的文件或文件夹了。请换一个名字，或先把原来的删掉/改名',
  /*
   * 【审查 I5】原文案是「操作没有完成，文件保持原样，没有被删除或覆盖」。
   * 在「递归删除中途失败」「多文件移动中途失败」时这是**明确的假话** ——
   * 部分内容已经不可逆地消失，而用户会据此认为重试是安全的。改成只承诺能兑现的部分。
   */
  E_OP_FAILED: '操作没有完成，且没有覆盖任何已有文件。请刷新后重试',
  E_OP_PARTIAL: '操作只完成了一部分：可能已有一部分内容被删除或移动。请刷新列表核对，不要直接重试',
  E_INTO_SELF: '不能把文件夹复制或移动到它自己里面，那会无限递归。请换一个目标位置',
  E_CROSS_DEVICE: '源和目标不在设备的同一个存储区，直接移动可能只搬走一部分。请改用「复制到目标」，确认无误后再删除源',
  E_READ_ONLY: '这个位置是只读的，当前权限无法写入。请换一个目录（例如 /sdcard/Download）',
  E_NO_SPACE: '设备存储空间不足，操作已中止。请先清理一些文件再试',
  E_OUTSIDE_ROOT: '这个位置在本地选定的目录之外，已被拒绝访问。请先在左侧切换到允许的目录',
  // ---- 任务 10：批量动作的整批参数错（用户能自己修好）----
  E_BATCH_PARAM: '批量操作没有执行：参数不合法，没有任何设备收到命令。请检查是否选了设备、选了文件、填了目标目录或命令',
  E_BAD_COMMAND: '这条命令不能执行：命令里不能包含换行符，否则一条命令会变成多条。请写成单行',
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