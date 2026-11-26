import { describe, it, expect } from 'vitest'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AppsService, type AppsServiceDeps } from '../electron/apps/service'
import type { DeviceSession } from '../src/shared/types'
import type { RunResult } from '../electron/adb/client'

/*
 * 应用管理的编排（P1 第二批）。
 *
 * 被测对象是「一次意图 → 一串 adb 命令」这条链路，断言的是命令序列与成败判定。
 * 真机上这两件事出错都是不可逆的：卸载错的应用、清掉别人的数据、
 * 或者把 Failure 当成 Success 让用户以为操作生效了。
 */

const LOCAL_DIR = mkdtempSync(path.join(tmpdir(), 'adbfm-apps-'))

interface Call { args: string[] }

type Result1 = (args: string[]) => RunResult | Promise<RunResult>

function fakeClient(result: Result1) {
  const calls: Call[] = []
  return {
    calls,
    args: () => calls.map((c) => c.args.join(' ')),
    run: async (args: string[]): Promise<RunResult> => {
      calls.push({ args })
      return result(args)
    },
  }
}

function online(serial: string): DeviceSession {
  return { serial, status: 'device', transport: 'usb', model: 'Pixel', android: '14', lastSeenAt: Date.now() } as DeviceSession
}

function harness(result: Result1, over: Partial<AppsServiceDeps> = {}) {
  const client = fakeClient(result)
  const deps: AppsServiceDeps = {
    devices: { get: (serial) => (serial === 'GONE' ? undefined : online(serial)) },
    clientFor: () => client,
    adbPath: () => 'C:/adb.exe',
    defaultDstDir: () => LOCAL_DIR,
    ...over,
  }
  return { service: new AppsService(deps), client }
}

describe('列表', () => {
  it('只发一条命令（不逐包 dumpsys：200 个应用会卡死首屏）', async () => {
    const { service, client } = harness((args) =>
      args.join(' ').includes('pm list packages')
        ? { code: 0, stdout: 'package:com.a versionCode:1\r\npackage:com.b versionCode:2', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    )
    const apps = await service.listApps('S1')
    expect(apps.map((a) => a.packageName)).toEqual(['com.a', 'com.b'])
    expect(client.calls).toHaveLength(1)
  })

  it('结果按包名排序（设备给出的顺序不稳定）', async () => {
    const { service } = harness(() => ({ code: 0, stdout: 'package:com.z versionCode:1\r\npackage:com.a versionCode:2', stderr: '' }))
    const apps = await service.listApps('S1')
    expect(apps.map((a) => a.packageName)).toEqual(['com.a', 'com.z'])
  })

  it('离线设备在发命令之前就失败（零 adb 命令）', async () => {
    const { service, client } = harness(() => ({ code: 0, stdout: '', stderr: '' }))
    await expect(service.listApps('GONE')).rejects.toThrow('E_NO_SERIAL')
    expect(client.calls).toHaveLength(0)
  })

  it('非零退出且解析不出任何条目时报错误码（不静默返回空列表）', async () => {
    const { service } = harness(() => ({ code: 1, stdout: '', stderr: 'Permission denied' }))
    await expect(service.listApps('S1')).rejects.toThrow('E_NO_PERMISSION')
  })

  it('非零退出但有可解析输出时照常返回（部分 ROM 会这样）', async () => {
    const { service } = harness(() => ({ code: 1, stdout: 'package:com.a versionCode:1', stderr: 'warning' }))
    const apps = await service.listApps('S1')
    expect(apps).toHaveLength(1)
  })
})

describe('详情', () => {
  it('发 dumpsys package 并解析出版本', async () => {
    const { service, client } = harness(() => ({
      code: 0,
      stdout: '    versionCode=35 minSdk=24\r\n    versionName=2.1.2.beta3\r\n    flags=[ ALLOW_CLEAR_USER_DATA ]',
      stderr: '',
    }))
    const detail = await service.appDetail('S1', 'com.tjh.uav.normal')
    expect(detail.versionName).toBe('2.1.2.beta3')
    expect(detail.versionCode).toBe(35)
    expect(detail.allowClearData).toBe(true)
    expect(client.args()[0]).toContain('dumpsys package com.tjh.uav.normal')
  })

  it('畸形包名在拼命令之前就被拒（防止拼出怪命令）', async () => {
    const { service, client } = harness(() => ({ code: 0, stdout: '', stderr: '' }))
    await expect(service.appDetail('S1', 'com.a; rm -rf /sdcard')).rejects.toThrow('E_BAD_ARGS')
    expect(client.calls).toHaveLength(0)
  })
})
describe('拉取 APK', () => {
  it('先 pm path 再逐个 pull（split APK 全拉，只拉 base 装不回去）', async () => {
    const { service, client } = harness((args) => {
      const joined = args.join(' ')
      if (joined.includes('pm path')) {
        return { code: 0, stdout: 'package:/data/app/x/base.apk\r\npackage:/data/app/x/split_arm64.apk', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const result = await service.pullApk('S1', 'com.tjh.uav.normal', LOCAL_DIR)
    expect(result.files).toHaveLength(2)
    const args = client.args()
    expect(args[0]).toContain('pm path com.tjh.uav.normal')
    expect(args.filter((a) => a.startsWith('pull '))).toHaveLength(2)
  })

  it('pm path 没给出任何 apk 时报 E_NOT_FOUND（不是静默成功）', async () => {
    const { service } = harness((args) =>
      args.join(' ').includes('pm path') ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' },
    )
    await expect(service.pullApk('S1', 'com.absent', LOCAL_DIR)).rejects.toThrow('E_NOT_FOUND')
  })

  it('pull 失败时抛错（不让用户以为拉到了）', async () => {
    const { service } = harness((args) => {
      const joined = args.join(' ')
      if (joined.includes('pm path')) return { code: 0, stdout: 'package:/data/app/x/base.apk', stderr: '' }
      return { code: 1, stdout: '', stderr: 'Permission denied' }
    })
    await expect(service.pullApk('S1', 'com.a', LOCAL_DIR)).rejects.toThrow('E_NO_PERMISSION')
  })

  it('目标目录不存在时在发 pm path 之前就失败', async () => {
    const { service, client } = harness(() => ({ code: 0, stdout: 'package:/a.apk', stderr: '' }))
    await expect(service.pullApk('S1', 'com.a', path.join(LOCAL_DIR, 'no-such-subdir'))).rejects.toThrow('E_NOT_FOUND')
    expect(client.calls).toHaveLength(0)
  })

  it('dstDir 传空串 = 用默认下载路径', async () => {
    const { service } = harness((args) => {
      const joined = args.join(' ')
      if (joined.includes('pm path')) return { code: 0, stdout: 'package:/data/app/x/base.apk', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const result = await service.pullApk('S1', 'com.a', '')
    /*
     * 按目录名辨认，不做整条路径的字符串比较：Windows 临时目录同时存在长名
     * （Administrator）与 8.3 短名（ADMINI~1），而 realpathSync 不保证把短名
     * 展开成长名，字符串比较会把同一个目录判成两个 —— 那是断言过严。
     */
    expect(path.basename(path.dirname(result.files[0]))).toBe(path.basename(LOCAL_DIR))
  })
})

describe('卸载 / 清数据：成败看 stdout，不看退出码', () => {
  it('Success 判成功', async () => {
    const { service, client } = harness(() => ({ code: 0, stdout: 'Success', stderr: '' }))
    await service.uninstall('S1', 'com.a')
    expect(client.args()[0]).toContain('pm uninstall com.a')
  })

  it('退出码 0 但输出 Failure 时必须报错（否则用户以为卸了，其实没卸）', async () => {
    const { service } = harness(() => ({ code: 0, stdout: 'Failure [DELETE_FAILED_INTERNAL_ERROR]', stderr: '' }))
    await expect(service.uninstall('S1', 'com.a')).rejects.toThrow('E_OP_FAILED')
  })

  it('清数据同样是 stdout 判定', async () => {
    const { service } = harness(() => ({ code: 0, stdout: 'Failure [DELETE_FAILED_INTERNAL_ERROR]', stderr: '' }))
    await expect(service.clearData('S1', 'com.a')).rejects.toThrow('E_OP_FAILED')
  })

  it('包不存在时报 E_NOT_FOUND（不是笼统失败）', async () => {
    const { service } = harness(() => ({ code: 0, stdout: 'Failure [not installed for 0]', stderr: '' }))
    await expect(service.uninstall('S1', 'com.a')).rejects.toThrow('E_NOT_FOUND')
  })
})

describe('强停与启动', () => {
  it('强停发 am force-stop', async () => {
    const { service, client } = harness(() => ({ code: 0, stdout: '', stderr: '' }))
    await service.forceStop('S1', 'com.a')
    expect(client.args()[0]).toContain('am force-stop com.a')
  })

  it('启动成功看 Events injected（退出码 0 但没注入 = 没有可启动的入口）', async () => {
    const { service } = harness(() => ({ code: 0, stdout: 'Events injected: 1', stderr: '' }))
    await service.launch('S1', 'com.a')
  })

  it('没有 LAUNCHER 入口时报 E_NOT_FOUND（不能当成启动成功）', async () => {
    const { service } = harness(() => ({ code: 0, stdout: 'No activities found to run, monkey aborted.', stderr: '' }))
    await expect(service.launch('S1', 'com.a')).rejects.toThrow('E_NOT_FOUND')
  })
})

describe('安装本地 APK', () => {
  it('apk 不存在时在发命令之前失败', async () => {
    const { service, client } = harness(() => ({ code: 0, stdout: 'Success', stderr: '' }))
    await expect(service.installApk('S1', path.join(LOCAL_DIR, 'missing.apk'))).rejects.toThrow('E_NOT_FOUND')
    expect(client.calls).toHaveLength(0)
  })

  /*
   * 这两条守的是「安装进度必须是真的」这条底线：
   * adb install 全程只输出一行 Success，拿不到任何中间态；
   * 所以我们拆成 push + pm install —— 顺序错了（先装后推）功能就彻底不成立。
   */
  it('成功路径是 push → pm install → 清理临时文件（顺序固定）', async () => {
    const apk = path.join(LOCAL_DIR, 'app.apk')
    writeFileSync(apk, 'x')
    const { service, client } = harness(() => ({ code: 0, stdout: 'Success', stderr: '' }))
    await service.installApk('S1', apk)
    /*
     * 只挑出「有实质动作」的三条命令：push 阶段会并发轮询 stat -c %s
     * （进度就是这样算出来的），那些轮询不能参与顺序断言 —— 它们是副作用，
     * 不是流程的一环。
     */
    const all = client.args().filter((c) => !c.includes('stat -c %s'))
    expect(all[0]).toContain('push')
    expect(all[1]).toContain('pm install -r')
    // 第三条是 finally 里的 rm：不留 150MB 垃圾在 /data/local/tmp
    expect(all[2]).toContain('rm -f')
  })

  it('push 失败时不发 pm install（文件都没到设备上）', async () => {
    const apk = path.join(LOCAL_DIR, 'nopush.apk')
    writeFileSync(apk, 'x')
    const { service, client } = harness((args) =>
      args[0] === 'push'
        ? { code: 1, stdout: '', stderr: 'adb: error: failed to copy' }
        : { code: 0, stdout: 'Success', stderr: '' },
    )
    await expect(service.installApk('S1', apk)).rejects.toThrow()
    expect(client.args().some((c) => c.includes('pm install'))).toBe(false)
  })

  it('pm install 的 Failure 必须当成失败（哪怕退出码是 0）', async () => {
    const apk = path.join(LOCAL_DIR, 'bad.apk')
    writeFileSync(apk, 'x')
    const { service } = harness((args) =>
      args[0] === 'push'
        ? { code: 0, stdout: '', stderr: '' }
        : { code: 0, stdout: 'Failure [INSTALL_FAILED_INVALID_APK]', stderr: '' },
    )
    await expect(service.installApk('S1', apk)).rejects.toThrow()
  })

  it('进度依次报 preparing → pushing → installing → done，并最终到 100%', async () => {
    const apk = path.join(LOCAL_DIR, 'prog.apk')
    writeFileSync(apk, Buffer.alloc(1000, 1))
    const { service } = harness(() => ({ code: 0, stdout: 'Success', stderr: '' }))
    const seen: string[] = []
    await service.installApk('S1', apk, (p) => { seen.push(p.phase) })
    expect(seen[0]).toBe('preparing')
    expect(seen).toContain('pushing')
    expect(seen).toContain('installing')
    expect(seen[seen.length - 1]).toBe('done')
  })

  it('推送失败也要清理临时文件（finally，不是成功路径专属）', async () => {
    const apk = path.join(LOCAL_DIR, 'cleanup.apk')
    writeFileSync(apk, 'x')
    const { service, client } = harness((args) =>
      args[0] === 'push' ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: '', stderr: '' },
    )
    await expect(service.installApk('S1', apk)).rejects.toThrow()
    // push 失败时 pushed 标志为 false，rm 不该发 —— 设备上本来就没这个文件
    expect(client.args().some((c) => c.includes('rm -f'))).toBe(false)
  })
})
