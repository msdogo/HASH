# HASH

基于 ADB 的 Android 手机文件管理桌面应用。

## 功能

- 多设备同时管理（左侧设备栏 + 全部设备总览）
- 手机文件浏览：列表、排序、显示/隐藏文件、当前目录文件名搜索
- 上传 / 下载 / 新建文件夹 / 重命名 / 删除 / 复制 / 移动
- 多选下载、全选；从资源管理器拖入上传、拖出下载
- 传输队列与进度、并发控制（单设备 1 路、全局 3 路）
- 设置页：默认下载路径、adb 状态、版本号

## 环境

- Windows 10/11（仅在 Windows 上验证过）
- Node.js 22+
- USB 连接手机并开启 USB 调试

内置 adb（`resources/platform-tools/`），无需另装 Android SDK。

## 快速开始

```bash
npm ci
npm run fetch-platform-tools   # 下载内置 adb，首次必需
npm run dev
```

## 构建

```bash
npm run dist
```

产物在 `release/`：NSIS 安装包 + 便携版。

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

## 未实现

设备端递归搜索、内置终端、logcat、root 模式、跨设备直传、应用管理、无线配对。
