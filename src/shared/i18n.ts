import { ERROR_CODES, type ErrorCode } from './errors'

/**
 * 全部用户可见文案（裁决 3：错误码中文人话集中在这里）。
 *
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块。
 * 组件里不得散落硬编码中文 —— tests/ui-contract.test.ts 用静态断言守住这一条。
 */

const messages: Record<string, string> = {
  'app.name': 'HASH',
  'app.starting': 'HASH 启动中…',

  'devices.title': '设备',
  'devices.empty': '尚未发现设备，请用 USB 连接手机并开启 USB 调试',
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
  /*
   * R9：恢复上次目录失败的**中性**提示（裁决 B：这不是错误）。
   *
   * 措辞刻意不出现「失败 / 错误 / 无法」这类词：那个目录可能只是被用户自己删掉了，
   * 设备一点问题都没有。说清「发生了什么 + 现在在哪」就够了。
   */
  'files.cwdFallback': '上次停留的目录已不可用，已回到 /sdcard',
  'files.cwdFallbackDismiss': '知道了',
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
  // ---- R6：当前目录文件名搜索（零 adb 调用，只过滤已加载的条目）----
  'files.searchPlaceholder': '搜索当前目录文件名',
  'files.searchClear': '清除搜索',
  'files.emptyQuery': '没有匹配的文件',
  'files.summaryMatch': '匹配 {matched} / 共 {total}',

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
  /*
   * R10：双击下载前预检到「同名且大小相同」→ 不下载，只提示。
   *
   * 措辞刻意不带错误感：这不是失败，是**已经到位了** —— 用户要的那份文件就在那里。
   * 也不用「跳过」这种过程词开头，先说结论（文件已存在），再说处理（没有重复下载）。
   */
  'transfer.existsSkipped': '文件已存在，未重复下载',
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
  // ---- P1：单机截图 / 录屏（工具条）----
  'capture.screenshot': '截图',
  'capture.record.start': '录屏',
  'capture.record.stop': '停止录屏',
  'capture.screenshot.saved': '截图已保存并复制路径：{path}',
  'capture.record.started': '已开始录屏（最长 {seconds} 秒），点「停止录屏」结束',
  'capture.record.stopped': '录屏已保存并复制路径：{path}',
  'capture.record.busy': '正在处理，请稍候…',

  // ---- P1 第三批：scrcpy 投屏 ----
  'mirror.open': '投屏',
  'mirror.close': '关闭投屏',
  'mirror.opening': '正在启动投屏…',
  'mirror.waiting': '正在等待设备画面出现（首次启动约需 5～10 秒）…',
  'mirror.embedFailed': '投屏窗口已启动，但画面没能嵌进来：{reason}。请关掉这个窗口重试',
  'mirror.running': '投屏中',
  // 侧边栏六个键的可见名（同时充当 title 与 aria-label）
  'mirror.key.back': '返回',
  'mirror.key.home': '主页',
  'mirror.key.recents': '后台',
  'mirror.key.volumeDown': '音量减',
  'mirror.key.volumeUp': '音量加',
  'mirror.key.power': '电源',
  // 横屏/竖屏提示：设备旋转后窗口不会自动转，必须让用户知道能自己调
  'mirror.hint': '若画面比例不对，请调整窗口大小',

  // ---- P1 第二批：应用管理 ----
  'nav.apps': '应用',
  'apps.title': '应用管理',
  'apps.empty': '这台设备上没有可显示的第三方应用',
  'apps.loading': '正在读取应用列表…',
  'apps.reload': '重新读取',
  'apps.column.package': '包名',
  'apps.column.version': '版本',
  'apps.column.updated': '更新时间',
  'apps.column.actions': '操作',
  'apps.unknown': '—',
  'apps.action.pullApk': '拉取 APK',
  'apps.action.installApk': '安装 APK',
  'apps.action.forceStop': '强制停止',
  'apps.action.clearData': '清空数据',
  'apps.action.uninstall': '卸载',
  'apps.action.launch': '启动',
  'apps.pulled': '已拉取 {count} 个 APK 到本地',
  'apps.launched': '已发送启动指令',
  'apps.forceStopped': '已强制停止',
  'apps.cleared': '已清空应用数据',
  'apps.uninstalled': '已卸载',
  'apps.installed': '安装成功',
  // ---- 安装进度（P1 第二批补充：adb install 拿不到中间态，改成 push + pm install）----
  'apps.installing': '正在安装 APK',
  'apps.pushingPhase': '推送 {done} / {total}',
  'apps.installingPhase': '正在安装…',
  'apps.installPushing': '正在推送到设备',
  // ---- 日志栏（安装进度与结果：切页也不丢）----
  // ---- 自绘顶栏的窗口按钮（窗口是 frame:false，系统不再提供）----
  'window.minimize': '最小化',
  'window.maximize': '最大化',
  'window.restore': '还原',
  'window.close': '关闭',
  // ---- 托盘（关闭 = 退到后台之后的唯一入口）----
  'tray.show': '显示主界面',
  'tray.quit': '退出',
  'log.title': '日志',
  'log.empty': '暂无日志',
  'log.clear': '清空日志',
  'log.collapse': '折叠',
  'log.expand': '展开',
  'log.apkUnknown': 'APK',
  'log.install.preparing': '[{device}] 开始安装 {apk}（{size}）',
  'log.install.pushing': '[{device}] 正在把 {apk} 推送到设备',
  'log.install.installing': '[{device}] 推送完成，正在安装 {apk}',
  'log.install.done': '[{device}] {apk} 安装完成',
  'log.install.failed': '[{device}] {apk} 安装失败：{reason}',
  // 应用管理各动作（都带设备与包名：连着操作好几台/好几个包时才对得上）
  'log.app.pulled': '[{device}] 拉取 {pkg} 的 {count} 个 APK 到本地',
  'log.app.launched': '[{device}] 已启动 {pkg}',
  'log.app.forceStopped': '[{device}] 已强制停止 {pkg}',
  'log.app.cleared': '[{device}] 已清空 {pkg} 的数据',
  'log.app.uninstalled': '[{device}] 已卸载 {pkg}',
  'log.app.installed': '[{device}] {apk} 安装完成',
  'log.app.failed': '[{device}] 操作失败：{reason}',
  'apps.phase.preparing': '准备中',
  'apps.phase.pushing': '推送中',
  'apps.phase.installing': '安装中',
  'apps.phase.done': '已完成',
  'apps.installInstalling': '正在安装',
  'apps.installDone': '安装完成',
  'apps.pickApkTitle': '选择要安装的 APK',
  'apps.noDevice': '请先选择设备',
  'apps.confirm.clearData.title': '清空应用数据',
  'apps.confirm.clearData.body': '将清空 {packageName} 的全部本地数据（登录状态、缓存、应用内文件）。这个操作不可撤销，确定继续吗？',
  'apps.confirm.uninstall.title': '卸载应用',
  'apps.confirm.uninstall.body': '将从设备上卸载 {packageName}。应用及其数据都会被删除，这个操作不可撤销，确定继续吗？',
  'apps.confirm.ok': '确定',
  'apps.confirm.cancel': '取消',
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
  /*
   * 【R2-2】原文案是「请先在本地面板里选择一个目标文件夹」—— 本地面板已由用户裁决
   * 不再作为下载目标，文案必须跟着改，否则用户会去本地面板里找一个根本不生效的设置。
   * 现在这条只在「设置里的下载路径还没读到」时出现（它是异常态，不是常态）。
   */
  'op.needLocalDir': '还没读到默认下载路径，请到「设置」里选一个下载文件夹后重试',
  'op.downloaded': '已加入下载队列，可在下方查看进度',

  // ---- 批量操作与设备总览页（任务 10 / 规格 §9.3）----
  'batch.title': '设备总览',
  'batch.screenshot': '批量截图',
  'batch.install': '批量安装',
  'batch.push': '批量推送',
  'batch.shell': '执行命令',
  'batch.pickFiles': '选择要推送的文件',
  'batch.pickDirTitle': '选择批量截图的保存目录',
  'batch.pickApkTitle': '选择要安装的 APK',
  'batch.apkFilter': 'Android 安装包',
  'batch.confirmDangerousBody': '危险命令（{kind}）将在勾选的 {count} 台设备上执行：{command}\n\n影响清单：{devices}\n\n这类命令会中断调试、重启或损坏设备与数据，确定执行吗？',
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

  // ---- 拖拽（简报 C：设备 ↔ 资源管理器）----
  'files.dragHint': '可以把文件直接拖到这里上传，也可以把列表里的文件拖到资源管理器',
  'files.dragPreparing': '正在准备拖拽（{done}/{total}）…',
  'files.dragPreparingHint': '大文件需要先下载到临时目录，下载完成后才会开始拖',
  'files.dragQueued': '已把 {count} 个文件加入上传队列',
  'files.dragQueuedSkipped': '已加入 {queued} 个文件；另有 {skipped} 个不是本机磁盘上的文件（例如从网页拖来的），已跳过',
  'files.dragSkipped': '这些文件不是本机磁盘上的文件（例如从网页拖来的），无法上传。请从资源管理器拖动文件',

  // ---- 顶栏页面切换（任务 10）----
  'nav.files': '当前设备',
  'nav.overview': '全部设备',
  // ---- R2-2：设置页 ----
  'nav.settings': '设置',
  'settings.title': '设置',
  /*
   * R3-1：设置页的出口。
   * 设置在顶栏、页面自身没有返回按钮时，用户点进去就找不到「回到刚才那里」的习惯动作
   * （用户实测反馈：进了设置页出不来）。返回目标固定为文件页 —— 本应用只有 3 页，
   * 不做 history 栈。
   */
  'settings.back': '返回',
  'settings.downloadDir.title': '默认下载路径',
  'settings.downloadDir.desc': '「下载到本地」把文件存到这里。拖拽到资源管理器时，落点由你松手的位置决定',
  'settings.downloadDir.current': '当前：{dir}',
  'settings.downloadDir.defaultHint': '当前就是系统默认的下载目录',
  'settings.downloadDir.customHint': '当前是自定义目录',
  'settings.downloadDir.change': '更换',
  'settings.downloadDir.reset': '恢复默认',
  'settings.downloadDir.pickTitle': '选择默认下载路径',
  'settings.downloadDir.empty': '还没有读到下载路径',
  'settings.downloadDir.loading': '正在读取设置…',
  'settings.downloadDir.reload': '重新读取',
  /*
   * 自定义 scrcpy 参数：全局一套，一个输入框。
   *
   * 说明里必须写清两件用户一定会遇到的问题：
   *   1. 改完要关掉投屏窗口重开才生效（参数是启动时交给 scrcpy 的，改不了运行中的进程）；
   *   2. 有几类参数会被忽略（-s / 窗口标题 / 窗口边框 / 最大分辨率），
   *      因为它们是「嵌入 + 多设备隔离」的前提，让用户覆盖会直接把投屏弄坏。
   */
  'settings.scrcpyArgs.title': '投屏参数',
  'settings.scrcpyArgs.desc': '追加给 scrcpy 的额外参数，例如 --turn-screen-off --show-touches。改完需要关掉投屏窗口重新打开才生效',
  'settings.scrcpyArgs.placeholder': '留空表示只用内置参数',
  'settings.scrcpyArgs.save': '保存',
  'settings.scrcpyArgs.reset': '恢复默认',
  'settings.scrcpyArgs.empty': '当前没有自定义参数',
  'settings.scrcpyArgs.reserved': '这些参数会影响投屏窗口的嵌入，会被忽略：',
  'settings.adb.title': 'adb 状态',
  'settings.adb.source': '来源',
  'settings.adb.path': '路径',
  'settings.adb.version': '版本',
  'settings.adb.checking': '正在查找 adb…',
  'settings.adb.error': '无法使用 adb：{text}',
  'settings.adb.readonly': 'adb 由应用自动定位，不能在这里修改',
  'settings.adb.source.custom': '自定义（环境变量 ADB_PATH）',
  'settings.adb.source.env': '环境变量 ADB_PATH',
  'settings.adb.source.bundled': '内置（随应用打包）',
  'settings.adb.source.path': '系统 PATH',
  'settings.adb.source.unknown': '未知',
  'settings.adb.unknown': '未知',
  /*
   * R7：「关于」—— 应用自己的版本号。
   * 版本号本身来自主进程 app.getVersion()（不是文案），这里只有标题与标签；
   * unknown 是空值占位符 —— 与其留一行空白像坏了，不如明确说「没取到」。
   */
  'settings.about.title': '关于',
  'settings.about.version': '版本',
  'settings.about.unknown': '—',
  // ---- R2-2：多选可见入口 ----
  'files.toolbar.selectAll': '全选',
  'files.selectHint': 'Ctrl 点击加选 · Shift 点击选区间 · Ctrl+A 全选 · Esc 取消选择',
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
  // ---- 任务 10：批量动作的整批参数错（用户能自己修好）----
  E_BATCH_PARAM: '批量操作没有执行：参数不合法，没有任何设备收到命令。请检查是否选了设备、选了文件、填了目标目录或命令',
  E_BAD_COMMAND: '这条命令不能执行：命令里不能包含换行符，否则一条命令会变成多条。请写成单行',
  // ---- P1：单机截图 / 录屏 ----
  E_RECORD_ACTIVE: '这台设备已经在录屏了。请先点「停止录屏」，把这一条录制结束掉再开始新的',
  E_NOT_RECORDING: '这台设备当前没有在录屏，没有文件需要停止。录制可能已经到时间上限自动结束了',
  // ---- scrcpy 投屏 ----
  E_MIRROR_START_FAILED: '投屏没有启动成功。请在日志栏查看 scrcpy 的原始输出；如果刚改过「投屏参数」，先清空再试一次',
  E_SCRCPY_NOT_FOUND: '找不到投屏组件（scrcpy）。安装包可能不完整，请重新安装应用；开发环境请运行 npm run fetch-scrcpy',
  E_SCRCPY_NOT_EXECUTABLE: '投屏组件存在但无法运行（可能缺少 DLL 或被安全软件拦截）。请检查 resources/scrcpy 目录',
  E_SCRCPY_NO_ADB: '投屏组件找不到可用的 adb。请确认内置 adb 未被删除或隔离，重启应用后重试',
  E_MIRROR_ACTIVE: '这台设备已经在投屏了。请先关闭已有的投屏窗口，再重新点投屏',
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