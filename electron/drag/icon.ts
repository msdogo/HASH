/**
 * 拖拽时跟随光标的图标（32×32 PNG，内联成 data URL）。
 *
 * 为什么内联而不是放一个资源文件：
 *   1. startDrag 的 icon 参数在主进程同步取用，多一次磁盘读取只会让拖拽更晚开始；
 *   2. electron-builder 的 files 清单只打包 dist/dist-electron，
 *      放 resources/ 还要改打包配置 —— 一个 200 字节的图标不值得多一条打包路径；
 *   3. macOS 要求图标非空（electron.d.ts: "The image must be non-empty on macOS"），
 *      内联常量保证任何平台都拿得到一张合法 PNG。
 *
 * 生成方式：32×32 的 RGBA 图（深蓝底、浅色横条），zlib 压缩后按 PNG 规范封包。
 * 内容不可读没关系 —— 它只是拖拽光标上的一个小方块。
 */
export const DRAG_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAU0lEQVR4nGNIWPrr/0BihkHjADmrPLriUQeMOmDUAQQd8PT5a6rjUQcMrTQw6oABd8CAJ8JRBwx4Ghh1wIA7YMAT4agDBjwNjDqA7g4YKDzgDgAAVO6o5ZgtSPsAAAAASUVORK5CYII='
