/** 手写类型声明：tsconfig 不收录 scripts/，测试里 import 需要它。 */
export interface AssertOptions {
  root?: string
  probe?: (exePath: string) => { ok: boolean; version?: string; detail?: string }
}
export interface AssertResult {
  ok: true
  path: string
  /**
   * 版本号可缺省（复审 Minor-6）。
   *
   * 默认的 probeVersion 在 ok:true 时一定会给出 version，所以生产路径上它总是存在；
   * 但注入的 probe（单测用的口子）可以返回 { ok: true } 而不带 version，实现会原样透出。
   * 「生产不可达」不等于「类型可以写错」：声明成必填会让将来有人写
   * result.version.toLowerCase() 时踩空。这里如实标注为可选，调用方必须处理缺省。
   */
  version?: string
}
export function assertPlatformTools(options?: AssertOptions): AssertResult
