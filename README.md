# HASH

基于 ADB 的 Android 手机文件管理桌面应用。

## 功能

- 多设备同时管理（左侧设备栏 + 全部设备总览）
- 手机文件浏览：列表、排序、显示/隐藏文件、当前目录文件名搜索
- 上传 / 下载 / 新建文件夹 / 重命名 / 删除 / 复制 / 移动
- 多选下载、全选；从资源管理器拖入上传、拖出下载
- 传输队列与进度、并发控制（单设备 1 路、全局 3 路）
- 单机截图 / 录屏（截图自动复制路径）
- 应用管理：列出、详情、拉取 APK、安装、强制停止、清空数据、卸载、启动
- **投屏（内嵌窗口 + 设备按键侧边栏）**：画面用 scrcpy 原生渲染后嵌进自绘窗口，
  侧边栏六个键（返回 / 主页 / 后台 / 音量± / 电源）直接下发到设备；
  多台设备可同时投屏，每台一个窗口
- 设置页：默认下载路径、adb 状态、版本号

> 投屏的入口有两个：文件页工具条的「投屏」按钮（作用于当前设备），
> 以及**设备栏右键**某台设备（不改变当前选中，直接投那台）。

## 环境

- Windows 10/11（仅在 Windows 上验证过）
- Node.js 22+
- USB 连接手机并开启 USB 调试

内置 adb（`resources/platform-tools/`）与 scrcpy（`resources/scrcpy/`），
无需另装 Android SDK，也不需要单独安装 scrcpy。

安装包约 **200 MB**（内置 adb ≈110 MB + 内置 scrcpy ≈17 MB + Electron 运行时）。
选内置而不用「让用户自己装」的原因：投屏对 scrcpy 版本敏感（命令行参数跨大版本变过），
随包分发的那份是唯一被验证过的一版。

## 快速开始

```bash
npm ci
npm run fetch-platform-tools   # 下载内置 adb，首次必需
npm run fetch-scrcpy           # 下载内置 scrcpy（投屏用），首次必需
npm run dev
```

## 构建

```bash
npm run dist
```

产物在 `release/`：NSIS 安装包 + 便携版。

打包前会跑两道断言（`assert-platform-tools` / `assert-scrcpy`）：
内置 adb 与内置 scrcpy 必须在位且能跑，否则中止 —— 缺任何一个都会打出一个
「能装、能开、但投屏或设备列表报错」的包。

## 版本号

`npm run dist` 前会校验版本号必须比上次打包的新，否则构建中止。

```bash
npm run bump              # 按上一条 commit 前缀自动升
npm run bump -- 0.3.0     # 手动指定
```

| commit 前缀 | 升位 |
| --- | --- |
| `feat:` | minor |
| `fix:` / `refactor:` / `docs:` 等 | patch |
| `feat!:` / `BREAKING CHANGE` | major |

## 测试

```bash
npm test
npx tsc -b --force
```
