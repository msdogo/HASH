/**
 * after-pack.cjs 的手写类型声明（复审 Minor-5）。
 *
 * tsconfig.node.json 不收录 scripts/，测试里 import 这个 .cjs 时需要声明，
 * 否则报 TS7016。与 assert-platform-tools.d.mts 同一处理方式。
 */
export interface AfterPackContext {
  appOutDir: string
}

/** probe 只为单测注入；生产路径由 electron-builder 传 context、不带 options。 */
export interface AfterPackOptions {
  probe?: (exePath: string) => { ok: boolean; version?: string; detail?: string }
}

declare function afterPack(context: AfterPackContext, options?: AfterPackOptions): Promise<void>

export = afterPack
