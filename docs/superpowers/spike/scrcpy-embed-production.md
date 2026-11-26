# scrcpy 嵌入 —— 生产代码验证报告

> 与 `docs/superpowers/spike/scrcpy-embed-result.md` 的关系：那份是「可行性 spike」（PowerShell 复刻），
> 这份是**跑真正要打包进应用的那份代码**的验证记录。两份都要留着，理由见文末「为什么要两份」。

日期：2026-11-26 · 设备：9N9CN2G0012A3P（DJI RC Plus 2）· scrcpy 5.0.1

## 一、结论

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| `findWindowByTitle` 能在 scrcpy 建窗口后找到它 | ✅ | `found child hwnd=4263136` |
| `embedWindow` 返回 ok 且 `GetParent(child) === host` | ✅ | `embedded ok`（函数内部断言，不成立就返回失败） |
| 宿主窗口移动后子窗口矩形跟着变 | ✅ | `before={left:700,top:46} after={left:200,top:160}` → `follows=true` |
| `resizeEmbedded` 能重新铺满 | ✅ | `resized ok` |
| 被验证的是生产模块本身，不是复刻 | ✅ | 冒烟脚本 `import` 的是 `electron/mirror/embed.ts` 的构建产物 |

完整输出（`.superpowers/sdd/mirror-smoke/main.mjs`，已随仓库保留）：

```
[prod-smoke] scrcpy pid=11116
[prod-smoke] host window ready
[prod-smoke] found child hwnd=4263136
[prod-smoke] host hwnd=5182488
[prod-smoke] embedded ok
[prod-smoke] before={"left":700,"top":46,"right":1164,"bottom":986} after={"left":200,"top":160,"right":664,"bottom":1100} follows=true
[prod-smoke] resized ok
[prod-smoke] DONE {"scrcpy":true,"found":true,"embedded":true,"follows":true,"error":null}
```

## 二、这一轮新发现的两个坑（都已在生产代码里修掉）

### 坑 1：koffi 的 `void*` 不是数字

第一版 `embed.ts` 直接 `Number(lib.GetParent(hwnd))`，运行时抛：

```
[smoke] FAILED Cannot convert object to primitive value
```

koffi 把指针交回来是一个**外部对象**（不是 Number、不是 BigInt），
对它做 `Number()` / 字符串拼接都会命中 JS 的 `toPrimitive` 而失败。

修法：所有指针必须过 `koffi.address()` 再转 number：

```ts
address: (ptr) => Number(koffi.address(ptr)),
```

并且 **`GetParent` 的返回值也要过一遍** —— 那里最容易被忽略，
因为它的类型看起来像「能直接比较」：

```ts
const parent = l.address(l.GetParent(childHwnd))
if (parent !== hostHwnd) return { ok: false, reason: 'GetParent mismatch' }
```

不这么写的话，`parent !== hostHwnd` 会因为「对象 vs 数字」永远为真 ——
**嵌入成功也会被判成失败**，症状是「投屏窗口一闪就关」。

### 坑 2：`EnumWindows` 的返回值语义

`EnumWindows` 的返回 `false` 有两种含义：回调要求提前停止，**或者**枚举本身失败。
实测（`micro.cjs` 探针）表明回调返回 `false` 时 `EnumWindows` 的整体返回值是 `false`：

```
[micro] ok=false count=200 sample="GDI+ Window (ImeService.exe)"
```

所以**不能**用 `EnumWindows` 的返回值判断成败 —— 必须只看回调里有没有命中。
生产代码就是这么写的（`findWindowOnce` 只返回 `found`）。

## 三、投屏窗口布局的真渲染证据

自动化冒烟证明了「原生窗口能嵌进来」，但没有证明「我们这个窗口画对了」。
补了一张`capturePage()` 的真实截图（跑的是 `dist/` 里的**实际构建产物**，
hash 走 `#/mirror/<serial>`，`window.api` 用最小替身）：

![投屏窗口布局](./mirror-window-layout.png)

从截图与 DOM 断言可以确认（不是靠肉眼猜）：

| 断言 | 实测值 |
| --- | --- |
| 侧边栏在**右**侧 | `nav.getBoundingClientRect().right === 420`（等于窗口宽度 420） |
| 六个按键全部渲染 | `title` 依次为 返回 / 主页 / 后台 / 音量减 / 音量加 / 电源 |
| 画面区是**空的** | `body.innerText` 只有「投屏中 / serial / 正在启动投屏…」 |
| 顶栏有窗口控制 | 最小化 / 最大化 / 关闭 三个按钮 |

这张图同时也说明了一个**已知限制**：画面区在 scrcpy 窗口嵌入前只有一行提示文字，
嵌入后会被原生子窗口完全盖住 —— 所以提示不需要（也没有）隐藏逻辑。

## 四、`npm run dev` 在这台机器上起不来的原因（与投屏无关，如实记录）

用 `ADB_FM_DEBUG_PORT=xxxx npm run dev` 启动后进程立刻退出、无窗口。
根因是**单实例锁**：机器上已经装着并运行着 `C:\Program Files\HASH\HASH.exe`
（PID 41376，2026-11-25 启动），它持有 `requestSingleInstanceLock` 的命名互斥体，
开发实例拿到 `false` 就按设计 `app.quit()` 了。

验证方式是绕过 dev server、直接用 electron 跑构建产物 + 独立的 `--user-data-dir`，
嵌入冒烟就是这么跑起来的（见上）。这不影响结论，但下次做界面手工验证前，
**必须先把已安装的 HASH 退掉**（托盘菜单「退出」），否则开发实例永远静默退出。

## 六、装正式包实测（0.10.3）—— 修掉的四个真缺陷

上面三节都是「跑构建产物」。这一节是**装完安装包、双击桌面图标**之后测的。
实机测试暴露了四个在这之前完全看不见的缺陷，全部已修并补了门禁：

![装正式包后的投屏窗口](./mirror-installed-final.png)

| # | 缺陷 | 症状 | 根因 | 修法 |
| --- | --- | --- | --- | --- |
| 1 | 顶栏被画面盖住 | 「投屏中 / 关闭按钮」整条消失，窗口没法关 | 嵌入矩形的 y 从 0 开始，原生子窗口永远画在渲染层之上 | `availableRect()` 减掉 `HEADER_HEIGHT`（有单测） |
| 2 | 巨幅黑边 | 16:10 横屏画面塞进竖长窗口，上下各约 260px 黑带，画面只占中间一小块 | 直接把窗口 MoveWindow 成可用区域那么大，忽略视频宽高比 | `fitRect()` 按视频宽高比缩放并居中（有单测） |
| 3 | 窗口尺寸不匹配 | 即使按比例居中了，竖长窗口里画面还是很小 | 窗口尺寸是硬编码的 480×900 | `windowFitSize()` 让窗口尺寸由视频尺寸决定（有单测） |
| 4 | 量到中间态尺寸 | 窗口缩到 328×328，画面更小 | scrcpy 先建小窗、拿到首帧后才 resize；第一次实现一找到窗口就量尺寸 | `measureStableVideoRect()`：连续两次量到同一尺寸且边长 ≥320 才采信 |

另有一个**看不见但会累积**的缺陷：

| # | 缺陷 | 症状 | 修法 |
| --- | --- | --- | --- |
| 5 | 已退出的 scrcpy 留在全局跟踪集合里 | `adbChildCount` 只增不减；退出时对死进程多调一次 taskkill | `runner.ts` 的 `settle()` 里调 `untrackChild`（`tests/mirror-tracking.test.ts` 锁住，并用变异验证过：删掉那行测试立刻红） |

### 实测确认可用的行为（都是真机操作，不是推断）

| 验收项 | 方法 | 结果 |
| --- | --- | --- |
| 画面嵌进自建窗口 | `EnumChildWindows` + `GetWindowThreadProcessId` | 子窗口 hwnd=24578530，pid 属于 scrcpy，class=SDL_app，visible=True |
| 尺寸跟随宿主 | `MoveWindow` 把宿主拉大 300×200 | 子窗口 1024×640 → 1324×828，且坐标跟着宿主移动 |
| 返回键真的到设备 | 点侧边栏「返回」→ `dumpsys activity` | 前台从 TJH 应用切走 |
| 主页键真的到设备 | 点「主页」→ `dumpsys activity` | `mResumedActivity: com.android.launcher3/.uioverrides.QuickstepLauncher` |
| 关窗口 → scrcpy 进程消失 | 点自绘顶栏「关闭」→ `tasklist` | 我们那个 scrcpy pid 消失（另一台是用户自己在跑的 Escrcpy，不受影响） |

### 环境里挖出来的两个坑（不是代码缺陷，但会浪费半天）

1. **设备会自己休眠**。第一次截图是一片黑，不是投屏坏了 —— `dumpsys power` 显示
   `mWakefulness=Asleep`。用 `adb shell input keyevent KEYCODE_WAKEUP` 唤醒后画面立刻正常。
   以后看到「投屏黑屏」先查这一条。
2. **`PrintWindow` 抓不到 D3D 画面**。想绕过窗口遮挡去截图时，`PrintWindow(PW_RENDERFULLCONTENT)`
   抓到的是全黑 —— 因为 scrcpy 用 d3d11 渲染，打印窗口 API 拿不到那块表面。
   只能把窗口真正摆到前台再用 `CopyFromScreen`。
3. **PS 里 `$pid` / `$host` 是只读变量**，不能当局部变量用（会让整段脚本静默失效）。

## 七、为什么要两份报告

- `scrcpy-embed-result.md`（spike）证的是「**这个思路可行**」—— 它用 PowerShell 复刻，
  因为当时连 koffi 都还没装，用最少的未知数回答「SetParent 会不会黑屏」。
- 本报告证的是「**这个实现可行**」—— 跑的是真正会进安装包的那份 TS 模块。

spike 里那个「假成功」的教训（只看截图会骗人）在这里被继承下来了：
两条验收断言（`GetParent` 相等 + 宿主移动后子窗口跟着动）都写进了生产代码与冒烟脚本，
不是靠肉眼看截图。
