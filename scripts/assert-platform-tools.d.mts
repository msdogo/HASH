/** 手写类型声明：tsconfig 不收录 scripts/，测试里 import 需要它。 */
export interface AssertOptions {
  root?: string
  probe?: (exePath: string) => { ok: boolean; version?: string; detail?: string }
}
export interface AssertResult {
  ok: true
  path: string
  version: string
}
export function assertPlatformTools(options?: AssertOptions): AssertResult
