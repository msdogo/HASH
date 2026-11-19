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
  '/mnt',
  '/mnt/user/0/primary',
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

/** 是否是受保护的根路径（裁决 1）。调用方必须先归一化（用 checkRemotePath 的返回值）。 */
export function isProtectedRemotePath(path: string): boolean {
  const normalized = normalizeSegments(path)
  return PROTECTED_REMOTE_PATHS.includes(normalized)
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
