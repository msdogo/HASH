# Spike 结论：scrcpy 窗口能否嵌入 Electron（方案 C 可行性）

日期：2026-11-26 · 结论：**可行**（但必须改窗口样式，见第四节）

## 一、要验证的唯一问题

scrcpy 的实时画面在被 Win32 变成我们窗口的子窗口之后，**会不会变成纯黑**。

这是方案 C（「左画面 + 右侧边栏」单窗口形态）的成败闸门：
黑屏则整条路作废，只能退回「原生窗口 + 快捷键」。

## 二、实验设置

| 项 | 值 |
|---|---|
| scrcpy | 5.0.1（scrcpy-win64-v5.0.1.zip，HTTP 200 已验证） |
| adb | 仓库内置 `resources/platform-tools/adb.exe`，经 `ADB` 环境变量传入 |
| 设备 | 9N9CN2G0012A3P（DJI RC Plus 2，Android 11） |
| 启动参数 | `--window-borderless --window-title=adbfm-spike-* --no-audio --max-size=1024` |
| 宿主 | PowerShell + WinForms 窗口（900×700，洋红底色，便于识别未覆盖区域） |

## 三、第一次实验（**结论是假阳性，记录在此以免重犯**）

只调 `SetParent(child, host)` + `MoveWindow`，截图看起来完美：画面填满宿主、洋红只剩边框。

但严格复位检验推翻了它：

```
SetParent_ret=65548
GetParent=0            ← 证明根本没有父子关系
host_hwnd=2296618
parent_equals_host=False
after_move_child_rect=208,181   ← 宿主移动后子窗口纹丝不动
```

真相：`SetParent` 对**带 `WS_POPUP` 样式**的窗口只是把坐标改写成屏幕绝对坐标，
并不真正建立父子关系 —— 窗口仍然独立浮在上面，看起来「嵌进去了」纯属视觉巧合。
**只靠 SetParent 的方案是假的。**

## 四、修正后的实验（真嵌入）

在 `SetParent` **之前**改写窗口样式：

```c
GWL_STYLE = -16
style = GetWindowLongPtr(hwnd, GWL_STYLE)
style |=  WS_CHILD        // 0x40000000
style &= ~WS_POPUP        // 0x80000000
style &= ~WS_CAPTION      // 0x00C00000
style &= ~WS_THICKFRAME   // 0x00040000
SetWindowLongPtr(hwnd, GWL_STYLE, style)
SetParent(hwnd, host)
MoveWindow(hwnd, 0, 0, 820, 640, true)
```

## 五、结果

**画面正常显示，未黑屏；父子关系真实建立。**

```
child_hwnd=6755620
old_style=0xB6CF0000
new_style=0x760B0000            ← WS_CHILD 已置位、POPUP/CAPTION/THICKFRAME 已清
GetParent=10884256 host=10884256 equal=True      ← 真父子
rect_before_move=208,181
rect_after_move=658,351
FOLLOWS_PARENT=True             ← 宿主移动，画面跟随
sampled=768 darkPct=0.1 magentaPct=0             ← 无黑屏、无宿主底色漏出
```

证据：`docs/superpowers/spike/scrcpy-embed-fixed.png`
（设备桌面完整可见：状态栏 3:02 / 54% / 100%，豆包输入法、MSDK飞行功能、TJH Pilot）

渲染后端仍是 **direct3d11**（`Renderer: direct3d11` / `Video decoding: d3d11va`），
说明 **D3D11 交换链在真子窗口下能正常呈现**，不需要换 render-driver。

## 六、对实现的四条硬约束（已写入计划）

1. **必须先改样式再 SetParent**，只调 SetParent 是假嵌入。顺序：改样式 → SetParent → MoveWindow。
2. **`ADB` 环境变量必须是 Windows 原生路径**（`C:\\...\\adb.exe`）。
   传 MSYS 路径（`/e/AI/...`）会报 `CreateProcessW() error 2` / `Command not found` ——
   scrcpy 直接交给 CreateProcessW，不做路径转换。生产代码用 `path.win32` 形式。
3. **`--window-borderless` 生效**，标题仍可被 `EnumWindows` 读到 ——
   「按唯一 token 标题找 HWND」这条定位策略成立。但注意 scrcpy 建窗需要时间，
   必须轮询（实测 6~8s 内出现），找不到要超时退出而不是死等。
4. **不需要 `--render-driver`**；默认 d3d11 就行，少一个变量。

## 七、残余风险（进计划的风险清单）

- 高 DPI 屏幕下 `MoveWindow` 需要物理像素换算（CSS px × scaleFactor）。
  本次宿主是 100% 缩放，未覆盖 125%/150% —— 任务 11 必须实测。
- scrcpy 崩溃/退出后子窗口消失，宿主会露出自己的底色 —— 必须切错误态。
- koffi 的 `.node` 不能留在 asar 里，需要 `asarUnpack`。
