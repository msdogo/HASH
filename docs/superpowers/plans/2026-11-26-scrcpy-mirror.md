# scrcpy 投屏（嵌入窗口 + 侧边栏）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 HASH 里点「投屏」得到一个自绘窗口：左侧嵌入 scrcpy 实时画面，右侧竖排设备按键侧边栏。

**架构：** 主进程用 `spawnTracked` 起 scrcpy（无边框），用 `koffi` 调 Win32 `SetParent` 把它的窗口嵌入我们自己的 `BrowserWindow`；侧边栏是纯 HTML，占右侧固定宽度，与嵌入矩形不重叠。设备按键走独立 IPC 通道，入参是**三值枚举**，主进程内映射成 KEYCODE。

**技术栈：** Electron + React + TypeScript + koffi（Win32 FFI，MIT，预编译 `@koromix/koffi-win32-x64`）+ scrcpy 5.0.1（Apache-2.0，随包分发）

**规格：** `docs/superpowers/specs/2026-11-18-adb-file-manager-design.md` · **可行性证据：** `docs/superpowers/spike/scrcpy-embed-result.md`

## 全局约束

- 项目根目录：adb-file-manager/，所有路径相对该目录。
- 所有 adb 调用必须带 `-s serial`；scrcpy 同理（`-s <serial>` 是红线）。
- 绝不把用户输入拼接进 shell 字符串：动态路径一律经 `shellQuote()` 转义。
- 渲染层禁止 `require` / `import` node 模块；一切能力经 `window.api` 暴露。
- IPC 入参一律 zod 校验，失败返回统一错误码而非抛异常。
- 所有子进程必须经 `electron/adb/children.ts` 的 `spawnTracked()` 起，否则退出时留孤儿。
- 界面文案中文；跨页面复用的文案集中到 `src/shared/i18n.ts`。
- 提交粒度：每个任务结束提交一次，提交信息用中文 feat/fix 前缀。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `src/shared/mirror.ts` | 投屏类型、参数拼装、标题生成、失败分类（纯函数） |
| `src/shared/device-key.ts` | 设备按键枚举与 KEYCODE 映射表（纯函数） |
| `src/shared/mirror-view.ts` | 侧边栏按钮状态、投屏按钮状态（纯函数） |
| `electron/mirror/binary.ts` | scrcpy 定位与版本自检 |
| `electron/mirror/runner.ts` | 构造真实 scrcpy 子进程（spawnTracked + env.ADB） |
| `electron/mirror/service.ts` | 会话表、启动/停止、设备掉线联动 |
| `electron/mirror/embed.ts` | Win32 嵌入：EnumWindows / SetParent / MoveWindow / DPI 换算 |
| `electron/device/keys.ts` | 设备按键：三值枚举 → adb keyevent |
| `src/components/MirrorWindow.tsx` | 投屏窗口外壳（自绘顶栏） |
| `src/components/MirrorSidebar.tsx` | 右侧竖排按键条 |
| `src/store/mirrorStore.ts` | 渲染层投屏会话状态 |
| `scripts/fetch-scrcpy.mjs` | 下载并内置 scrcpy（含 LICENSE） |
| `scripts/assert-scrcpy.mjs` | 构建闸门：内置 scrcpy 必须能跑 |

---

### 任务 0：嵌入可行性 spike（已完成，无需重做）

结论见 `docs/superpowers/spike/scrcpy-embed-result.md`：**d3d11 渲染下 SetParent 后画面正常，不黑屏**。
附带结论：`ADB` 环境变量必须是 Windows 原生路径。

---

### 任务 1：共享层——投屏纯函数

**文件：**
- 创建：`src/shared/mirror.ts`
- 测试：`tests/mirror.test.ts`

- [ ] **步骤 1：编写失败的测试**

~~~ts
import { describe, it, expect } from 'vitest'
import { buildScrcpyArgs, mirrorTitleOf, classifyScrcpyFailure, SCRCPY_WINDOW_PREFIX } from '../src/shared/mirror'

describe('buildScrcpyArgs', () => {
  it('必须带 -s serial', () => {
    const args = buildScrcpyArgs({ serial: 'ABC123', token: 't1', maxSize: 1024 })
    expect(args.slice(0, 2)).toEqual(['-s', 'ABC123'])
  })

  it('无边框 + 唯一标题', () => {
    const args = buildScrcpyArgs({ serial: 'ABC123', token: 't1', maxSize: 1024 })
    expect(args).toContain('--window-borderless')
    expect(args).toContain('--window-title=' + SCRCPY_WINDOW_PREFIX + 't1')
  })

  it('不带 --render-driver（spike 证明默认 d3d11 即可）', () => {
    const args = buildScrcpyArgs({ serial: 'ABC123', token: 't1', maxSize: 1024 })
    expect(args.some((a) => a.startsWith('--render-driver'))).toBe(false)
  })

  it('无线设备序列号原样传递', () => {
    const args = buildScrcpyArgs({ serial: '192.168.1.7:5555', token: 't2', maxSize: 720 })
    expect(args.slice(0, 2)).toEqual(['-s', '192.168.1.7:5555'])
    expect(args).toContain('--max-size=720')
  })
})

describe('mirrorTitleOf', () => {
  it('有型号用型号 + serial 后 4 位', () => {
    expect(mirrorTitleOf({ serial: '9N9CN2G0012A3P', model: 'DJI RC Plus 2' })).toBe('DJI RC Plus 2 (2A3P)')
  })
  it('无型号回退 serial 后 4 位', () => {
    expect(mirrorTitleOf({ serial: '9N9CN2G0012A3P' })).toBe('设备 (2A3P)')
  })
})

describe('classifyScrcpyFailure', () => {
  it('认不出设备 → E_DEVICE_OFFLINE', () => {
    expect(classifyScrcpyFailure('ERROR: Could not find any ADB device')).toBe('E_DEVICE_OFFLINE')
  })
  it('找不到 adb → E_SCRCPY_NO_ADB', () => {
    expect(classifyScrcpyFailure('ERROR: Could not start adb server')).toBe('E_SCRCPY_NO_ADB')
  })
  it('其余 → E_MIRROR_START_FAILED', () => {
    expect(classifyScrcpyFailure('something odd')).toBe('E_MIRROR_START_FAILED')
  })
})
~~~

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run tests/mirror.test.ts`
预期：FAIL，报错 "Cannot find module '../src/shared/mirror'"

- [ ] **步骤 3：编写最少实现代码**

~~~ts
/**
 * 投屏的共享类型与纯函数。
 *
 * 红线：本文件同时被渲染层与主进程编译，不得 import 任何 node 内置模块。
 */

/** scrcpy 窗口标题前缀。嵌入方靠它精确定位 HWND（标题里带唯一 token，避免多设备互认）。 */
export const SCRCPY_WINDOW_PREFIX = 'adbfm-scrcpy-'

/** 默认最大分辨率（设备侧缩放到这个长边，再送到 PC）。 */
export const DEFAULT_MAX_SIZE = 1024

export interface ScrcpyArgsInput {
  serial: string
  token: string
  maxSize: number
}

/**
 * 拼 scrcpy 命令行参数。
 *
 * 刻意**不加** `--render-driver`：spike 实测默认 d3d11 在 SetParent 下画面正常，
 * 多一个开关就多一个「换台机器就黑屏」的变量。
 * `--no-audio`：本功能不涉及声音，少一个线程模型变量。
 */
export function buildScrcpyArgs(input: ScrcpyArgsInput): string[] {
  return [
    '-s', input.serial,
    '--window-borderless',
    '--window-title=' + SCRCPY_WINDOW_PREFIX + input.token,
    '--no-audio',
    '--max-size=' + String(input.maxSize),
  ]
}

/** 投屏窗口/会话的显示名：型号 + serial 后 4 位。 */
export function mirrorTitleOf(device: { serial: string; model?: string }): string {
  const tail = device.serial.slice(-4)
  const name = device.model !== undefined && device.model !== '' ? device.model : '设备'
  return name + ' (' + tail + ')'
}

/** 把 scrcpy 的 stderr 收敛成错误码。 */
export function classifyScrcpyFailure(stderr: string): string {
  if (/Could not find any ADB device|Could not find ADB device/i.test(stderr)) return 'E_DEVICE_OFFLINE'
  if (/Could not start adb server|Command not found: \[.*adb/i.test(stderr)) return 'E_SCRCPY_NO_ADB'
  return 'E_MIRROR_START_FAILED'
}
~~~

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run tests/mirror.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

~~~bash
git add src/shared/mirror.ts tests/mirror.test.ts
git commit -m "feat: 投屏共享层类型与参数拼装"
~~~

---

### 任务 2：共享层——设备按键枚举

**文件：**
- 创建：`src/shared/device-key.ts`
- 测试：`tests/device-key.test.ts`

- [ ] **步骤 1：编写失败的测试**

~~~ts
import { describe, it, expect } from 'vitest'
import { DEVICE_KEYS, keyCodeOf, isDeviceKey } from '../src/shared/device-key'

describe('device-key', () => {
  it('六个按键都有 KEYCODE', () => {
    expect(DEVICE_KEYS).toHaveLength(6)
    for (const key of DEVICE_KEYS) expect(keyCodeOf(key)).toBeGreaterThan(0)
  })

  it('返回=4 / home=3 / recents=187', () => {
    expect(keyCodeOf('back')).toBe(4)
    expect(keyCodeOf('home')).toBe(3)
    expect(keyCodeOf('recents')).toBe(187)
  })

  it('音量与电源', () => {
    expect(keyCodeOf('volumeUp')).toBe(24)
    expect(keyCodeOf('volumeDown')).toBe(25)
    expect(keyCodeOf('power')).toBe(26)
  })

  it('isDeviceKey 只认枚举内的值', () => {
    expect(isDeviceKey('back')).toBe(true)
    expect(isDeviceKey('Back')).toBe(false)
    expect(isDeviceKey('4')).toBe(false)
    expect(isDeviceKey('input keyevent 4')).toBe(false)
  })
})
~~~

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run tests/device-key.test.ts`
预期：FAIL

- [ ] **步骤 3：编写最少实现代码**

~~~ts
/**
 * 设备按键的**唯一事实源**（渲染层与主进程共用）。
 *
 * 安全红线：渲染层只能传这六个字面量之一，**永远不能传数字或命令片段**。
 * 主进程用本表的映射拼 adb 命令 —— 这样「按键」就不是一个 shell 注入面。
 */

export const DEVICE_KEYS = ['back', 'home', 'recents', 'volumeUp', 'volumeDown', 'power'] as const

export type DeviceKey = (typeof DEVICE_KEYS)[number]

/** Android KEYCODE 映射（AOSP 常量名）。 */
const KEY_CODES: Record<DeviceKey, number> = {
  back: 4,
  home: 3,
  recents: 187,
  volumeUp: 24,
  volumeDown: 25,
  power: 26,
}

/** 枚举内 → 数字码；枚举外一律返回 0（调用方据此拒绝）。 */
export function keyCodeOf(key: DeviceKey): number {
  return KEY_CODES[key] ?? 0
}

/** 这个字符串是不是合法按键名（zod 之外的运行时兜底）。 */
export function isDeviceKey(value: unknown): value is DeviceKey {
  return typeof value === 'string' && (DEVICE_KEYS as readonly string[]).includes(value)
}
~~~

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run tests/device-key.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

~~~bash
git add src/shared/device-key.ts tests/device-key.test.ts
git commit -m "feat: 设备按键枚举与 KEYCODE 映射"
~~~

---

### 任务 3：设备按键服务 + IPC

**文件：**
- 创建：`electron/device/keys.ts`、`tests/device-keys.test.ts`
- 修改：`src/shared/errors.ts`、`src/shared/i18n.ts`、`electron/ipc/channels.ts`、`src/shared/api-contract.ts`、`electron/ipc/handlers.ts`、`electron/preload.ts`、`src/shared/api.d.ts`

- [ ] **步骤 1：编写失败的测试**

~~~ts
import { describe, it, expect, vi } from 'vitest'
import { createKeyService } from '../electron/device/keys'

function fakeClient(result: { code: number; stdout: string; stderr: string }) {
  const calls: string[][] = []
  return {
    calls,
    run: async (args: string[]) => { calls.push(args); return result },
  }
}

const online = { get: () => ({ serial: 'S1', status: 'device' as const, transport: 'usb' as const, lastSeenAt: 0 }) }

describe('key service', () => {
  it('back → input keyevent 4', async () => {
    const client = fakeClient({ code: 0, stdout: '', stderr: '' })
    const svc = createKeyService({ devices: online, clientFor: () => client, adbPath: () => 'adb.exe' })
    await svc.press('S1', 'back')
    expect(client.calls[0]).toEqual(['shell', 'input', 'keyevent', '4'])
  })

  it('未知按键被拒绝，且不发命令', async () => {
    const client = fakeClient({ code: 0, stdout: '', stderr: '' })
    const svc = createKeyService({ devices: online, clientFor: () => client, adbPath: () => 'adb.exe' })
    await expect(svc.press('S1', 'nope' as never)).rejects.toThrow()
    expect(client.calls).toHaveLength(0)
  })

  it('设备不在线 → E_DEVICE_OFFLINE', async () => {
    const svc = createKeyService({ devices: { get: () => undefined }, clientFor: () => fakeClient({ code: 0, stdout: '', stderr: '' }), adbPath: () => 'adb.exe' })
    await expect(svc.press('S1', 'home')).rejects.toThrow('E_NO_SERIAL')
  })

  it('adb 未定位 → E_ADB_NOT_FOUND', async () => {
    const svc = createKeyService({ devices: online, clientFor: () => fakeClient({ code: 0, stdout: '', stderr: '' }), adbPath: () => '' })
    await expect(svc.press('S1', 'home')).rejects.toThrow('E_ADB_NOT_FOUND')
  })
})
~~~

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run tests/device-keys.test.ts`
预期：FAIL

- [ ] **步骤 3：编写最少实现代码**

~~~ts
import type { DeviceSession } from '../../src/shared/types'
import { E_ADB_NOT_FOUND, E_BAD_ARGS, E_DEVICE_OFFLINE, E_NO_SERIAL } from '../../src/shared/errors'
import { isDeviceKey, keyCodeOf, type DeviceKey } from '../../src/shared/device-key'

/** 执行一条 adb 命令的最小面（AdbClient 满足它）。 */
export interface KeyRunner {
  run(args: string[], opts: { adbPath: string; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string }>
}

export interface KeyServiceDeps {
  devices: { get(serial: string): DeviceSession | undefined }
  clientFor: (serial: string) => KeyRunner
  adbPath: () => string
}

export interface KeyService {
  press(serial: string, key: DeviceKey): Promise<void>
}

/** 单条按键命令的超时。input keyevent 是毫秒级命令，5s 已极宽松。 */
const KEY_TIMEOUT_MS = 5_000

/**
 * 设备按键服务。
 *
 * 关键设计：入参是**枚举**而不是字符串或数字，数字码由 keyCodeOf 在本文件内映射。
 * 渲染层因此没有任何途径把「任意命令」送进 adb shell。
 */
export function createKeyService(deps: KeyServiceDeps): KeyService {
  return {
    async press(serial: string, key: DeviceKey): Promise<void> {
      if (deps.adbPath() === '') throw new Error(E_ADB_NOT_FOUND)
      const session = deps.devices.get(serial)
      if (session === undefined) throw new Error(E_NO_SERIAL)
      if (session.status !== 'device') throw new Error(E_DEVICE_OFFLINE)
      if (!isDeviceKey(key)) throw new Error(E_BAD_ARGS)
      const code = keyCodeOf(key)
      if (code === 0) throw new Error(E_BAD_ARGS)
      const result = await deps.clientFor(serial).run(
        ['shell', 'input', 'keyevent', String(code)],
        { adbPath: deps.adbPath(), timeoutMs: KEY_TIMEOUT_MS },
      )
      if (result.code !== 0) throw new Error(E_DEVICE_OFFLINE)
    },
  }
}
~~~

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run tests/device-keys.test.ts`
预期：PASS

- [ ] **步骤 5：四件套接线 + 错误码**

在 `errors.ts` 登记 `E_MIRROR_START_FAILED` / `E_SCRCPY_NOT_FOUND` / `E_SCRCPY_NO_ADB` / `E_MIRROR_ACTIVE`，
在 `i18n.ts` 补对应中文文案（`errors.test.ts` 会校验两表齐平）。
在 `channels.ts` 加 `DEVICE_KEYEVENT = 'device:keyevent'` 并登记进 `INVOKE_CHANNELS`。
在 `api-contract.ts` 加：

~~~ts
export const DEVICE_KEYEVENT_INPUT = z.object({
  serial: z.string().min(1),
  key: z.enum(DEVICE_KEYS),
})
export type DeviceKeyeventInput = z.infer<typeof DEVICE_KEYEVENT_INPUT>
~~~

在 `handlers.ts` 注册（沿用 `appsPreflight` 同款前置）；在 `preload.ts` 的 `buildApi` 里加
`device: { pressKey }`，并在 `api.d.ts` 的 `DshApi` 上声明（**返回类型标注 + 字面量 satisfies 双保险**）。

- [ ] **步骤 6：运行门禁**

运行：`npx tsc -b --force`
预期：exit 0
运行：`npx vitest run tests/api-contract-binding.test.ts tests/ipc-channels.test.ts`
预期：PASS

- [ ] **步骤 7：Commit**

~~~bash
git add -A
git commit -m "feat: 设备按键服务与 IPC 通道"
~~~

---

### 任务 4：scrcpy 定位与自检

**文件：**
- 创建：`electron/mirror/binary.ts`、`tests/mirror-binary.test.ts`

- [ ] **步骤 1：编写失败的测试**

~~~ts
import { describe, it, expect } from 'vitest'
import { locateScrcpy } from '../electron/mirror/binary'

describe('locateScrcpy', () => {
  it('内置优先于 PATH', async () => {
    const r = await locateScrcpy({
      resourcesPath: 'R',
      pathEnv: 'C:\\bin',
      exists: (p) => p === 'R\\scrcpy\\scrcpy.exe',
      probe: async () => ({ ok: true, version: '5.0.1' }),
    })
    expect(r).toEqual({ ok: true, path: 'R\\scrcpy\\scrcpy.exe', version: '5.0.1', source: 'bundled' })
  })

  it('内置缺失时回落 PATH', async () => {
    const r = await locateScrcpy({
      resourcesPath: 'R',
      pathEnv: 'C:\\bin',
      exists: (p) => p === 'C:\\bin\\scrcpy.exe',
      probe: async () => ({ ok: true, version: '5.0.1' }),
    })
    expect(r.ok && r.source).toBe('path')
  })

  it('都没有 → E_SCRCPY_NOT_FOUND', async () => {
    const r = await locateScrcpy({ resourcesPath: 'R', pathEnv: '', exists: () => false, probe: async () => ({ ok: false }) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_SCRCPY_NOT_FOUND')
  })

  it('存在但跑不起来 → E_SCRCPY_NOT_EXECUTABLE', async () => {
    const r = await locateScrcpy({
      resourcesPath: 'R', pathEnv: '',
      exists: (p) => p === 'R\\scrcpy\\scrcpy.exe',
      probe: async () => ({ ok: false }),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_SCRCPY_NOT_EXECUTABLE')
  })
})
~~~

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run tests/mirror-binary.test.ts`
预期：FAIL

- [ ] **步骤 3：编写最少实现代码**

实现要点（完整代码写在实现时）：

1. 候选顺序：`<resourcesPath>/scrcpy/scrcpy.exe`（source=`bundled`）→ `<PATH 每项>/scrcpy.exe`（source=`path`）。
   PATH 解析**复用** `electron/adb/binary.ts` 的 `resolveOnPath`（它已处理 PATHEXT 顺序、shim 跳过、空段过滤）。
2. `probe(exePath)`：`spawnTracked(exePath, ['--version'])`，4s 超时，解析 `scrcpy (\d+\.\d+(?:\.\d+)?)`。
3. 返回可判别联合 `{ ok: true, path, version, source } | { ok: false, code }`。
4. 依赖全部注入（`exists` / `probe` / `pathEnv` / `pathext`），单测不需要真二进制。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run tests/mirror-binary.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

~~~bash
git add electron/mirror/binary.ts tests/mirror-binary.test.ts
git commit -m "feat: scrcpy 定位与版本自检"
~~~

---

### 任务 5：投屏服务（会话表 + 生命周期）

**文件：**
- 创建：`electron/mirror/runner.ts`、`electron/mirror/service.ts`、`tests/mirror-service.test.ts`

- [ ] **步骤 1：编写失败的测试**

~~~ts
import { describe, it, expect } from 'vitest'
import { createMirrorService } from '../electron/mirror/service'

function fakeSpawn() {
  const calls: { cmd: string; args: string[]; env: Record<string, string> }[] = []
  const exits: (() => void)[] = []
  return {
    calls,
    kill: async () => undefined,
    onExit: (cb: () => void) => { exits.push(cb) },
    fireExit: () => { for (const cb of exits) cb() },
    spawn: (cmd: string, args: string[], env: Record<string, string>) => {
      calls.push({ cmd, args, env })
      return { pid: 1234, onExit: (cb: () => void) => exits.push(cb), kill: async () => undefined }
    },
  }
}

const online = { get: (s: string) => ({ serial: s, status: 'device' as const, transport: 'usb' as const, lastSeenAt: 0 }) }

describe('mirror service', () => {
  it('启动时 env.ADB 必须是 adb 绝对路径', async () => {
    const sp = fakeSpawn()
    const svc = createMirrorService({ devices: online, adbPath: () => 'C:\\pt\\adb.exe', locate: async () => ({ ok: true, path: 'C:\\scrcpy.exe', version: '5.0.1', source: 'bundled' }), spawn: sp.spawn, emit: () => undefined })
    await svc.start('S1')
    expect(sp.calls[0].env.ADB).toBe('C:\\pt\\adb.exe')
  })

  it('同一台设备重复 start 不再 spawn', async () => {
    const sp = fakeSpawn()
    const svc = createMirrorService({ devices: online, adbPath: () => 'adb.exe', locate: async () => ({ ok: true, path: 's.exe', version: '5.0.1', source: 'bundled' }), spawn: sp.spawn, emit: () => undefined })
    await svc.start('S1'); await svc.start('S1')
    expect(sp.calls).toHaveLength(1)
  })

  it('stop 后会话消失', async () => {
    const sp = fakeSpawn()
    const svc = createMirrorService({ devices: online, adbPath: () => 'adb.exe', locate: async () => ({ ok: true, path: 's.exe', version: '5.0.1', source: 'bundled' }), spawn: sp.spawn, emit: () => undefined })
    await svc.start('S1'); await svc.stop('S1')
    expect(svc.list()).toHaveLength(0)
  })

  it('设备掉线自动结束会话并推送', async () => {
    const sp = fakeSpawn()
    const events: unknown[] = []
    const svc = createMirrorService({ devices: online, adbPath: () => 'adb.exe', locate: async () => ({ ok: true, path: 's.exe', version: '5.0.1', source: 'bundled' }), spawn: sp.spawn, emit: (e) => events.push(e) })
    await svc.start('S1')
    await svc.onDeviceChanged({ changed: [], removed: ['S1'], adb: { state: 'checking' } })
    expect(svc.list()).toHaveLength(0)
    expect(events.length).toBeGreaterThan(0)
  })

  it('子进程自己退出 → 会话清理 + 事件', async () => {
    const sp = fakeSpawn()
    const events: unknown[] = []
    const svc = createMirrorService({ devices: online, adbPath: () => 'adb.exe', locate: async () => ({ ok: true, path: 's.exe', version: '5.0.1', source: 'bundled' }), spawn: sp.spawn, emit: (e) => events.push(e) })
    await svc.start('S1')
    sp.fireExit()
    expect(svc.list()).toHaveLength(0)
    expect(events.some((e) => (e as { kind: string }).kind === 'exited')).toBe(true)
  })
})
~~~

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run tests/mirror-service.test.ts`
预期：FAIL

- [ ] **步骤 3：编写最少实现代码**

实现要点：

1. `runner.ts`：`startScrcpy({ scrcpyPath, adbPath, args })` → `spawnTracked(scrcpyPath, args, { env: {...process.env, ADB: path.win32.normalize(adbPath)}, windowsHide: true, stdio: ['ignore','ignore','pipe'] })`。
   **stderr 必须消费**（`child.stderr?.on('data')`），否则管道填满会卡死 scrcpy —— 与 `capture/recorder.ts` 同一条教训。
   返回 `{ pid, onExit(cb), kill(): Promise<void> }`；`kill` 走 `killTree`（等 taskkill 真退出再 resolve）。
2. `service.ts`：`Map<serial, MirrorSession>`；`start` 顺序为
   ① adb 可用 ② scrcpy 可定位 ③ 会话已存在则直接返回（幂等） ④ spawn ⑤ 登记。
   前置失败时**不 spawn**。
3. `onDeviceChanged(batch)`：`removed` 里的 serial 与 `changed` 里 status !== 'device' 的 serial 一律 stop。
4. `stopAll()` 供 `before-quit` 调用（dispose）。
5. `emit` 三种事件：`started` / `exited` / `failed`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run tests/mirror-service.test.ts`
预期：PASS

- [ ] **步骤 5：变异验证（必做）**

把 `buildScrcpyArgs` 里的 `'-s', serial` 删掉 → 定向用例必须变红。记录实际数字。

- [ ] **步骤 6：Commit**

~~~bash
git add -A
git commit -m "feat: 投屏服务与会话生命周期"
~~~

---

### 任务 6：投屏 IPC 四件套

**文件：**
- 修改：`electron/ipc/channels.ts`、`src/shared/api-contract.ts`、`electron/ipc/handlers.ts`、`electron/preload.ts`、`src/shared/api.d.ts`
- 测试：`tests/mirror-ipc.test.ts`

- [ ] **步骤 1：编写失败的测试**

~~~ts
import { describe, it, expect } from 'vitest'
import { MIRROR_START_INPUT } from '../src/shared/api-contract'

describe('mirror ipc contract', () => {
  it('start 只接受非空 serial', () => {
    expect(MIRROR_START_INPUT.safeParse({ serial: 'S1' }).success).toBe(true)
    expect(MIRROR_START_INPUT.safeParse({ serial: '' }).success).toBe(false)
    expect(MIRROR_START_INPUT.safeParse({}).success).toBe(false)
  })
})
~~~

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run tests/mirror-ipc.test.ts`
预期：FAIL

- [ ] **步骤 3：实现四件套**

通道：`MIRROR_START` / `MIRROR_STOP` / `MIRROR_LIST`（invoke）+ `MIRROR_CHANGED`（event）。
zod：`MIRROR_START_INPUT = z.object({ serial: z.string().min(1) })`、`MIRROR_STOP_INPUT` 同形。
handler 前置沿用 `capturePreflight`（zod + 会话存在 + adb 已定位）。
`DshApi.mirror = { start, stop, list, onChanged }`。

- [ ] **步骤 4：运行门禁**

运行：`npx tsc -b --force` → exit 0
运行：`npx vitest run tests/mirror-ipc.test.ts tests/api-contract-binding.test.ts tests/ipc-channels.test.ts` → PASS

- [ ] **步骤 5：Commit**

~~~bash
git add -A
git commit -m "feat: 投屏 IPC 通道与契约"
~~~

---

### 任务 7：渲染层入口（设备栏右键 + 工具条按钮）

**文件：**
- 创建：`src/shared/mirror-view.ts`、`src/store/mirrorStore.ts`、`tests/mirror-view.test.ts`
- 修改：`src/components/DeviceRail.tsx`、`src/components/FileToolbar.tsx`、`src/pages/FilesPage.tsx`

- [ ] **步骤 1：编写失败的测试**

~~~ts
import { describe, it, expect } from 'vitest'
import { mirrorButtonState } from '../src/shared/mirror-view'

describe('mirrorButtonState', () => {
  it('设备不在线 → disabled', () => {
    expect(mirrorButtonState({ deviceStatus: 'offline', session: undefined, adbReady: true })).toBe('disabled')
  })
  it('adb 未就绪 → disabled', () => {
    expect(mirrorButtonState({ deviceStatus: 'device', session: undefined, adbReady: false })).toBe('disabled')
  })
  it('有会话 → running', () => {
    expect(mirrorButtonState({ deviceStatus: 'device', session: { serial: 'S1' }, adbReady: true })).toBe('running')
  })
  it('正常可投 → idle', () => {
    expect(mirrorButtonState({ deviceStatus: 'device', session: undefined, adbReady: true })).toBe('idle')
  })
})
~~~

- [ ] **步骤 2：运行测试验证失败 → 实现 → 验证通过**

实现 `mirrorButtonState` 四态纯函数，再在工具条加「投屏」按钮、设备栏行加右键菜单项。
接线仍按本项目惯例登记进 progress.md 的「已知无门禁清单」（SSR 拿不到 onClick）。

- [ ] **步骤 3：运行门禁**

运行：`npx tsc -b --force` → exit 0
运行：`npx vitest run tests/mirror-view.test.ts` → PASS
运行：`npm run build` → exit 0

- [ ] **步骤 4：Commit**

~~~bash
git add -A
git commit -m "feat: 投屏入口与按钮状态"
~~~

---

### 任务 8：打包内置 scrcpy

**文件：**
- 创建：`scripts/fetch-scrcpy.mjs`、`scripts/assert-scrcpy.mjs`、`scripts/before-pack-scrcpy.cjs`
- 修改：`electron-builder.json`、`package.json`、`.gitignore`

- [ ] **步骤 1：编写 fetch 脚本**

要点（对齐既有 `fetch-platform-tools.mjs` 的风格）：

- 版本常量 `SCRCPY_VERSION = '5.0.1'`，URL
  `https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-win64-v5.0.1.zip`
  （**已验证 HTTP 200**）。
- 幂等：`resources/scrcpy/scrcpy.exe` 存在且 `--version` 能跑 → 直接退出。
- 解压后**必须**核验三样东西都存在：`scrcpy.exe`、`scrcpy-server`、`LICENSE.txt`。
  缺 `scrcpy-server` 是最隐蔽的失败形态（exe 能跑但投屏必失败）。
- 资产名不匹配 → 打印手动放置指引并 `exit 1`，**绝不静默通过**（这是任务 11 踩过的同款坑）。
- 支持离线：`ADB_SCREENSYNC_ZIP=<本地 zip>`。

- [ ] **步骤 2：编写 assert 脚本**

断言 `resources/scrcpy/scrcpy.exe` **能跑**（`--version` 退出 0 且输出含版本行），
不是「文件存在」。失败信息要写清「为什么构建必须停」。

- [ ] **步骤 3：接进构建链**

- `package.json`：`fetch-scrcpy` / `assert-scrcpy` 两个脚本，并插进 `dist` 链（fetch → assert-platform-tools → **fetch-scrcpy → assert-scrcpy** → assert-version → build → electron-builder）。
- `electron-builder.json`：`extraResources` 加 `{ "from": "resources/scrcpy", "to": "scrcpy" }`；
  `asarUnpack` 加 `"**/node_modules/koffi/**"`（koffi 的 .node 不能留在 asar 里）。
- `.gitignore`：加 `resources/scrcpy/`。
- `before-pack-scrcpy.cjs`：在 `beforePack` 里再断言一次（覆盖直接跑 `npx electron-builder` 的旁路）。

- [ ] **步骤 4：验证**

运行：`npm run fetch-scrcpy` → 产物就位
运行：`npm run assert-scrcpy` → exit 0
运行：`npm run dist` → exit 0，安装包内 `resources/scrcpy/scrcpy.exe` 存在

- [ ] **步骤 5：Commit**

~~~bash
git add -A
git commit -m "build: 打包内置 scrcpy 并加构建闸门"
~~~

---

### 任务 9：Win32 嵌入层

**文件：**
- 创建：`electron/mirror/embed.ts`、`tests/mirror-embed.test.ts`
- 修改：`package.json`（`koffi` 依赖）

- [ ] **步骤 1：安装 koffi**

运行：`npm i koffi`
预期：`node_modules/@koromix/koffi-win32-x64` 就位

- [ ] **步骤 2：编写失败的测试（纯逻辑部分）**

~~~ts
import { describe, it, expect } from 'vitest'
import { fitRect, toPhysical } from '../electron/mirror/embed'

describe('embed geometry', () => {
  it('100% 缩放时物理坐标等于 CSS 坐标', () => {
    expect(toPhysical({ x: 0, y: 40, width: 800, height: 600 }, 1)).toEqual({ x: 0, y: 40, width: 800, height: 600 })
  })
  it('150% 缩放换算', () => {
    expect(toPhysical({ x: 0, y: 40, width: 800, height: 600 }, 1.5)).toEqual({ x: 0, y: 60, width: 1200, height: 900 })
  })
  it('fitRect 保持宽高比并居中', () => {
    const r = fitRect({ width: 1000, height: 700 }, { width: 1024, height: 640 })
    expect(r.height).toBe(700)
    expect(Math.round(r.width)).toBe(Math.round(700 * (1024 / 640)))
    expect(r.x).toBe(Math.round((1000 - r.width) / 2))
  })
})
~~~

- [ ] **步骤 3：运行测试验证失败 → 实现 → 验证通过**

`embed.ts` 的 Win32 部分用 `koffi`：

~~~ts
import koffi from 'koffi'

const user32 = koffi.load('user32.dll')
const EnumWindows = user32.func('bool EnumWindows(void* cb, intptr_t lParam)')
const GetWindowTextW = user32.func('int GetWindowTextW(intptr_t hWnd, _Out_ uint16_t* str, int max)')
const SetParent = user32.func('intptr_t SetParent(intptr_t child, intptr_t parent)')
const MoveWindow = user32.func('bool MoveWindow(intptr_t hWnd, int x, int y, int w, int h, bool repaint)')
const GetParent = user32.func('intptr_t GetParent(intptr_t hWnd)')
const ShowWindow = user32.func('bool ShowWindow(intptr_t hWnd, int cmd)')
const GetWindowLongPtr = user32.func('intptr_t GetWindowLongPtrW(intptr_t hWnd, int index)')
const SetWindowLongPtr = user32.func('intptr_t SetWindowLongPtrW(intptr_t hWnd, int index, intptr_t value)')
~~~

对外三个函数：
- `findWindowByTitle(exact: string): Promise<number>` —— 轮询最多 10s（scrcpy 建窗实测 6~8s），找不到返回 0
- `embed(childHwnd, parentHwnd, rect)` —— **先改样式、再 SetParent、最后 MoveWindow**（见下方红线）
- `resize(childHwnd, rect)` —— 只 `MoveWindow`
纯几何部分（`toPhysical` / `fitRect`）单独导出，不依赖 koffi，**这是可单测的部分**。
koffi 调用本身在 CI 里跑不了（需要真窗口），如实登记进「已知无门禁清单」。

**红线（spike 实测踩过，见 docs/superpowers/spike/scrcpy-embed-result.md 第三节）：**

只调 `SetParent` 是**假嵌入** —— 对带 `WS_POPUP` 样式的窗口，SetParent 只把坐标改写成
屏幕绝对坐标，不建立父子关系，看起来「嵌进去了」纯属视觉巧合（`GetParent` 返回 0、
宿主移动时画面纹丝不动）。必须先改样式：

~~~ts
const GWL_STYLE = -16
const WS_CHILD = 0x40000000
const WS_POPUP = 0x80000000
const WS_CAPTION = 0x00c00000
const WS_THICKFRAME = 0x00040000

function makeChild(hwnd: number): void {
  const style = Number(GetWindowLongPtr(hwnd, GWL_STYLE))
  const next = (style | WS_CHILD) & ~WS_POPUP & ~WS_CAPTION & ~WS_THICKFRAME
  SetWindowLongPtr(hwnd, GWL_STYLE, next)
}
~~~

顺序必须是：`makeChild()` → `SetParent()` → `MoveWindow()`。
**验收断言**：嵌入后 `GetParent(child) === parentHwnd`；宿主移动后子窗口矩形跟着变。
这两条写进真机验证清单（任务 11）。

- [ ] **步骤 4：Commit**

~~~bash
git add -A
git commit -m "feat: Win32 窗口嵌入层"
~~~

---

### 任务 10：投屏窗口 + 侧边栏

**文件：**
- 创建：`src/components/MirrorWindow.tsx`、`src/components/MirrorSidebar.tsx`、`src/shared/mirror-view.ts`（扩展）、`tests/mirror-sidebar.test.tsx`
- 修改：`src/App.tsx`、`electron/main.ts`（开窗口）

- [ ] **步骤 1：编写失败的测试**

~~~tsx
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MirrorSidebar } from '../src/components/MirrorSidebar'

describe('MirrorSidebar', () => {
  it('渲染六个按键', () => {
    const html = renderToStaticMarkup(<MirrorSidebar onPress={() => undefined} disabled={false} />)
    for (const key of ['返回', '主页', '后台', '音量减', '音量加', '电源']) expect(html).toContain(key)
    expect(html).not.toContain('disabled=""')
  })
  it('disabled 时全部禁用', () => {
    const html = renderToStaticMarkup(<MirrorSidebar onPress={() => undefined} disabled={true} />)
    expect((html.match(/disabled=""/g) ?? []).length).toBe(6)
  })
})
~~~

- [ ] **步骤 2~4：实现 → 验证**

- `MirrorWindow.tsx`：自绘顶栏（标题 = `mirrorTitleOf`，右侧复用 `WindowControls`），
  主体 `flex`：左侧 `flex-1` 是嵌入区（**留空 div**，HWND 盖在上面），右侧 `MirrorSidebar` 固定 56px。
- `App.tsx` 加 `location.hash === '#/mirror'` 分流（与 `#/settings` 同一手法）。
- `main.ts` 加 `openMirrorWindow(serial)`：`new BrowserWindow({ frame: false, width: 1200, height: 800 })`，
  `loadURL(APP_ENTRY_URL + '#/mirror?serial=' + encodeURIComponent(serial))`。

- [ ] **步骤 5：Commit**

~~~bash
git add -A
git commit -m "feat: 投屏窗口与按键侧边栏"
~~~

---

### 任务 11：几何协同（resize / DPI / 崩溃态）

**文件：**
- 修改：`electron/main.ts`、`electron/mirror/service.ts`、`electron/mirror/embed.ts`

- [ ] **步骤 1：实现**

- 投屏窗口 `resize` / `maximize` / `restore` → 重算 `fitRect` → `MoveWindow`。
- `scaleFactor` 用 `screen.getDisplayMatching(win.getBounds()).scaleFactor` 现取（用户可能拖到另一块屏）。
- 窗口 `closed` → `service.stop(serial)`。
- scrcpy 退出 → 渲染层收 `MIRROR_CHANGED` → 嵌入区显示错误态（不是黑块）。

- [ ] **步骤 2：真机验证清单**

- [ ] 点投屏 → 窗口出现，画面在左、按键在右，不重叠
- [ ] 拖动窗口到另一块屏（不同 DPI）→ 画面不错位、点击落点准确
- [ ] 最大化 / 还原 → 画面跟随
- [ ] 点侧边栏「返回」→ 设备真的返回
- [ ] 拔线 → 窗口显示错误态、不崩溃
- [ ] 关闭投屏窗口 → scrcpy 进程消失
- [ ] 关闭整个应用 → 系统进程表**无 scrcpy.exe 残留**
- [ ] 两台设备同时投屏 → 两个窗口互不干扰

- [ ] **步骤 3：Commit**

~~~bash
git add -A
git commit -m "feat: 投屏窗口几何协同与崩溃态"
~~~

---

### 任务 12：文档与收尾

- [ ] README 功能清单加「投屏（内嵌窗口 + 设备按键侧边栏）」
- [ ] README「环境」注明安装包 ≈200 MB（含内置 scrcpy）
- [ ] progress.md 新增本轮小节，登记「已知无门禁清单」新增条目：
  - koffi 的 Win32 调用（需要真窗口，vitest 跑不了）
  - 侧边栏 onClick 接线（SSR 拿不到事件，与既有条目同类）
  - 窗口 resize → MoveWindow 的接线
- [ ] `npx tsc -b --force` exit 0 / `npx vitest run` 全绿 / `npm run build` exit 0
- [ ] Commit

## 验收清单

- [ ] 插入设备 → 点投屏 → 3 秒内出现内嵌画面
- [ ] 侧边栏六个按键全部生效
- [ ] 拖到 125% / 150% DPI 屏幕后点击落点准确
- [ ] 拔线/关窗/退出应用三种情况都不留 scrcpy 残留进程
- [ ] 双设备同时投屏互不干扰
- [ ] `npm run dist` 产出的安装包在无 Android SDK 的机器上能投屏
