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

## 三、`npm run dev` 在这台机器上起不来的原因（与投屏无关，如实记录）

用 `ADB_FM_DEBUG_PORT=xxxx npm run dev` 启动后进程立刻退出、无窗口。
根因是**单实例锁**：机器上已经装着并运行着 `C:\Program Files\HASH\HASH.exe`
（PID 41376，2026-11-25 启动），它持有 `requestSingleInstanceLock` 的命名互斥体，
开发实例拿到 `false` 就按设计 `app.quit()` 了。

验证方式是绕过 dev server、直接用 electron 跑构建产物 + 独立的 `--user-data-dir`，
嵌入冒烟就是这么跑起来的（见上）。这不影响结论，但下次做界面手工验证前，
**必须先把已安装的 HASH 退掉**（托盘菜单「退出」），否则开发实例永远静默退出。

## 四、为什么要两份报告

- `scrcpy-embed-result.md`（spike）证的是「**这个思路可行**」—— 它用 PowerShell 复刻，
  因为当时连 koffi 都还没装，用最少的未知数回答「SetParent 会不会黑屏」。
- 本报告证的是「**这个实现可行**」—— 跑的是真正会进安装包的那份 TS 模块。

spike 里那个「假成功」的教训（只看截图会骗人）在这里被继承下来了：
两条验收断言（`GetParent` 相等 + 宿主移动后子窗口跟着动）都写进了生产代码与冒烟脚本，
不是靠肉眼看截图。
