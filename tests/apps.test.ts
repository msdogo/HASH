import { describe, it, expect } from 'vitest'
import {
  classifyAppFailure,
  clearDataCommand,
  dumpsysPackageCommand,
  forceStopCommand,
  isSafePackageName,
  launchCommand,
  listAppsCommand,
  needsConfirm,
  parseDumpsysPackage,
  parseDumpsysTime,
  parsePackageList,
  parsePmPath,
  installPercent,
  installPhaseKey,
  installProgressChanged,
  installTempPath,
  parsePmResult,
  parseRemoteFileSize,
  pmPathCommand,
  uninstallCommand,
  versionLabel,
} from '../src/shared/apps'

/*
 * 应用管理的解析器（P1 第二批）。
 *
 * 下面的样本**逐字来自真机**（DJI RC Plus 2 / Android 11 / SDK 30），
 * 不是编的格式。厂商 ROM 的差异正是这一层最该被 fixture 钉住的地方：
 * 解析错了的后果是「用户看到错误的版本号」或「卸载了错的应用」。
 */

/** 真机：pm list packages -3 --show-versioncode */
const LIST_SAMPLE = [
  'package:com.tjh.uav.normal.test versionCode:0',
  'package:com.dji.open.pilot.plugin versionCode:1',
  'package:com.tjh.uav.normal versionCode:35',
  'package:com.dji.sampleV5.aircraft versionCode:1',
  'package:org.nobody.multitts versionCode:82',
  'package:com.bytedance.android.doubaoime versionCode:100501006',
].join('\r\n')

/** 真机：dumpsys package com.tjh.uav.normal 的关键行 */
const DUMPSYS_SAMPLE = [
  'Packages:',
  '  Package [com.tjh.uav.normal] (a1b2c3d):',
  '    pkg=Package{daa6f7a com.tjh.uav.normal}',
  '    codePath=/data/app/~~l7hG2BDeIUZDJLszAq0H8Q==/com.tjh.uav.normal-_T4DMCDvQ0zEErE9vwHFQQ==',
  '    versionCode=35 minSdk=24 targetSdk=34',
  '    versionName=2.1.2.beta3',
  '    flags=[ DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA TEST_ONLY ALLOW_BACKUP LARGE_HEAP ]',
  '    firstInstallTime=2026-11-06 11:47:27',
  '    lastUpdateTime=2026-11-24 16:00:58',
].join('\r\n')

describe('解析 pm list packages', () => {
  it('带 versionCode 与不带 versionCode 两种形态都能认', () => {
    const entries = parsePackageList(LIST_SAMPLE)
    expect(entries).toHaveLength(6)
    expect(entries[0]).toEqual({ packageName: 'com.tjh.uav.normal.test', versionCode: 0 })
    expect(entries[2]).toEqual({ packageName: 'com.tjh.uav.normal', versionCode: 35 })
  })

  it('versionCode:0 保留为 0（真机上确实存在，不能当成缺失）', () => {
    const entry = parsePackageList('package:com.x versionCode:0')[0]
    expect(entry?.versionCode).toBe(0)
  })

  it('没有 versionCode 字段时按 0 处理（不是 NaN、不是跳过这一行）', () => {
    const entries = parsePackageList('package:com.plain')
    expect(entries).toEqual([{ packageName: 'com.plain', versionCode: 0 }])
  })

  it('认不出的行被跳过，其余照常返回（一行怪格式不该让整批消失）', () => {
    const text = ['garbage line', 'package:com.ok versionCode:3', '', 'random'].join('\n')
    expect(parsePackageList(text)).toEqual([{ packageName: 'com.ok', versionCode: 3 }])
  })

  it('重复的包只保留第一次出现（不静默改顺序）', () => {
    const text = ['package:com.a versionCode:1', 'package:com.b versionCode:2', 'package:com.a versionCode:9'].join('\n')
    const entries = parsePackageList(text)
    expect(entries.map((e) => e.packageName)).toEqual(['com.a', 'com.b'])
    expect(entries[0].versionCode).toBe(1)
  })

  it('空输入返回空数组（不是抛错）', () => {
    expect(parsePackageList('')).toEqual([])
    expect(parsePackageList('\r\n\r\n')).toEqual([])
  })
})

describe('解析 dumpsys package', () => {
  it('从真机样本里取出全部字段', () => {
    const detail = parseDumpsysPackage(DUMPSYS_SAMPLE, 'com.tjh.uav.normal')
    expect(detail.versionName).toBe('2.1.2.beta3')
    expect(detail.versionCode).toBe(35)
    expect(detail.allowClearData).toBe(true)
    expect(detail.firstInstallMs).toBe(new Date(2026, 10, 6, 11, 47, 27).getTime())
    expect(detail.lastUpdateMs).toBe(new Date(2026, 10, 24, 16, 0, 58).getTime())
  })

  it('versionCode 与 minSdk 同行时只取 versionCode（不能整行 parse）', () => {
    const detail = parseDumpsysPackage('    versionCode=35 minSdk=24 targetSdk=34', 'com.x')
    expect(detail.versionCode).toBe(35)
  })

  it('字段缺失时全部返回 undefined，绝不编造默认值', () => {
    const detail = parseDumpsysPackage('Packages:\r\n  nothing useful', 'com.x')
    expect(detail.versionName).toBeUndefined()
    expect(detail.versionCode).toBeUndefined()
    expect(detail.firstInstallMs).toBeUndefined()
    expect(detail.lastUpdateMs).toBeUndefined()
    // 没有 flags 行 = 不知道能不能清数据，按 false 处理（保守）
    expect(detail.allowClearData).toBe(false)
  })

  it('flags 里没有 ALLOW_CLEAR_USER_DATA 时为 false（系统应用通常是这种）', () => {
    const detail = parseDumpsysPackage('    flags=[ SYSTEM HAS_CODE ]', 'com.system')
    expect(detail.allowClearData).toBe(false)
  })
})

describe('解析时间', () => {
  it('按本地时间解析（dumpsys 给的就是设备本地时间）', () => {
    expect(parseDumpsysTime('2026-11-06 11:47:27')).toBe(new Date(2026, 10, 6, 11, 47, 27).getTime())
  })

  it('解析不出返回 undefined（不用 0 或当前时间兜底）', () => {
    expect(parseDumpsysTime(undefined)).toBeUndefined()
    expect(parseDumpsysTime('')).toBeUndefined()
    expect(parseDumpsysTime('not a time')).toBeUndefined()
  })
})

describe('解析 pm path', () => {
  it('单 apk', () => {
    expect(parsePmPath('package:/data/app/~~x==/base.apk')).toEqual(['/data/app/~~x==/base.apk'])
  })

  it('split apk 返回全部（一条 app 可以有多个 base/split）', () => {
    const text = ['package:/data/app/x/base.apk', 'package:/data/app/x/split_config.arm64.apk'].join('\r\n')
    expect(parsePmPath(text)).toHaveLength(2)
  })

  it('非 package: 行被忽略；空输入返回空数组', () => {
    expect(parsePmPath('garbage\r\npackage:/a.apk')).toEqual(['/a.apk'])
    expect(parsePmPath('')).toEqual([])
  })
})

describe('命令构造', () => {
  it('每条命令都用最保守的形式', () => {
    expect(listAppsCommand()).toBe('pm list packages -3 --show-versioncode')
    expect(dumpsysPackageCommand('com.a')).toBe('dumpsys package com.a')
    expect(pmPathCommand('com.a')).toBe('pm path com.a')
    expect(forceStopCommand('com.a')).toBe('am force-stop com.a')
    expect(uninstallCommand('com.a')).toBe('pm uninstall com.a')
    expect(clearDataCommand('com.a')).toBe('pm clear com.a')
    expect(launchCommand('com.a')).toContain('monkey -p com.a')
  })

  it('包名闸门只放行合法包名（防止畸形 ROM 输出拼出怪命令）', () => {
    expect(isSafePackageName('com.tjh.uav.normal')).toBe(true)
    expect(isSafePackageName('com.a')).toBe(true)
    expect(isSafePackageName('singleword')).toBe(false)
    expect(isSafePackageName('com.a; rm -rf /sdcard')).toBe(false)
    expect(isSafePackageName('com.a && echo hi')).toBe(false)
    expect(isSafePackageName('')).toBe(false)
    expect(isSafePackageName('com..a')).toBe(false)
  })
})

describe('结果判定', () => {
  it('Success 判成功', () => {
    expect(parsePmResult('Success').ok).toBe(true)
    expect(parsePmResult('Success\r\n').ok).toBe(true)
  })

  it('Failure [...] 判失败并取出原因', () => {
    const r = parsePmResult('Failure [DELETE_FAILED_INTERNAL_ERROR]')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('DELETE_FAILED_INTERNAL_ERROR')
  })

  it('既没有 Success 也没有 Failure 时判失败（不知道 != 成功）', () => {
    expect(parsePmResult('').ok).toBe(false)
    expect(parsePmResult('something unexpected').ok).toBe(false)
  })

  it('失败原因翻成错误码，认不出归 E_SYNC_FAILED', () => {
    expect(classifyAppFailure('DELETE_FAILED_INTERNAL_ERROR', 0)).toBe('E_OP_FAILED')
    expect(classifyAppFailure('PERMISSION_DENIED', 0)).toBe('E_NO_PERMISSION')
    expect(classifyAppFailure('not installed for 0', 0)).toBe('E_NOT_FOUND')
    expect(classifyAppFailure('something weird', 0)).toBe('E_SYNC_FAILED')
    expect(classifyAppFailure(undefined, null)).toBe('E_TIMEOUT')
  })
})

describe('危险动作与展示', () => {
  it('只有卸载与清数据需要二次确认', () => {
    expect(needsConfirm('uninstall')).toBe(true)
    expect(needsConfirm('clearData')).toBe(true)
    expect(needsConfirm('forceStop')).toBe(false)
    expect(needsConfirm('launch')).toBe(false)
    expect(needsConfirm('pullApk')).toBe(false)
    expect(needsConfirm('installApk')).toBe(false)
  })

  it('设备上文件还没出现时，stat 的报错不能当成 0 字节（否则进度条会回跳）', () => {
    expect(parseRemoteFileSize("stat: '/data/local/tmp/x.apk': No such file or directory")).toBeUndefined()
    expect(parseRemoteFileSize('')).toBeUndefined()
    expect(parseRemoteFileSize('12345\n')).toBe(12345)
    expect(parseRemoteFileSize('  2048  ')).toBe(2048)
  })

  it('百分比按阶段算：done=100，installing 固定 90，推送按字节比例', () => {
    expect(installPercent('done', 100, 100)).toBe(100)
    expect(installPercent('installing', 100, 100)).toBe(90)
    expect(installPercent('preparing', 0, 100)).toBe(0)
    expect(installPercent('pushing', 50, 100)).toBe(45)
    // 拿不到总大小时不假造中间值：0 比乱跳更诚实
    expect(installPercent('pushing', 50, 0)).toBe(0)
  })

  it('推送字节超过总量时百分比封顶 90（不溢出到 100 抢 done 的值）', () => {
    expect(installPercent('pushing', 200, 100)).toBe(90)
  })

  it('临时 apk 路径带序列号，两台设备并发装包不互相覆盖', () => {
    const a = installTempPath(1, 'S1')
    const b = installTempPath(1, 'S2')
    expect(a).not.toBe(b)
    expect(a.startsWith('/data/local/tmp/')).toBe(true)
    expect(a.endsWith('.apk')).toBe(true)
  })

  it('只有阶段或百分比变了才值得推一次（避免每 300ms 重渲染）', () => {
    const base = { serial: 'S1', phase: 'pushing' as const, apkName: 'a.apk', doneBytes: 1, totalBytes: 10, percent: 9 }
    expect(installProgressChanged(null, base)).toBe(true)
    expect(installProgressChanged(base, { ...base, doneBytes: 2 })).toBe(false)
    expect(installProgressChanged(base, { ...base, percent: 18 })).toBe(true)
    expect(installProgressChanged(base, { ...base, phase: 'installing' })).toBe(true)
  })

  it('阶段文案 key 覆盖四个阶段（状态必须能一眼看出来，不能只给百分比）', () => {
    for (const phase of ['preparing', 'pushing', 'installing', 'done'] as const) {
      expect(installPhaseKey(phase)).toBe('apps.phase.' + phase)
    }
  })

  it('版本列优先显示版本名，其次 versionCode，都没有显示 —', () => {
    const base = { packageName: 'com.a', versionCode: 1, firstInstallMs: undefined, lastUpdateMs: undefined, allowClearData: true }
    expect(versionLabel({ ...base, versionName: '2.1.2' })).toBe('2.1.2')
    expect(versionLabel({ ...base, versionName: undefined })).toBe('1')
    expect(versionLabel({ ...base, versionName: undefined, versionCode: undefined })).toBe('—')
    expect(versionLabel(undefined)).toBe('—')
  })
})
