/**
 * electron-builder 的 beforePack 钩子（审查 I1 的第二道闸门）。
 *
 * 独立脚本 scripts/assert-platform-tools.mjs 只在 npm run dist 的脚本链里生效；
 * 有人直接跑 `npx electron-builder` 就绕过了它。钩子把同一份断言挂到打包流程里，
 * 覆盖这条旁路。
 *
 * 用 .cjs 是因为本仓库 package.json 是 type: module —— electron-builder 用 require 加载
 * 钩子文件时，.js 会被当成 ESM 而失败；.cjs 明确走 CommonJS，与 electron-builder 的
 * 加载方式无关。断言本体用动态 import 复用 .mjs，避免两处各写一份判定逻辑。
 */
module.exports = async function beforePack() {
  const { assertPlatformTools } = await import('./assert-platform-tools.mjs')
  try {
    const result = assertPlatformTools()
    console.log('[beforePack] 内置 adb 校验通过：' + result.path + '（adb ' + result.version + '）')
  } catch (err) {
    /*
     * 失败的完整指引先自己打到 stderr，再抛一个**单行**错误。
     *
     * 为什么不让 electron-builder 去打印多行 message：它会把 Error.message
     * 逐行加上缩进前缀输出，长指引会被挤成一大段难以阅读的文本（实测如此）。
     * 自己打一次能保证指引原样可读；抛出的单行 Error 只负责给出非零退出码与定位点。
     */
    const full = err instanceof Error ? err.message : String(err)
    console.error(full)
    throw new Error('内置 adb 不可用，已中止打包（缺少 resources/platform-tools/adb.exe，详见上方指引）')
  }
}
