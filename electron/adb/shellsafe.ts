// 契约：shellQuote 只做 POSIX sh 的「单词转义」。
// 调用方必须先把设备侧不可信文件名过一遍本函数，再拼进 adb shell 命令串；
// 但 adb shell 是「单行文本」协议，换行/回车会切断命令、空字节连 argv 都过不去，
// 因此这三类字符无法安全表达 —— 直接抛错，而不是转义后放行。
const SQ = String.fromCharCode(39)            // 单引号
const ESCAPED = SQ + '"' + SQ + '"' + SQ      // 展开为 '"'"' 的等价串

export const E_INVALID_PATH = 'E_INVALID_PATH'

/**
 * 把 value 转义成一个 POSIX shell 单词（含首尾单引号）。
 * @throws {Error} E_INVALID_PATH 当 value 含 \n / \r / \0
 */
export function shellQuote(value: string): string {
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    throw new Error(E_INVALID_PATH)
  }
  return SQ + value.split(SQ).join(ESCAPED) + SQ
}
