/**
 * electron-builder 的 afterPack 钩子（复审 Minor-1）。
 *
 * 为什么还需要这一道：前面三道闸门（fetch / assert-platform-tools / beforePack）
 * 校验的全是**源目录** resources/platform-tools。它们挡不住「源目录没问题、
 * 但产物里没有」这类失败 —— 只要 extraResources 的 to 或类型被改坏，
 * 三道闸门照样全绿，而装出来的包里没有 adb。这与 I1 是同一类失败：
 * 构建成功、产物生成、装上才发现没 adb。
 *
 * afterPack 对 nsis 与 portable 都会跑，此时 context.appOutDir 指向
 * release/win-unpacked —— 它的 resources/ 就是最终安装目录里 resources/ 的真实内容。
 * 只要这里带上了 platform-tools，两种产物就都会带上。
 *
 * 判定复用了 assert-platform-tools.mjs 的同一份逻辑（root 指到 appOutDir，
 * 于是它去找 appOutDir/resources/platform-tools/adb.exe），不写第二套判断。
 */
module.exports = async function afterPack(context) {
  const { assertPlatformTools } = await import('./assert-platform-tools.mjs')
  const appOutDir = context.appOutDir
  try {
    const result = assertPlatformTools({ root: appOutDir })
    console.log('[afterPack] 产物内置 adb 校验通过：' + result.path + '（adb ' + result.version + '）')
  } catch (err) {
    const full = err instanceof Error ? err.message : String(err)
    console.error('')
    console.error('==== 打包产物缺少内置 adb ====')
    console.error(full)
    console.error('')
    console.error('源目录 resources/platform-tools 可能没问题，但这个包出了别的问题：')
    console.error('  - electron-builder.json 的 extraResources.to 被改坏了？')
    console.error('    （当前应为 { "from": "resources/platform-tools", "to": "platform-tools" }）')
    console.error('  - 产物目录：' + appOutDir)
    console.error('期望路径：' + appOutDir + '\\resources\\platform-tools\\adb.exe')
    console.error('')
    throw new Error('打包产物里没有内置 adb，已中止（详见上方说明）')
  }
}
