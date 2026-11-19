import { E_INVALID_PATH } from './errors'

/**
 * 远程（设备侧）与本地路径的【唯一】校验闸门（任务 9 裁决 1 / 2 / 5）。
 *
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块
 * （路径解析全部用纯字符串逻辑，Windows/POSIX 两条规则都手写）。
 *
 * ===== 为什么必须只有一个函数 =====
 * 任务 9 引入了四种「写路径」的操作（新建 / 重命名 / 复制 / 移动）+ 删除。
 * 修前每个操作各写一段路径拼接，于是「哪些写法算合法」就有 5 份互不一致的答案：
 * 有的拒 ..，有的归一化后放行，有的根本不管 —— 这正是越权删除与目录穿越的温床。
 *
 * ===== 职责边界（很重要，不要越界） =====
 * 本模块只管【路径语义】：空、未归一化、.. 越界、控制字符、超长、名字是否可作单段。
 * 它**不负责 shell 转义** —— 那由 electron/adb/shellsafe.ts 的 shellQuote 在命令构造处做。
 * 所以分号、美元括号、单引号这些**看起来像注入的字符在这里是合法文件名**：
 * 设备上真的存在含单引号的目录（裁决 9 的真机用例），转义后 shell 会当字面量。
 * 把「转义」塞进路径校验，只会逼着调用方绕过校验去处理合法文件名。
 */

/** 新错误码：路径语法合法但语义越界（试图跳出允许的根）。 */
export const E_PATH_UNSAFE = 'E_PATH_UNSAFE'

/** 单个名字（路径段）的字节上限（ext4 / f2fs 的单段限制是 255 字节）。 */
export const MAX_NAME_BYTES = 255

/**
 * 整条路径的字节上限。
 *
 * 取 4096 的理由：Linux 的 PATH_MAX 是 4096（含结尾 NUL），Android 沿用它；
 * 再长的话 adb shell 那一行命令也接近命令行长度限制，报错会出现在很远的地方。
 */
export const MAX_PATH_BYTES = 4096

/**
 * 禁止删除 / 改名 / 移动的根路径（裁决 1：白名单式拒绝）。
 *
 * 这些是设备上「删了就等于毁掉机器」的锚点：删 /sdcard 会连带用户的全部照片，
 * 删 /storage 会连带所有挂载点，删 /data 直接开不了机。
 * 只列**确定不能碰的**，不搞「凡是两级以内都禁」那种粗规则 ——
 * 那样用户连 /sdcard/Download 都动不了，功能就废了。
 *
 * 注意：这里比对的是**归一化后**的路径（大小写敏感，Android 是大小写敏感的）。
 */
export const PROTECTED_REMOTE_PATHS: readonly string[] = [
  '/',
  '/sdcard',
  '/storage',
  '/storage/emulated',
  '/storage/emulated/0',
  '/storage/self/primary',
  /*
   * 【审查 I6】Android 目录是全部应用私有数据（/sdcard/Android/data 与 /sdcard
   * 是**不同设备号**的独立 f2fs 挂载点，删它等于清掉所有 App 数据且部分不可再生）。
   * 界面上只有两次点击就能做到，而确认框只会说「非空目录」——
   * 这是本任务里唯一「一条误操作毁掉整机应用数据」的路径，必须拦在名单里。
   *
   * 只拦整棵 Android 目录本身，不拦它下面的普通子目录：
   * 用户仍然可以管理 /sdcard/Android/data/com.example.app 里的单个文件。
   */
  '/sdcard/Android',
  // data / obb 是**独立挂载点**（真机实测 /sdcard/Android/data 与 /sdcard 设备号不同），
  // 删它们等于清掉所有 App 的数据库与扩展包
  '/sdcard/Android/data',
  '/sdcard/Android/obb',
  '/storage/emulated/0/Android',
  '/storage/emulated/0/Android/data',
  '/storage/emulated/0/Android/obb',
  '/mnt',
  '/mnt/user/0/primary',
  // 【审查 M2】/mnt/* 是 /storage 的老别名，指同一批挂载点
  '/mnt/sdcard',
  '/mnt/user/0/emulated/0',
  '/mnt/runtime/default/emulated/0',
  '/system',
  '/system_ext',
  '/vendor',
  '/product',
  '/odm',
  '/data',
  '/cache',
  '/proc',
  '/sys',
  '/dev',
  '/root',
  '/init',
]

/**
 * 整棵子树都禁止传输的「系统区」（裁决 2 / 审查 C2）。
 *
 * 与 PROTECTED_REMOTE_PATHS 的区别：
 *   - 上面那份名单是**精确匹配**，用于删/移/改名的对象本身（用户区目录如
 *     /sdcard/Download 完全没问题，所以不能连子树一起禁）；
 *   - 这一份是**子树**：/data、/system 这类系统分区，普通权限本来就不该往里写，
 *     读也属于越权（/data/local/tmp 是 shell 可写的调试区，但那正是
 *     「任何应用都能借调试口写进去」的地方，传输通道不该成为它的后门）。
 *
 * 用途：只用于**传输通道**（push 的设备目标、pull 的设备源）。
 * 传输的路径完全来自渲染层入参，是攻击面最大的入口；而 fs:* 的操作对象来自
 * 用户实际浏览到的位置（例如 /data/local/tmp 下的调试文件），保持精确匹配即可。
 */
export const PROTECTED_REMOTE_SUBTREES: readonly string[] = [
  '/data',
  '/system',
  '/system_ext',
  '/vendor',
  '/product',
  '/odm',
  '/cache',
  '/proc',
  '/sys',
  '/dev',
  '/root',
  '/init',
]

/** 校验结果：成功给归一化后的值，失败给可翻译的错误码。 */
export type PathVerdict =
  | { ok: true; path: string }
  | { ok: false; code: string }

/** 名字（单段）校验结果。 */
export type NameVerdict =
  | { ok: true; name: string }
  | { ok: false; code: string }

/** 含 \n / \r / \0 的字符串根本无法表达成 adb shell 命令（单行文本协议）。 */
function hasControlChars(value: string): boolean {
  return value.includes('\n') || value.includes('\r') || value.includes('\0')
}

/** UTF-8 字节数（长度上限按字节算，不按 UTF-16 长度算：中文一个字 3 字节）。 */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code < 0x10000) bytes += 3
    else bytes += 4
  }
  return bytes
}

/**
 * 折叠重复斜杠、消掉 '.' 与 '..'。
 * '..' 在根处被夹住（绝不产生根以外的结果），但 checkRemotePath **不靠它防穿越**：
 * 含 '..' 的输入一律拒绝，而不是「归一化后放行」。
 */
function normalizeSegments(input: string): string {
  const segments: string[] = []
  for (const seg of input.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      segments.pop()
      continue
    }
    segments.push(seg)
  }
  return '/' + segments.join('/')
}

/**
 * 校验「设备上的单个名字」（新建时的名字、重命名的新名字）。
 *
 * 与 checkRemotePath 分开的理由：名字里**不允许出现斜杠**（那是路径分隔符），
 * 而路径校验必须允许。混成一个函数的话，新建文件时 a/b 会被当成子路径悄悄放行，
 * 用户的「新建 a/b」就变成了在别处建目录。
 */
export function checkName(name: string): NameVerdict {
  if (name === '' || name === '.' || name === '..') return { ok: false, code: E_INVALID_PATH }
  if (hasControlChars(name)) return { ok: false, code: E_INVALID_PATH }
  if (name.includes('/') || name.includes('\\')) return { ok: false, code: E_INVALID_PATH }
  // 首尾空白一律拒：Linux 允许，但用户复制粘贴时几乎总是误带，且 ls 输出里看不出来
  if (name.trim() !== name) return { ok: false, code: E_INVALID_PATH }
  if (utf8ByteLength(name) > MAX_NAME_BYTES) return { ok: false, code: E_INVALID_PATH }
  return { ok: true, name }
}

/**
 * 校验一条**设备上的绝对路径**（目标路径统一入口，裁决 2）。
 *
 * 规则顺序有讲究 —— 先判语法、再判越界，错误码才能分辨：
 * 1. 空 / 纯空白 / 含控制字符 → E_INVALID_PATH；
 * 2. 必须以 '/' 开头（未归一化的相对路径直接拒，不给「猜基准目录」的机会）；
 * 3. 首尾空白 → E_INVALID_PATH（同上，几乎总是误带）；
 * 4. 含 '..' 段 → E_PATH_UNSAFE（**不做归一化放行**：那会让
 *    /sdcard/Download/../../../system 在归一化后变成 /system 并「看起来合法」）；
 * 5. 归一化后是根（'/'、'//'、'/./'）→ E_INVALID_PATH（根不是可操作对象）；
 * 6. 超长 → E_INVALID_PATH。
 *
 * 第 4 条是本模块与 fs/remote 的 normalizeDir 的**刻意差异**：
 * normalizeDir 服务于「用户想看某个目录」（容错优先，'..' 夹住即可）；
 * 本函数服务于「要写/要删某个路径」（严格优先，含 '..' 的值不给操作机会）。
 */
export function checkRemotePath(input: string): PathVerdict {
  if (input === '' || input.trim() === '') return { ok: false, code: E_INVALID_PATH }
  if (hasControlChars(input)) return { ok: false, code: E_INVALID_PATH }
  if (!input.startsWith('/')) return { ok: false, code: E_INVALID_PATH }
  if (input.trim() !== input) return { ok: false, code: E_INVALID_PATH }
  if (input.split('/').some((seg) => seg === '..')) return { ok: false, code: E_PATH_UNSAFE }
  if (utf8ByteLength(input) > MAX_PATH_BYTES) return { ok: false, code: E_INVALID_PATH }

  const normalized = normalizeSegments(input)
  if (normalized === '/') return { ok: false, code: E_INVALID_PATH }
  for (const seg of normalized.slice(1).split('/')) {
    if (utf8ByteLength(seg) > MAX_NAME_BYTES) return { ok: false, code: E_INVALID_PATH }
    /*
     * 段内首尾空白也拒。
     *
     * 为什么连中间段也不放过：Linux 允许 "a /b"，但 ls 输出里根本看不出那个空格，
     * 用户看到的和实际的是两个文件；而拼接、复制、面包屑每一层都会把它「吃掉」。
     * 这类不可见差异在文件管理器里是纯风险，没有可用性收益。（裁决 2 明确要求拒尾随空格。）
     */
    if (seg.trim() !== seg) return { ok: false, code: E_INVALID_PATH }
  }
  return { ok: true, path: normalized }
}

/**
 * checkRemotePath 的抛错版本（给「不处理返回值、错了就该中断」的调用点用）。
 * @throws {Error} E_INVALID_PATH / E_PATH_UNSAFE
 */
export function assertSafeRemotePath(input: string): string {
  const verdict = checkRemotePath(input)
  if (!verdict.ok) throw new Error(verdict.code)
  return verdict.path
}

/**
 * 是否是受保护的根路径（裁决 1）。调用方必须先归一化（用 checkRemotePath 的返回值）。
 *
 * 判据是「归一化后相等」而不是前缀匹配：/sdcard/Android/data/com.example.app
 * 必须放行（用户要能管理单个 App 的文件），只有 /sdcard/Android 这一层本身不可删。
 *
 * ===== 第 3 轮复审 N-2：比较前必须做**别名归一** =====
 * 修前这里只做 normalizeSegments（纯词法折叠），于是同一个目录换个别名写法就能
 * 绕过对象级保护。复审实测 6 种写法里 4 种漏网（它们是**同一批 inode**，真机
 * stat 设备号/inode 全同 64780:2643）：
 *   /sdcard/Android/data                            → true   ✅
 *   /storage/emulated/0/Android/data                → true   ✅
 *   /mnt/sdcard/Android/data                        → false  ❌
 *   /storage/self/primary/Android/data              → false  ❌
 *   /mnt/runtime/default/emulated/0/Android/data    → false  ❌
 *   /mnt/user/0/emulated/0/Android/data             → false  ❌
 * 后果不是文案错，而是服务层直接发出 `rm -rf -- '/mnt/sdcard/Android/data'`
 * （复审假 fs 探针 ok:true；真机 mkdir 正名路径后用别名 rm -rf，正名路径随即
 * No such file）—— 删它等于清掉全部 App 的数据库与扩展包。
 * 所以先 canonicalRemotePath 再查表，与 isRemoteInside /
 * isProtectedTransferDirectory 用同一套归一。
 *
 * 名单里 /sdcard/* 与 /storage/emulated/0/* 两套条目在归一后是冗余的，
 * 但**故意都留着**：这份表同时是给人看的行为清单，
 * isProtectedTransferDirectory 里 `'/sdcard' + normalized.slice(...)` 的对应关系
 * 也依赖它，删条目会让那段代码更难懂。归一后一律以 /storage/emulated/0 一族为准。
 *
 * ===== 取舍（第 3 轮复审 N-1）：保持精确匹配，不做子树判定 =====
 * 子树判定（isProtectedTransferPath）只用于传输通道 —— 那条路的路径完全来自
 * 渲染层入参，攻击面最大。而 fs:* 的操作对象来自用户实际浏览到的位置（例如
 * /data/local/tmp 下的调试文件），把它也改成子树判定，用户就管不了自己浏览到的
 * 文件了。这个分工见 PROTECTED_REMOTE_SUBTREES 的注释，不要为了「统一」抹平。
 */
export function isProtectedRemotePath(path: string): boolean {
  const normalized = canonicalRemotePath(path)
  return PROTECTED_REMOTE_PATHS.includes(normalized)
}

/**
 * 传输通道用的更严判定：精确受保护 **或** 落在系统区子树内。
 *
 * 单独一个函数而不是给 isProtectedRemotePath 加参数：两种语义的调用点
 * 差别很大（一个是「用户点到的对象」，一个是「渲染层给的任意字符串」），
 * 混成一个带 flag 的函数，将来一定会有人传错。
 */
export function isProtectedTransferPath(path: string): boolean {
  if (isProtectedRemotePath(path)) return true
  const normalized = normalizeSegments(path)
  for (const root of PROTECTED_REMOTE_SUBTREES) {
    if (normalized === root || normalized.startsWith(root + '/')) return true
  }
  return false
}

/**
 * 设备上「同一个目录的多个别名」归一成同一个规范路径（复审 C3 别名盲区）。
 *
 * Android 上 /sdcard、/storage/self/primary、/storage/emulated/0、/mnt/sdcard
 * 全都是**同一批 inode** 的软链别名。纯词法比较会把它们当成两个不同目录，
 * 于是 `cp -a /sdcard/A /storage/emulated/0/A/inner` 绕过了自包含判定 ——
 * 复审真机实测 2 秒内目录数从 2 涨到 88。
 *
 * 归一放在**一个函数**里集中做，不在各个调用点各写一份前缀表
 * （那样加一个新别名就要改 N 处，必然漏）。
 *
 * 只处理「用户存储区」这一族别名：/data、/system 等系统区没有等价的用户区别名，
 * 它们由受保护名单拦住，不需要归一。
 */
const USER_STORAGE_ALIASES: readonly string[] = [
  '/sdcard',
  '/storage/self/primary',
  '/storage/emulated/0',
  '/mnt/sdcard',
  // 【第 3 轮复审 N-2】它早就在 PROTECTED_REMOTE_PATHS 里（说明它就是存储根的一个
  // 别名），却漏进了这张表 —— 于是 /mnt/user/0/primary/Android/data 绕过对象级保护。
  '/mnt/user/0/primary',
  '/mnt/user/0/emulated/0',
  '/mnt/runtime/default/emulated/0',
]

/** 用户存储区的规范路径（归一后的唯一名字）。 */
export const CANONICAL_USER_STORAGE = '/storage/emulated/0'

/**
 * **多用户**存储根（终审 I-6）：`/storage/emulated/<N>` 里 N 是数字用户 id。
 *
 * 为什么必须单列一份「模式表」而不是往 USER_STORAGE_ALIASES 里再加几行：
 * 那张表是**精确匹配名单**（7 条已知写法逐个列举），而这里是一族**无限多**的路径
 * （设备上有几个用户就有几个，Android 的工作资料/访客用户都能造出来）。
 * 精确名单永远追不上它 —— 终审实测：`/storage/emulated/1/Android/data` 在
 * isProtectedRemotePath / isProtectedTransferPath / isProtectedTransferDirectory
 * 三个闸门里全是 false（只有 user 0 被归一过），也就是说
 * **只要设备上有第二用户，一条 rm -rf 就能清掉该用户的全部应用数据**。
 * 本机只有 `UserInfo{0}`（pm list users 实测）所以没造成现实危害，
 * 但那只是运气，不是设计。
 *
 * 归一语义：`/storage/emulated/<N>/...` 一律映射到 `/storage/emulated/0/...`，
 * 于是受保护后代（Android / Android/data / Android/obb）对**所有用户**都受保护，
 * 而普通目录（Download / DCIM）对所有用户都照常可写 —— 只补保护，不动可用性。
 *
 * 已知边界（如实记录，不在本轮范围）：`/mnt/user/<N>/(primary|emulated/<M>)`
 * 这一族同样没被归一（终审 I-6 表里第三行），它属于 /mnt 老别名族，
 * 本轮只按裁决修 `/storage/emulated/<N>`。
 */
const MULTIUSER_STORAGE_PATTERNS: readonly { pattern: RegExp; rest: number }[] = [
  // /storage/emulated/<N> 以及它下面的任意后代（rest 捕获组 = 后代部分，含前导 /）
  { pattern: /^\/storage\/emulated\/\d+(\/.*)?$/, rest: 1 },
]

/**
 * 路径归一（词法 + 别名 + 多用户模式）。只在比较前用，**不改变实际执行的路径** ——
 * 执行时仍用用户/系统给的原路径，否则会改变用户看到的目录名。
 */
export function canonicalRemotePath(path: string): string {
  const normalized = normalizeSegments(path)
  for (const alias of USER_STORAGE_ALIASES) {
    if (normalized === alias) return CANONICAL_USER_STORAGE
    if (normalized.startsWith(alias + '/')) {
      return CANONICAL_USER_STORAGE + normalized.slice(alias.length)
    }
  }
  // 【终审 I-6】多用户存储根：精确名单之后的模式匹配（两者互补，顺序不影响结果）
  for (const { pattern, rest } of MULTIUSER_STORAGE_PATTERNS) {
    const matched = pattern.exec(normalized)
    if (matched === null) continue
    return CANONICAL_USER_STORAGE + (matched[rest] ?? '')
  }
  return normalized
}

/**
 * 受保护的**系统区子树**：写文件进去一定失败（或危险），而且与「用户存储区根」不同。
 *
 * 与 PROTECTED_REMOTE_SUBTREES 的区别：这里额外把根 `/` 与 `/storage`、`/mnt`
 * 这类**挂载点容器**算进来（往 /storage 里写文件没有意义，只会落到某个挂载点的根部），
 * 但**不**包含 /sdcard、/storage/emulated/0 这类用户可见的存储根 —— 那些必须可写。
 */
function isSystemSubtree(path: string): boolean {
  const normalized = normalizeSegments(path)
  if (normalized === '/') return true
  if (normalized === '/storage' || normalized === '/mnt') return true
  for (const root of PROTECTED_REMOTE_SUBTREES) {
    if (normalized === root || normalized.startsWith(root + '/')) return true
  }
  return false
}

/**
 * 这个**目录**能不能作为传输/复制的目标目录（复审 N2 / N3）。
 *
 * 与 isProtectedTransferPath 的分工：
 *   - isProtectedTransferPath 判「**这个对象本身**能不能被读/写/删」——
 *     `/sdcard` 是一个受保护对象（不能删它、不能把它当文件写）；
 *   - 本函数判「**能不能往这个目录里放一个文件**」——`/sdcard` 是用户存储区的根，
 *     往里放文件完全正常（首屏默认目录就是它），必须放行。
 *
 * 修前把两者混成一个判定，结果是「在首屏默认目录上传文件」直接
 * E_PROTECTED_PATH，文案还说「禁止删除或移动」——用户明明在做上传。
 *
 * 但两类仍然禁止：系统区（/data、/system…）与挂载点容器（/、/storage、/mnt）；
 * 以及 `/sdcard/Android` 这类受保护的存储子目录（往里丢文件没有合理场景）。
 */
export function isProtectedTransferDirectory(dir: string): boolean {
  const normalized = canonicalRemotePath(dir)
  if (isSystemSubtree(normalized)) return true
  /*
   * 用户存储区**根本身**可写（首屏默认目录就是它），
   * 但它的受保护子目录（/storage/emulated/0/Android 等）不可写 ——
   * 归一后按 /sdcard 那一族名字去查同一份名单，避免维护两份。
   */
  if (normalized === CANONICAL_USER_STORAGE) return false
  const asUserPath = '/sdcard' + normalized.slice(CANONICAL_USER_STORAGE.length)
  return PROTECTED_REMOTE_PATHS.includes(asUserPath)
}

/**
 * child 是否落在 parent 之内（含相等）—— 复制/移动的自包含判定（裁决 3 / C3）。
 *
 * ===== 为什么必须有这一条 =====
 * `cp -a A A/inner` 会让 toybox 无界递归：真机实测一分钟内 122MB、深度 16385 层，
 * 最后因 Too many open files 才停，而产物层数太深，**连删除本身都会失败**。
 * 用户的操作路径极其自然：在 A 里新建 inner、全选、复制到 inner。
 * 所以必须在发命令之前拒掉，而不是指望 cp 自己出错。
 *
 * 实现注意：
 * 1. **必须比完整目标路径**（`remoteJoin(dstDir, name)`），不是只比 dstDir ——
 *    dstDir 是 A/inner 而目标是 A/inner/A 的情况同样要拦；
 * 2. **含 '..' 的输入保守返回 true**：这个函数是「最后一道闸门」，看不懂就拒；
 *    真正的路径语法校验在 checkRemotePath，不在这里重复。
 */
export function isRemoteInside(parent: string, child: string): boolean {
  if (parent === '' || child === '') return false
  const parentSeg = parent.split('/')
  const childSeg = child.split('/')
  if (parentSeg.some((seg) => seg === '..') || childSeg.some((seg) => seg === '..')) return true
  /*
   * 【复审 C3 别名盲区】比较前先做**别名归一**。
   *
   * /sdcard 与 /storage/emulated/0 是同一批 inode 的软链别名，纯词法比较会把
   * `cp -a /sdcard/A /storage/emulated/0/A/inner` 判成「不在自己里面」而放行 ——
   * 复审真机实测 2 秒内目录数从 2 涨到 88。
   * 归一集中在 canonicalRemotePath 里做，这里只调用它。
   *
   * **纯词法判定，中间符号链接为已知边界**（做不了完全防御）：
   * 路径**中间**的符号链接（如 /data/link -> real）词法上完全看不出来，
   * 要识别得走设备侧 readlink -f 往返，成本高于收益；已在报告里记为已知限制。
   * 这类输入要求用户手输一条带中间链接的路径，触发面远小于别名。
   */
  const p = canonicalRemotePath(parent)
  const c = canonicalRemotePath(child)
  if (p === c) return true
  // 父是根时一切都是它的后代（/ 的唯一特殊情形）
  if (p === '/') return true
  return c.startsWith(p + '/')
}

/** 路径的最后一段（名字）；根返回空串。 */
export function remoteBaseName(path: string): string {
  const normalized = normalizeSegments(path)
  if (normalized === '/') return ''
  const index = normalized.lastIndexOf('/')
  return normalized.slice(index + 1)
}

/** 父目录；根没有父目录（返回 null）。 */
export function remoteParent(path: string): string | null {
  const normalized = normalizeSegments(path)
  if (normalized === '/') return null
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

/** 拼接目录与名字（名字是绝对路径时直接采用，与 fs/remote 的 joinPath 语义一致）。 */
export function remoteJoin(dir: string, name: string): string {
  if (name.startsWith('/')) return normalizeSegments(name)
  return normalizeSegments(dir + '/' + name)
}

/**
 * 归一化一条**本地**路径（裁决 5）。
 *
 * 为什么不用 node:path：本文件要被渲染层编译，不许 import node 模块；
 * 而 Windows 与 POSIX 两种分隔符都要认（用户的 home 在 Windows 上是 C:\Users\x）。
 * 这里只做**词法**归一化（折叠分隔符、消掉 . 与 ..、去尾分隔符），
 * **不做符号链接解析** —— 那是主进程 realpath 的活（见 electron/fs/local.ts）。
 */
export function normalizeLocalPath(input: string): string {
  const unified = input.replace(/\\/g, '/')
  const isDrive = /^[A-Za-z]:/.test(unified)
  const parts = unified.split('/')
  const segments: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]
    // 盘符段原样保留（它是「根」而不是可回退的目录名）
    if (i === 0 && isDrive) { segments.push(seg); continue }
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      // 回退到盘符/根就停住：'..' 不能把 C:\ 变成空串
      if (segments.length > (isDrive ? 1 : 0)) segments.pop()
      continue
    }
    segments.push(seg)
  }
  if (isDrive) return segments.length === 1 ? segments[0] + '/' : segments.join('/')
  return '/' + segments.join('/')
}

/**
 * target 是否落在 root 之内（含相等，裁决 5）。
 *
 * 两条容易写错的地方：
 * 1. **不能只做字符串前缀判断**：'/home/me2' 以 '/home/me' 开头，但它不在 root 内。
 *    必须补一个分隔符再比（或完全相等）。
 * 2. **Windows 大小写不敏感**：'c:\users\me' 与 'C:\Users\Me' 是同一个目录。
 *    盘符存在时按小写比较。
 *
 * 注意：这里比较的是**词法**路径。符号链接逃逸必须由调用方先 realpath 再比
 * （词法函数看不到链接，这是它的能力边界，不能假装它能防住）。
 */
export function isInsideRoot(root: string, target: string): boolean {
  const windows = /^[A-Za-z]:/.test(root) || /^[A-Za-z]:/.test(target)
  const norm = (value: string): string => {
    const n = normalizeLocalPath(value)
    return windows ? n.toLowerCase() : n
  }
  const r = norm(root)
  const t = norm(target)
  if (t === r) return true
  // 根的形态有三种：/、C:/、/home/me —— 统一成「以分隔符结尾」再比前缀
  const prefix = r.endsWith('/') ? r : r + '/'
  return t.startsWith(prefix)
}
