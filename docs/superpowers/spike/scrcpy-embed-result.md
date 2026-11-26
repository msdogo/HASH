# Spike 结论：scrcpy 窗口能否嵌入 Electron（方案 C 可行性）

日期：2026-11-26 · 结论：**可行**

## 一、要验证的唯一问题

scrcpy 的实时画面在被 Win32 `SetParent` 变成子窗口之后，**会不会变成纯黑**。

这是方案 C（截图里那种「左画面 + 右侧边栏」单窗口形态）的成败闸门：
黑屏则整条路作废，只能退回「原生窗口 + 快捷键」。

## 二、实验设置

| 项 | 值 |
|---|---|
| scrcpy | 5.0.1（scrcpy-win64-v5.0.1.zip） |
| adb | 仓库内置 `resources/platform-tools/adb.exe`，经 `ADB` 环境变量传入 |
| 设备 | 9N9CN2G0012A3P（DJI RC Plus 2，Android 11） |
| 启动参数 | `--window-borderless --window-title=adbfm-spike-7f3a --no-audio --max-size=1024` |
| 宿主 | PowerShell + WinForms 窗口（1100×760，洋红背景，便于识别未覆盖区域） |
| 嵌入方式 | `EnumWindows` 按标题精确匹配 → `SetParent` → `MoveWindow(0,0,1000,700)` |

## 三、结果

**画面正常显示，未黑屏。**

- scrcpy 实际选的渲染后端是 **direct3d11**（日志：`Renderer: direct3d11` / `Video decoding: d3d11va`），
  即使传了 `--render-driver=opengl` 也回落到 d3d11 —— 说明 **D3D11 交换链在 SetParent 下能正常工作**。
- 宿主窗口的洋红背景只在边缘（标题栏与外框）可见，画面区域被设备桌面完全填满：
  可见 Android 桌面（豆包输入法 / MSDK飞行功能 / TJH Pilot）与状态栏 2:58 / 56% / 100%。
- 暗像素采样：1750 个采样点中纯黑仅 **0.4%**（远低于「黑屏」应有的 >90%）。

证据：
- 截图 `docs/superpowers/spike/scrcpy-embed-shot.png`
- scrcpy 日志 `docs/superpowers/spike/scrcpy-spike.log`

## 四、附带确认的两件事

1. **`ADB` 环境变量必须是 Windows 原生路径**。
   传 MSYS 路径（`/e/AI/.../adb.exe`）会让 scrcpy 报 `CreateProcessW() error 2` / `Command not found`，
   因为它直接交给 CreateProcessW，不做 MSYS 转换。**生产代码里必须用 `path.win32` 形式的绝对路径。**
2. **`--window-borderless` 生效**，窗口无系统边框，标题仍可被 `EnumWindows` 读到 —— 
   「按唯一 token 标题找 HWND」这条定位策略成立，不必依赖窗口类名或进程枚举顺序。

## 五、对计划的约束（已写入实现计划）

- 嵌入后需要处理 **DPI 换算**：宿主矩形的 CSS px × `scaleFactor` = `MoveWindow` 的物理 px。
- scrcpy 崩溃 / 退出时，宿主窗口会露出自己的底色 —— 必须切到错误态，不能留一块黑区。
- 无需 `--render-driver=opengl`；默认（d3d11）即可，参数里**不加**这个开关，减少一个变量。
