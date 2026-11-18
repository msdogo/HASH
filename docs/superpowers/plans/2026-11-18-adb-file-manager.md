# ADB 手机文件管家 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法来跟踪进度。

**目标：** 交付一款 Windows 桌面端安卓文件管理工具，支持多设备并行浏览与传输。

**架构：** Electron 三进程结构（main / preload / renderer）。主进程独占 adb 子进程与文件系统访问，渲染层零 Node 权限；设备以 serial 为键建立会话，所有 adb 命令强制带 -s serial；传输按设备分组调度。

**技术栈：** Electron + React + TypeScript + Vite + Tailwind CSS 3.4 + zustand + @tanstack/react-virtual + zod + vitest + electron-builder。

**规格：** docs/superpowers/specs/2026-11-18-adb-file-manager-design.md

## 全局约束

- 项目根目录：adb-file-manager/，所有路径相对该目录。
- 所有 adb 调用必须带 -s serial；AdbClient 构造函数校验 serial，缺失即抛 E_NO_SERIAL。
- 绝不把用户输入拼接进 shell 字符串：动态路径一律经 shellQuote() 转义。
- 渲染层禁止 require / import node 模块；一切能力经 window.api 暴露。
- IPC 入参一律 zod 校验，失败返回统一错误码而非抛异常。
- 单设备传输并发 1，全局并发默认 3（设置可调 1–6）。
- 界面文案中文；跨页面复用的文案集中到 src/shared/i18n.ts（任务 1 建立），不散落硬编码。
- 所有子进程在窗口关闭时回收（app.on('before-quit') 中 kill 全部）。
- 提交粒度：每个任务结束提交一次，提交信息用中文 feat/fix 前缀。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| electron/main.ts | 应用入口、窗口创建、生命周期与子进程回收 |
| electron/preload.ts | contextBridge 暴露 window.api |
| electron/adb/binary.ts | adb 路径定位与版本自检 |
| electron/adb/shellsafe.ts | shell 单引号转义 |
| electron/adb/client.ts | AdbClient：带 serial 的命令执行、超时、取消 |
| electron/adb/track.ts | track-devices 长驻流与帧解析 |
| electron/adb/list-parser.ts | ls -lA 输出解析为 FileEntry |
| electron/devices/manager.ts | 设备状态机与会话集合 |
| electron/fs/remote.ts | 远程目录列表与文件操作 |
| electron/fs/local.ts | 本地目录列表与操作 |
| electron/transfer/queue.ts | 按设备分组的传输队列 |
| electron/ipc/channels.ts | 通道常量 |
| electron/ipc/handlers.ts | 通道注册与校验 |
| electron/services/settings.ts | 配置持久化 |
| src/shared/types.ts | 共享类型 |
| src/shared/errors.ts | 错误码与文案映射 |
| src/store/*.ts | zustand 分片 |
| src/components/*.tsx | 设备栏 / 文件表 / 传输底栏 |
| src/pages/*.tsx | 文件页 / 总览页 / 设置页 |
| tests/*.test.ts | 单元测试 |

---

### 任务 1：工程脚手架与空白窗口

**文件：**
- 创建：package.json、tsconfig.json、vite.config.ts、index.html、electron/main.ts、electron/preload.ts、src/main.tsx、src/App.tsx、src/shared/i18n.ts、tailwind.config.js、postcss.config.js
- 测试：tests/smoke.test.ts

- [ ] **步骤 1：初始化 package.json 与依赖**

~~~json
{
  "name": "adb-file-manager",
  "version": "0.1.0",
  "private": true,
  "main": "dist-electron/main.js",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "dist": "npm run build && electron-builder"
  }
}
~~~

运行：npm i -D electron electron-builder vite vite-plugin-electron @vitejs/plugin-react typescript vitest
运行：npm i react react-dom zustand zod @tanstack/react-virtual lucide-react electron-store
运行：npm i -D tailwindcss@3.4 postcss autoprefixer @types/react @types/react-dom
预期：node_modules 就绪，无 ERESOLVE。
国内网络提示：若 electron 下载卡住，先设置 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/。

- [ ] **步骤 2：配置 Vite（主进程 / 预加载 / 渲染层一体构建）**

~~~ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import path from 'node:path'

const root = import.meta.dirname

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: { entry: 'electron/main.ts' },
      preload: { input: path.join(root, 'electron/preload.ts') },
    }),
  ],
  resolve: {
    alias: {
      '@shared': path.join(root, 'src/shared'),
      '@': path.join(root, 'src'),
    },
  },
  server: { port: 5555 },
})
~~~

- [ ] **步骤 3：编写主进程最小骨架**

~~~ts
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#12141A',
    webPreferences: {
      preload: path.join(dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(dirname, '../dist/index.html'))
  }
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
~~~

- [ ] **步骤 4：编写预加载最小骨架**

~~~ts
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('api', { ping: () => 'pong' })
~~~

- [ ] **步骤 5：编写渲染层入口与冒烟测试**

~~~tsx
import { createRoot } from 'react-dom/client'
import './index.css'

function App() {
  return <div className="p-8 text-neutral-200">ADB 文件管家启动中…</div>
}

createRoot(document.getElementById('root')!).render(<App />)
~~~

~~~ts
import { describe, it, expect } from 'vitest'

describe('smoke', () => {
  it('运行测试链路', () => {
    expect(1 + 1).toBe(2)
  })
})
~~~

- [ ] **步骤 6：验证**

运行：npm run dev
预期：Electron 窗口打开，深色背景，显示「ADB 文件管家启动中…」。
运行：npm test
预期：1 passed。
运行：npm run dist
预期：dist 下产出 .exe 安装包（无图标时用默认图标）。

- [ ] **步骤 7：提交**

~~~bash
git add -A
git commit -m "feat: 初始化 Electron + React 工程脚手架"
~~~

---

### 任务 2：shell 转义与 AdbClient

**文件：**
- 创建：electron/adb/shellsafe.ts、electron/adb/client.ts
- 测试：tests/shellsafe.test.ts、tests/client.test.ts

- [ ] **步骤 1：编写失败的测试**

~~~ts
import { describe, it, expect } from 'vitest'
import { shellQuote } from '../electron/adb/shellsafe'

describe('shellQuote', () => {
  it('普通路径加单引号', () => {
    expect(shellQuote('/sdcard/DCIM')).toBe("'/sdcard/DCIM'")
  })
  it('中文与空格安全', () => {
    expect(shellQuote('/sdcard/我的 照片/a.jpg')).toBe("'/sdcard/我的 照片/a.jpg'")
  })
  it('单引号被正确转义', () => {
    expect(shellQuote("it's.txt")).toBe("'it'\"'\"'s.txt'")
  })
  it('空串也安全', () => {
    expect(shellQuote('')).toBe("''")
  })
})
~~~

- [ ] **步骤 2：运行测试确认失败**

运行：npx vitest run tests/shellsafe.test.ts
预期：FAIL，报 Cannot find module '../electron/adb/shellsafe'。

- [ ] **步骤 3：实现 shellQuote**

~~~ts
const SQ = String.fromCharCode(39)            // 单引号
const ESCAPED = SQ + '"' + SQ + '"' + SQ      // 展开为 '"'"' 的等价串

export function shellQuote(value: string): string {
  return SQ + value.split(SQ).join(ESCAPED) + SQ
}
~~~

- [ ] **步骤 4：运行测试确认通过**

运行：npx vitest run tests/shellsafe.test.ts
预期：4 passed。

- [ ] **步骤 5：编写 AdbClient 的失败测试**

~~~ts
import { describe, it, expect } from 'vitest'
import { AdbClient, E_NO_SERIAL } from '../electron/adb/client'

describe('AdbClient', () => {
  it('缺少 serial 直接抛错', () => {
    expect(() => new AdbClient('')).toThrow(E_NO_SERIAL)
  })
  it('命令自动带 -s serial', () => {
    const client = new AdbClient('ABC123')
    expect(client.buildArgs(['shell', 'ls'])).toEqual(['-s', 'ABC123', 'shell', 'ls'])
  })
})
~~~

- [ ] **步骤 6：实现 AdbClient**

~~~ts
import { spawn } from 'node:child_process'

export const E_NO_SERIAL = 'E_NO_SERIAL'

export interface RunResult { code: number | null; stdout: string; stderr: string }
export interface RunOptions { timeoutMs?: number; signal?: AbortSignal; onStdout?: (chunk: string) => void }

export class AdbClient {
  readonly serial: string
  constructor(serial: string) {
    if (!serial) throw new Error(E_NO_SERIAL)
    this.serial = serial
  }

  buildArgs(args: string[]): string[] {
    return ['-s', this.serial, ...args]
  }

  run(args: string[], opts: RunOptions & { adbPath: string }): Promise<RunResult> {
    const timeoutMs = opts.timeoutMs ?? 30_000
    return new Promise((resolve, reject) => {
      const child = spawn(opts.adbPath, this.buildArgs(args), { windowsHide: true })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) { child.kill(); reject(new Error('E_TIMEOUT')) }
      }, timeoutMs)

      child.stdout.on('data', (buf: Buffer) => {
        const text = buf.toString('utf8')
        stdout += text
        opts.onStdout?.(text)
      })
      child.stderr.on('data', (buf: Buffer) => { stderr += buf.toString('utf8') })
      opts.signal?.addEventListener('abort', () => child.kill())
      child.on('error', (err) => { settled = true; clearTimeout(timer); reject(err) })
      child.on('close', (code) => {
        settled = true
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
    })
  }
}
~~~

- [ ] **步骤 7：运行测试确认通过并提交**

运行：npx vitest run tests/client.test.ts
预期：2 passed。

~~~bash
git add -A
git commit -m "feat: 新增 shell 转义与带 serial 的 adb 命令封装"
~~~

---

### 任务 3：adb 定位与版本自检

**文件：**
- 创建：electron/adb/binary.ts
- 测试：tests/binary.test.ts

- [ ] **步骤 1：编写失败的测试**

~~~ts
import { describe, it, expect } from 'vitest'
import { buildCandidates, parseVersion } from '../electron/adb/binary'

describe('binary', () => {
  it('候选顺序为 custom > env > bundled > path', () => {
    const list = buildCandidates({ custom: 'C:/x/adb.exe', env: 'D:/adb.exe', resourcesPath: 'R' })
    expect(list.map((c) => c.source)).toEqual(['custom', 'env', 'bundled', 'path'])
  })
  it('解析 adb version 输出', () => {
    const out = 'Android Debug Bridge version 1.0.41\nVersion 34.0.4-10411341'
    expect(parseVersion(out)).toEqual({ version: '1.0.41', build: '34.0.4-10411341' })
  })
})
~~~

- [ ] **步骤 2：运行测试确认失败**

运行：npx vitest run tests/binary.test.ts
预期：FAIL，模块不存在。

- [ ] **步骤 3：实现 binary.ts**

~~~ts
import path from 'node:path'

export type AdbSource = 'custom' | 'env' | 'bundled' | 'path'
export interface Candidate { path: string; source: AdbSource }

export function buildCandidates(input: { custom?: string; env?: string; resourcesPath: string }): Candidate[] {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb'
  const list: Candidate[] = []
  if (input.custom) list.push({ path: input.custom, source: 'custom' })
  if (input.env) list.push({ path: input.env, source: 'env' })
  list.push({ path: path.join(input.resourcesPath, 'platform-tools', exe), source: 'bundled' })
  list.push({ path: 'adb', source: 'path' })
  return list
}

export function parseVersion(stdout: string): { version: string; build: string } {
  const v = /Android Debug Bridge version ([\d.]+)/.exec(stdout)?.[1] ?? ''
  const b = /Version ([\w.\-]+)/.exec(stdout)?.[1] ?? ''
  return { version: v, build: b }
}
~~~

- [ ] **步骤 4：运行测试确认通过**

运行：npx vitest run tests/binary.test.ts
预期：2 passed。

- [ ] **步骤 5：提交**

~~~bash
git add -A
git commit -m "feat: 新增 adb 路径定位与版本解析"
~~~

---

### 任务 4：设备发现与多设备会话

**文件：**
- 创建：electron/adb/track.ts、electron/devices/manager.ts、src/shared/types.ts
- 测试：tests/track.test.ts、tests/manager.test.ts

- [ ] **步骤 1：定义共享类型**

~~~ts
export interface FileEntry {
  name: string
  isDir: boolean
  isLink: boolean
  size: number
  mtime: number
  mode: string
  owner: string
  group: string
  linkTarget?: string
}

export type DeviceStatus = 'device' | 'unauthorized' | 'offline' | 'recovery' | 'unknown'
export type Transport = 'usb' | 'wireless'

export interface DeviceSession {
  serial: string
  status: DeviceStatus
  transport: Transport
  model?: string
  android?: string
  battery?: number
  storage?: { usedKb: number; totalKb: number }
  lastSeenAt: number
}
~~~

- [ ] **步骤 2：编写帧解析的失败测试**

~~~ts
import { describe, it, expect } from 'vitest'
import { FrameDecoder, parseDeviceLines } from '../electron/adb/track'

describe('track', () => {
  it('解析 4 位十六进制长度帧', () => {
    const d = new FrameDecoder()
    const frames = d.push(Buffer.from('0010\nABC123\tdevice\n'))
    expect(frames).toEqual(['ABC123\tdevice'])
  })
  it('兼容裸行输出', () => {
    const d = new FrameDecoder()
    const frames = d.push(Buffer.from('ABC123\tdevice\n'))
    expect(frames).toEqual(['ABC123\tdevice'])
  })
  it('多行解析为设备条目', () => {
    const rows = parseDeviceLines('ABC123\tdevice\n192.168.1.7:5555\toffline\n')
    expect(rows).toEqual([
      { serial: 'ABC123', status: 'device', transport: 'usb' },
      { serial: '192.168.1.7:5555', status: 'offline', transport: 'wireless' },
    ])
  })
})
~~~

- [ ] **步骤 3：运行测试确认失败**

运行：npx vitest run tests/track.test.ts
预期：FAIL，模块不存在。

- [ ] **步骤 4：实现 track.ts**

要点：帧头 4 位十六进制 + 换行；首个字符不是十六进制时按裸行处理；status 取自 adb 的 device / unauthorized / offline / recovery。

~~~ts
import type { DeviceStatus, Transport } from '../../src/shared/types'

export class FrameDecoder {
  private buf = Buffer.alloc(0)
  push(chunk: Buffer): string[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: string[] = []
    for (;;) {
      const nl = this.buf.indexOf(0x0a)
      if (nl < 0) break
      const head = this.buf.subarray(0, nl).toString('ascii')
      const maybeLen = /^[0-9a-fA-F]{4}$/.test(head) ? parseInt(head, 16) : -1
      if (maybeLen >= 0) {
        if (this.buf.length < nl + 1 + maybeLen) break
        out.push(this.buf.subarray(nl + 1, nl + 1 + maybeLen).toString('utf8'))
        this.buf = this.buf.subarray(nl + 1 + maybeLen)
      } else {
        out.push(head)
        this.buf = this.buf.subarray(nl + 1)
      }
    }
    return out
  }
}

export function parseDeviceLines(payload: string): { serial: string; status: DeviceStatus; transport: Transport }[] {
  return payload
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split('\t')
      const status = (['device', 'unauthorized', 'offline', 'recovery'].includes(state)
        ? state
        : 'unknown') as DeviceStatus
      const transport: Transport = serial.includes(':') ? 'wireless' : 'usb'
      return { serial, status, transport }
    })
}
~~~

- [ ] **步骤 5：运行测试确认通过**

运行：npx vitest run tests/track.test.ts
预期：3 passed。

- [ ] **步骤 6：实现 DeviceManager（状态机 + 会话保留）**

要点：Map 存储会话；删除设备时把状态置 offline 并记录 lostAt；30 分钟后清理；对同一 serial 重现则复用会话。

~~~ts
import { EventEmitter } from 'node:events'
import type { DeviceSession } from '../../src/shared/types'

const RETAIN_MS = 30 * 60 * 1000

export class DeviceManager extends EventEmitter {
  private sessions = new Map<string, DeviceSession>()
  private lostAt = new Map<string, number>()

  upsert(input: Partial<DeviceSession> & { serial: string; status: DeviceSession['status'] }): void {
    const prev = this.sessions.get(input.serial)
    const next: DeviceSession = {
      transport: 'usb',
      ...prev,
      ...input,
      lastSeenAt: Date.now(),
    }
    this.sessions.set(next.serial, next)
    this.lostAt.delete(next.serial)
    this.emit('changed', next)
  }

  markLost(serial: string): void {
    const s = this.sessions.get(serial)
    if (!s) return
    s.status = 'offline'
    this.lostAt.set(serial, Date.now())
    this.emit('changed', s)
  }

  gc(now = Date.now()): void {
    for (const [serial, at] of this.lostAt) {
      if (now - at > RETAIN_MS) {
        this.sessions.delete(serial)
        this.lostAt.delete(serial)
        this.emit('removed', serial)
      }
    }
  }

  list(): DeviceSession[] {
    return [...this.sessions.values()]
  }
}
~~~

- [ ] **步骤 7：为 manager 写测试并提交**

~~~ts
import { describe, it, expect } from 'vitest'
import { DeviceManager } from '../electron/devices/manager'

describe('DeviceManager', () => {
  it('同 serial 重现复用会话', () => {
    const m = new DeviceManager()
    m.upsert({ serial: 'A', status: 'device', model: 'Pixel 7' })
    m.markLost('A')
    m.upsert({ serial: 'A', status: 'device' })
    expect(m.list()[0].model).toBe('Pixel 7')
    expect(m.list()[0].status).toBe('device')
  })
  it('超 30 分钟清理', () => {
    const m = new DeviceManager()
    m.upsert({ serial: 'B', status: 'device' })
    m.markLost('B')
    m.gc(Date.now() + 31 * 60 * 1000)
    expect(m.list()).toHaveLength(0)
  })
})
~~~

运行：npx vitest run tests/manager.test.ts
预期：2 passed。

~~~bash
git add -A
git commit -m "feat: 新增设备发现帧解析与多设备会话管理"
~~~

---

### 任务 5：远程目录列表解析

**文件：**
- 创建：electron/adb/list-parser.ts、electron/fs/remote.ts
- 测试：tests/list-parser.test.ts

- [ ] **步骤 1：写解析器的失败测试**

FileEntry 类型已在任务 4 的 src/shared/types.ts 中定义，这里直接 import，不重复声明。

~~~ts
import { describe, it, expect } from 'vitest'
import { parseLsLong, parseLsLongWithStats } from '../electron/adb/list-parser'

const SAMPLE = [
  'total 24',
  'drwxrwx--x 4 root sdcard_r 4096 2024-10-12 09:31 Camera',
  '-rw-rw---- 1 root sdcard_r 2457600 2024-10-12 09:31 IMG_0001.jpg',
  '-rw-rw---- 1 root sdcard_r 12 2024-10-12 09:31 我的 照片.jpg',
  "lrwxrwxrwx 1 root root 21 2024-10-12 09:31 link -> /sdcard/DCIM",
].join('\n')

describe('parseLsLong', () => {
  it('跳过 total 行并解析目录与文件', () => {
    const rows = parseLsLong(SAMPLE)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({ name: 'Camera', isDir: true, size: 4096 })
  })
  it('保留含空格的名称', () => {
    expect(parseLsLong(SAMPLE)[2].name).toBe('我的 照片.jpg')
  })
  it('解析符号链接目标', () => {
    expect(parseLsLong(SAMPLE)[3]).toMatchObject({ isLink: true, linkTarget: '/sdcard/DCIM' })
  })
  it('返回未解析比例用于降级判断', () => {
    expect(parseLsLongWithStats('garbage line\n').unparsed).toBe(1)
  })
})
~~~

- [ ] **步骤 2：运行测试确认失败**

运行：npx vitest run tests/list-parser.test.ts
预期：FAIL，模块不存在。

- [ ] **步骤 3：实现解析器**

~~~ts
import type { FileEntry } from '../../src/shared/types'

const LONG_RE =
  /^([dlbcps-][rwxsStT-]{9})[.+]?\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s+(.*)$/

export function parseLsLongWithStats(text: string): { entries: FileEntry[]; unparsed: number } {
  const entries: FileEntry[] = []
  let unparsed = 0
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.startsWith('total ')) continue
    const m = LONG_RE.exec(line)
    if (!m) { unparsed += 1; continue }
    const [, mode, , owner, group, size, date, time, rest] = m
    let name = rest
    let linkTarget: string | undefined
    const arrow = rest.indexOf(' -> ')
    if (mode.startsWith('l') && arrow >= 0) {
      name = rest.slice(0, arrow)
      linkTarget = rest.slice(arrow + 4)
    }
    entries.push({
      name,
      isDir: mode.startsWith('d'),
      isLink: mode.startsWith('l'),
      size: Number(size),
      mtime: Date.parse(date + 'T' + (time.length === 5 ? time : time.slice(0, 5)) + ':00'),
      mode,
      owner,
      group,
      linkTarget,
    })
  }
  return { entries, unparsed }
}

export function parseLsLong(text: string): FileEntry[] {
  return parseLsLongWithStats(text).entries
}
~~~

- [ ] **步骤 4：运行测试确认通过**

运行：npx vitest run tests/list-parser.test.ts
预期：4 passed。

- [ ] **步骤 5：实现 remote.ts（列举 + 降级）**

要点：命令为 LC_ALL=C ls -lA -- 加 shellQuote(path)；若未解析比例 > 20%，改用 stat 逐项补齐；Permission denied 映射为 E_NO_PERMISSION。

~~~ts
import { AdbClient } from '../adb/client'
import { shellQuote } from '../adb/shellsafe'
import { parseLsLongWithStats } from '../adb/list-parser'
import type { FileEntry } from '../../src/shared/types'

export async function listDir(client: AdbClient, adbPath: string, dir: string): Promise<FileEntry[]> {
  const cmd = 'LC_ALL=C ls -lA -- ' + shellQuote(dir)
  const { code, stdout, stderr } = await client.run(['shell', cmd], { adbPath, timeoutMs: 60_000 })
  if (code !== 0 && /Permission denied/i.test(stderr)) throw new Error('E_NO_PERMISSION')
  const { entries, unparsed } = parseLsLongWithStats(stdout)
  if (entries.length + unparsed > 0 && unparsed / (entries.length + unparsed) > 0.2) {
    throw new Error('E_PARSE_DEGRADED')
  }
  return entries
}
~~~

- [ ] **步骤 6：提交**

~~~bash
git add -A
git commit -m "feat: 新增远程目录列举与 ls 长格式解析器"
~~~

---

### 任务 6：IPC 桥与设备栏 UI

**文件：**
- 创建：electron/ipc/channels.ts、electron/ipc/handlers.ts、src/store/deviceStore.ts、src/components/DeviceRail.tsx
- 修改：electron/main.ts、electron/preload.ts、src/App.tsx

- [ ] **步骤 1：定义通道常量**

~~~ts
export const CH = {
  DEVICES_LIST: 'devices:list',
  DEVICES_CHANGED: 'devices:changed',
  FS_LIST: 'fs:list',
} as const
~~~

- [ ] **步骤 2：注册 handler（含 zod 校验）**

~~~ts
import { ipcMain } from 'electron'
import { z } from 'zod'
import { CH } from './channels'
import type { DeviceManager } from '../devices/manager'

const listSchema = z.object({ serial: z.string().min(1), dir: z.string().min(1) })

export function registerHandlers(deps: { devices: DeviceManager }): void {
  ipcMain.handle(CH.DEVICES_LIST, () => deps.devices.list())
  ipcMain.handle(CH.FS_LIST, (_e, payload) => {
    const parsed = listSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: 'E_BAD_ARGS' }
    return { ok: true, data: [] }
  })
}
~~~

- [ ] **步骤 3：预加载暴露 API**

~~~ts
import { contextBridge, ipcRenderer } from 'electron'
import { CH } from './ipc/channels'

contextBridge.exposeInMainWorld('api', {
  devices: {
    list: () => ipcRenderer.invoke(CH.DEVICES_LIST),
    onChanged: (cb: (d: unknown) => void) => {
      const fn = (_e: unknown, d: unknown) => cb(d)
      ipcRenderer.on(CH.DEVICES_CHANGED, fn)
      return () => ipcRenderer.off(CH.DEVICES_CHANGED, fn)
    },
  },
})
~~~

- [ ] **步骤 4：实现 deviceStore**

~~~ts
import { create } from 'zustand'
import type { DeviceSession } from '@shared/types'

interface DeviceState {
  devices: DeviceSession[]
  activeSerial: string | null
  setDevices: (list: DeviceSession[]) => void
  setActive: (serial: string) => void
}

export const useDeviceStore = create<DeviceState>((set) => ({
  devices: [],
  activeSerial: null,
  setDevices: (list) =>
    set((s) => ({ devices: list, activeSerial: s.activeSerial ?? list[0]?.serial ?? null })),
  setActive: (serial) => set({ activeSerial: serial }),
}))
~~~

- [ ] **步骤 5：实现 DeviceRail（状态点 + 型号 + 迷你进度）**

~~~tsx
import { useDeviceStore } from '@/store/deviceStore'

const DOT: Record<string, string> = {
  device: 'bg-emerald-400',
  offline: 'bg-neutral-500',
  unauthorized: 'bg-amber-400',
  recovery: 'bg-sky-400',
  unknown: 'bg-neutral-600',
}

export function DeviceRail() {
  const { devices, activeSerial, setActive } = useDeviceStore()
  return (
    <aside className="w-[200px] shrink-0 border-r border-neutral-800 overflow-y-auto">
      {devices.map((d) => (
        <button
          key={d.serial}
          onClick={() => setActive(d.serial)}
          className={
            'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-800 ' +
            (d.serial === activeSerial ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400')
          }
        >
          <span className={'h-2 w-2 rounded-full ' + (DOT[d.status] ?? DOT.unknown)} />
          <span className="truncate">{d.model ?? d.serial}</span>
          <span className="ml-auto text-xs text-neutral-600">{d.serial.slice(-4)}</span>
        </button>
      ))}
    </aside>
  )
}
~~~

- [ ] **步骤 6：验证并提交**

运行：npm run dev
预期：窗口左侧出现设备栏区域；插入手机（或伪造 devices:list 返回值）后出现设备行。

~~~bash
git add -A
git commit -m "feat: 新增 IPC 桥与设备栏"
~~~

---

### 任务 7：文件页（虚拟滚动 + 面包屑 + 每设备独立状态）

**文件：**
- 创建：src/store/fileStore.ts、src/components/FileTable.tsx、src/pages/FilesPage.tsx、src/components/Breadcrumb.tsx
- 修改：electron/ipc/handlers.ts（FS_LIST 接真实 remote.listDir）

- [ ] **步骤 1：fileStore 按 serial 分片**

~~~ts
import { create } from 'zustand'
import type { FileEntry } from '@shared/types'

interface FileViewState { cwd: string; history: string[]; sort: 'name' | 'size' | 'time'; entries: FileEntry[]; loading: boolean }
interface FileState {
  views: Record<string, FileViewState>
  ensure: (serial: string) => FileViewState
  setCwd: (serial: string, cwd: string) => void
  setEntries: (serial: string, entries: FileEntry[]) => void
}

const DEFAULT_VIEW: FileViewState = { cwd: '/sdcard', history: [], sort: 'name', entries: [], loading: false }

export const useFileStore = create<FileState>((set, get) => ({
  views: {},
  ensure: (serial) => {
    const v = get().views[serial]
    if (v) return v
    set((s) => ({ views: { ...s.views, [serial]: { ...DEFAULT_VIEW } } }))
    return DEFAULT_VIEW
  },
  setCwd: (serial, cwd) => set((s) => ({
    views: { ...s.views, [serial]: { ...s.views[serial], cwd, history: [...(s.views[serial]?.history ?? []), s.views[serial]?.cwd ?? ''] } },
  })),
  setEntries: (serial, entries) => set((s) => ({ views: { ...s.views, [serial]: { ...s.views[serial], entries, loading: false } } })),
}))
~~~

- [ ] **步骤 2：FileTable 用虚拟滚动渲染**

~~~tsx
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'
import type { FileEntry } from '@shared/types'

export function FileTable({ entries, onOpen }: { entries: FileEntry[]; onOpen: (e: FileEntry) => void }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 34,
    overscan: 12,
  })
  return (
    <div ref={parentRef} className="h-full overflow-auto">
      <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
        {virt.getVirtualItems().map((vi) => {
          const e = entries[vi.index]
          return (
            <div
              key={vi.key}
              onClick={() => onOpen(e)}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 34, transform: 'translateY(' + vi.start + 'px)' }}
              className="flex items-center gap-3 px-3 text-sm text-neutral-300 hover:bg-neutral-800"
            >
              <span>{e.isDir ? '📁' : '📄'}</span>
              <span className="truncate">{e.name}</span>
              <span className="ml-auto text-xs text-neutral-500">{e.isDir ? '—' : e.size}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
~~~

- [ ] **步骤 3：FilesPage 串联（进入目录、面包屑、刷新）**

~~~tsx
import { useEffect } from 'react'
import { useDeviceStore } from '@/store/deviceStore'
import { useFileStore } from '@/store/fileStore'
import { FileTable } from '@/components/FileTable'
import { Breadcrumb } from '@/components/Breadcrumb'

export function FilesPage() {
  const serial = useDeviceStore((s) => s.activeSerial)
  const view = useFileStore((s) => (serial ? s.views[serial] : undefined))
  const setCwd = useFileStore((s) => s.setCwd)
  const setEntries = useFileStore((s) => s.setEntries)

  useEffect(() => {
    if (!serial || !view) return
    window.api.fs.list({ serial, dir: view.cwd }).then((r) => {
      if (r.ok) setEntries(serial, r.data)
    })
  }, [serial, view?.cwd])

  if (!serial) return <div className="p-8 text-neutral-500">请在左侧选择设备</div>
  return (
    <section className="flex h-full flex-col">
      <Breadcrumb path={view?.cwd ?? '/sdcard'} onJump={(p) => setCwd(serial, p)} />
      <FileTable
        entries={view?.entries ?? []}
        onOpen={(e) => {
          if (e.isDir) setCwd(serial, (view?.cwd ?? '/sdcard').replace(/\/$/, '') + '/' + e.name)
        }}
      />
    </section>
  )
}
~~~

- [ ] **步骤 4：手工验证**

运行：npm run dev，连接一台真机
预期：进入 /sdcard 能看到目录；点目录进入子目录；两台设备各自停在各自目录，切回不互相覆盖。

- [ ] **步骤 5：提交**

~~~bash
git add -A
git commit -m "feat: 新增文件页虚拟滚动列表与每设备独立视图状态"
~~~

---

### 任务 8：传输队列（按设备分组 + 并发 + 进度）

**文件：**
- 创建：electron/transfer/queue.ts、electron/ipc/（新增通道）、src/store/transferStore.ts、src/components/TransferDock.tsx
- 测试：tests/queue.test.ts

- [ ] **步骤 1：定义任务与失败测试**

~~~ts
export type Direction = 'push' | 'pull'
export type TransferStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled'

export interface TransferTask {
  id: string
  serial: string
  direction: Direction
  src: string
  dst: string
  totalBytes: number
  doneBytes: number
  status: TransferStatus
  error?: string
}
~~~

~~~ts
import { describe, it, expect } from 'vitest'
import { TransferQueue } from '../electron/transfer/queue'

describe('TransferQueue', () => {
  it('同一设备串行：先入队先执行', () => {
    const q = new TransferQueue({ maxPerDevice: 1, maxGlobal: 3 })
    const a = q.enqueue({ serial: 'A', direction: 'push', src: 'x', dst: 'y', totalBytes: 10 })
    const b = q.enqueue({ serial: 'A', direction: 'push', src: 'x2', dst: 'y2', totalBytes: 10 })
    expect(q.next()).toBe(a.id)
    q.complete(a.id)
    expect(q.next()).toBe(b.id)
  })
  it('不同设备可并行', () => {
    const q = new TransferQueue({ maxPerDevice: 1, maxGlobal: 3 })
    const a = q.enqueue({ serial: 'A', direction: 'push', src: 'x', dst: 'y', totalBytes: 1 })
    const b = q.enqueue({ serial: 'B', direction: 'push', src: 'x', dst: 'y', totalBytes: 1 })
    expect([q.next(), q.next()].sort()).toEqual([a.id, b.id].sort())
  })
})
~~~

- [ ] **步骤 2：运行测试确认失败**

运行：npx vitest run tests/queue.test.ts
预期：FAIL，模块不存在。

- [ ] **步骤 3：实现 TransferQueue**

~~~ts
import { randomUUID } from 'node:crypto'
import type { Direction, TransferTask, TransferStatus } from '../../src/shared/types'

export class TransferQueue {
  private tasks = new Map<string, TransferTask>()
  private running = new Set<string>()
  constructor(private cfg: { maxPerDevice: number; maxGlobal: number }) {}

  enqueue(input: { serial: string; direction: Direction; src: string; dst: string; totalBytes: number }): TransferTask {
    const task: TransferTask = { id: randomUUID(), ...input, doneBytes: 0, status: 'queued' }
    this.tasks.set(task.id, task)
    return task
  }

  next(now = Date.now()): string | null {
    if (this.running.size >= this.cfg.maxGlobal) return null
    const perDevice = new Map<string, number>()
    for (const id of this.running) {
      const t = this.tasks.get(id)!
      perDevice.set(t.serial, (perDevice.get(t.serial) ?? 0) + 1)
    }
    for (const t of this.tasks.values()) {
      if (t.status !== 'queued') continue
      if ((perDevice.get(t.serial) ?? 0) >= this.cfg.maxPerDevice) continue
      this.running.add(t.id)
      perDevice.set(t.serial, (perDevice.get(t.serial) ?? 0) + 1)
      t.status = 'running'
      return t.id
    }
    return null
  }

  progress(id: string, doneBytes: number): void {
    const t = this.tasks.get(id)
    if (t) t.doneBytes = Math.min(doneBytes, t.totalBytes)
  }

  finish(id: string, status: TransferStatus, error?: string): void {
    const t = this.tasks.get(id)
    if (!t) return
    t.status = status
    t.error = error
    this.running.delete(id)
  }

  complete(id: string): void { this.finish(id, 'done') }

  get(id: string): TransferTask | undefined { return this.tasks.get(id) }
  list(): TransferTask[] { return [...this.tasks.values()] }
}
~~~

- [ ] **步骤 4：运行测试确认通过**

运行：npx vitest run tests/queue.test.ts
预期：2 passed。

- [ ] **步骤 5：接入真实 adb 传输与进度解析**

要点：push 用 adb -s S push -p local remote；进度从 [ 62%] 提取，doneBytes = round(0.62 × totalBytes)；totalBytes 由本地 stat（push）或远程 stat（pull）预先取得；取消通过 AbortController 杀子进程。

~~~ts
export function parseProgress(text: string): number | null {
  const m = /\[\s*(\d+)%\]/.exec(text)
  return m ? Number(m[1]) / 100 : null
}
~~~

- [ ] **步骤 6：TransferDock 底栏展示**

~~~tsx
import { useTransferStore } from '@/store/transferStore'

export function TransferDock() {
  const tasks = useTransferStore((s) => s.tasks)
  const running = tasks.filter((t) => t.status === 'running')
  const pending = tasks.filter((t) => t.status === 'queued')
  return (
    <footer className="border-t border-neutral-800 px-3 py-2 text-xs text-neutral-400">
      {running.length + pending.length === 0 ? (
        <span>传输空闲</span>
      ) : (
        running.map((t) => (
          <div key={t.id} className="flex items-center gap-2">
            <span>{t.serial.slice(-4)}</span>
            <span className="truncate">{t.direction === 'push' ? '上传' : '下载'} {t.src}</span>
            <span>{Math.round((t.doneBytes / Math.max(t.totalBytes, 1)) * 100)}%</span>
          </div>
        ))
      )}
    </footer>
  )
}
~~~

- [ ] **步骤 7：手工验证并提交**

验证：1 GB 文件 push 到手机，进度条与实际相符；中途取消，确认 adb 子进程消失（任务管理器查看）。
预期：进度误差 < 3%，取消后无残留进程。

~~~bash
git add -A
git commit -m "feat: 新增按设备分组的上传下载队列与进度展示"
~~~

---

### 任务 9：文件操作与本地双栏

**文件：**
- 创建：electron/fs/operations.ts、src/components/LocalPanel.tsx
- 修改：electron/ipc/handlers.ts、src/pages/FilesPage.tsx、src/store/fileStore.ts

- [ ] **步骤 1：实现远程文件操作**

~~~ts
import { AdbClient } from '../adb/client'
import { shellQuote } from '../adb/shellsafe'

export async function mkdir(client: AdbClient, adbPath: string, dir: string, name: string) {
  return client.run(['shell', 'mkdir -p -- ' + shellQuote(dir + '/' + name)], { adbPath })
}
export async function rename(client: AdbClient, adbPath: string, from: string, to: string) {
  return client.run(['shell', 'mv -- ' + shellQuote(from) + ' ' + shellQuote(to)], { adbPath })
}
export async function remove(client: AdbClient, adbPath: string, target: string, recursive: boolean) {
  return client.run(['shell', 'rm ' + (recursive ? '-rf ' : '') + '-- ' + shellQuote(target)], { adbPath })
}
export async function copy(client: AdbClient, adbPath: string, from: string, to: string) {
  return client.run(['shell', 'cp -a -- ' + shellQuote(from) + ' ' + shellQuote(to)], { adbPath })
}
~~~

- [ ] **步骤 2：本地目录列举（主进程）**

~~~ts
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export async function listLocal(dir: string) {
  const names = await readdir(dir)
  return Promise.all(
    names.map(async (name) => {
      const full = path.join(dir, name)
      const st = await stat(full)
      return { name, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, full }
    }),
  )
}
~~~

- [ ] **步骤 3：LocalPanel 组件（可折叠、可调宽）**

~~~tsx
import { useEffect, useState } from 'react'

export function LocalPanel() {
  const [cwd, setCwd] = useState<string>('')
  const [items, setItems] = useState<{ name: string; isDir: boolean }[]>([])
  useEffect(() => {
    window.api.local.list(cwd || undefined).then((r) => {
      if (r.ok) { setCwd(r.data.cwd); setItems(r.data.items) }
    })
  }, [cwd])
  return (
    <aside className="w-[320px] shrink-0 border-l border-neutral-800 overflow-y-auto">
      <div className="px-3 py-2 text-xs text-neutral-500 truncate">{cwd}</div>
      {items.map((i) => (
        <div key={i.name} onClick={() => i.isDir && setCwd(cwd + '\\' + i.name)} className="px-3 py-1 text-sm text-neutral-300 hover:bg-neutral-800">
          {i.isDir ? '📁' : '📄'} {i.name}
        </div>
      ))}
    </aside>
  )
}
~~~

- [ ] **步骤 4：删除二次确认**

~~~tsx
const ok = window.confirm('将删除 ' + names.length + ' 项：\n' + names.slice(0, 3).join('\n') + (names.length > 3 ? '\n…' : ''))
if (!ok) return
~~~

- [ ] **步骤 5：手工验证并提交**

验证：新建「测试 目录」、把「我的 照片.jpg」改名、复制到 Download、删除；中文与空格全部正常。
预期：全部成功，无「No such file」类错误。

~~~bash
git add -A
git commit -m "feat: 新增远程文件操作与本地双栏面板"
~~~

---

### 任务 10：设备总览页与批量操作

**文件：**
- 创建：src/pages/OverviewPage.tsx、electron/batch/runner.ts
- 修改：src/App.tsx（路由）、src/components/DeviceRail.tsx（底部入口）

- [ ] **步骤 1：实现批量执行器（逐设备隔离失败）**

~~~ts
export interface BatchResult { serial: string; ok: boolean; message: string }

export async function runBatch(
  serials: string[],
  worker: (serial: string) => Promise<void>,
  concurrency = 3,
): Promise<BatchResult[]> {
  const out: BatchResult[] = []
  const queue = [...serials]
  const lanes = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const serial = queue.shift()
      if (!serial) return
      try {
        await worker(serial)
        out.push({ serial, ok: true, message: '成功' })
      } catch (err) {
        out.push({ serial, ok: false, message: err instanceof Error ? err.message : String(err) })
      }
    }
  })
  await Promise.all(lanes)
  return out
}
~~~

- [ ] **步骤 2：OverviewPage 设备表 + 勾选 + 结果矩阵**

~~~tsx
import { useState } from 'react'
import { useDeviceStore } from '@/store/deviceStore'

export function OverviewPage() {
  const devices = useDeviceStore((s) => s.devices)
  const [picked, setPicked] = useState<string[]>([])
  const toggle = (serial: string) =>
    setPicked((p) => (p.includes(serial) ? p.filter((s) => s !== serial) : [...p, serial]))
  return (
    <section className="p-6">
      <header className="mb-4 flex items-center gap-3">
        <h2 className="text-lg text-neutral-200">设备总览</h2>
        <button
          disabled={picked.length === 0}
          onClick={() => window.api.batch.screenshot(picked)}
          className="rounded bg-sky-600 px-3 py-1 text-sm text-white disabled:opacity-40"
        >
          批量截图
        </button>
        <span className="text-sm text-neutral-500">已选 {picked.length} 台</span>
      </header>
      <ul className="divide-y divide-neutral-800">
        {devices.map((d) => (
          <li key={d.serial} className="flex items-center gap-3 py-2 text-sm text-neutral-300">
            <input type="checkbox" checked={picked.includes(d.serial)} onChange={() => toggle(d.serial)} />
            <span className="w-40 truncate">{d.model ?? d.serial}</span>
            <span className="w-24">{d.status === 'device' ? '在线' : d.status}</span>
            <span>{d.android ? 'Android ' + d.android : '—'}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
~~~

- [ ] **步骤 3：手工验证**

准备 2 台真机（或 1 台真机 + 1 台模拟器）
预期：勾选后点「批量截图」，两台设备各生成一张 png；其中一台失败时结果矩阵单独标红，不影响另一台。

- [ ] **步骤 4：提交**

~~~bash
git add -A
git commit -m "feat: 新增设备总览页与批量操作"
~~~

---

### 任务 11：打包与内置 adb

**文件：**
- 创建：electron-builder.json、scripts/fetch-platform-tools.mjs
- 修改：package.json（dist 脚本）

- [ ] **步骤 1：下载并内置 platform-tools**

运行：node scripts/fetch-platform-tools.mjs
预期：resources/platform-tools/adb.exe 存在。
说明：脚本从 dl.google.com/android/repository/platform-tools-latest-windows.zip 下载并解压，校验 adb.exe 存在后结束；失败时提示手动放置。

- [ ] **步骤 2：配置 electron-builder**

~~~json
{
  "appId": "com.local.adbfilemanager",
  "productName": "ADB 文件管家",
  "directories": { "output": "release" },
  "files": ["dist/**", "dist-electron/**"],
  "extraResources": [{ "from": "resources/platform-tools", "to": "platform-tools" }],
  "win": { "target": ["nsis", "portable"] }
}
~~~

- [ ] **步骤 3：验证产物**

运行：npm run dist
预期：release 下同时产出安装包与便携版；安装后启动，设置页显示「使用内置 adb 1.0.41」。

- [ ] **步骤 4：在干净环境验证**

在无 Android SDK 的机器上运行安装包
预期：插手机后能识别设备；不依赖系统 PATH 中的 adb。

- [ ] **步骤 5：提交**

~~~bash
git add -A
git commit -m "build: 打包配置与内置 platform-tools"
~~~

---

## 验收清单（M2.5 结束）

- [ ] 插入 2 台设备，左右各自浏览目录互不干扰
- [ ] 1 GB 文件上传/下载进度准确，取消后无残留进程
- [ ] 中文、空格、单引号文件名全链路正常
- [ ] 一路断线不影响另一路传输
- [ ] 总览页批量安装 3 台设备，失败项独立标注
- [ ] 干净 Win10 上安装包可运行且自带 adb
