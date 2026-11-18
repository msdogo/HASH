// POSIX shell 单引号转义：把 value 包进单引号，内部单引号用 '\"'\"' 序列闭合再重开。
// 这是「绝不把用户输入拼进 shell 字符串」红线的第一道闸：所有动态路径/文件名都必须先经此函数。
const SQ = String.fromCharCode(39)            // 单引号
const ESCAPED = SQ + '"' + SQ + '"' + SQ      // 展开为 '"'"' 的等价串

export function shellQuote(value: string): string {
  return SQ + value.split(SQ).join(ESCAPED) + SQ
}
