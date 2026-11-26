import { describe, it, expect, beforeEach } from 'vitest'
import {
  useLogStore,
  logAppAction,
  logApkPulled,
  logApkInstalled,
  logAppFailed,
} from '../src/store/logStore'
import { useDeviceStore } from '../src/store/deviceStore'
import { t, tf } from '../src/shared/i18n'

/*
 * 日志的内容门禁（不是渲染，是「这行字到底说了什么」）。
 *
 * 上一版的日志只有「开始安装 APK」「已卸载」这种半句话：
 *   - 不知道是哪台设备（两台同型号设备没法区分）；
 *   - 不知道是哪个文件 / 哪个包（连着操作两个就全对不上）。
 * 用户的原话就是「安装 xxx.apk，已卸载 xxx」—— 所以这里逐条钉住：
 * **每条日志都必须同时说清设备与对象**。
 */

function reset(): void {
  useLogStore.getState().clear()
  useDeviceStore.setState({
    devices: [{ serial: '9N9CN2G0012A3P', status: 'device', transport: 'usb', model: 'DJI RC Plus 2' } as never],
    activeSerial: '9N9CN2G0012A3P',
    loaded: true,
  })
}

describe('日志内容必须说清设备与对象', () => {
  beforeEach(reset)

  it('卸载：同时出现设备型号与包名', () => {
    logAppAction('uninstalled', '9N9CN2G0012A3P', 'com.tjh.uav.normal')
    const text = useLogStore.getState().entries[0]?.text ?? ''
    expect(text).toContain('DJI RC Plus 2')
    expect(text).toContain('com.tjh.uav.normal')
    expect(text).toContain('卸载')
  })

  it('清数据 / 启动 / 强停 各自有自己的动词（不能都写「操作成功」）', () => {
    logAppAction('cleared', '9N9CN2G0012A3P', 'com.a')
    logAppAction('launched', '9N9CN2G0012A3P', 'com.a')
    logAppAction('forceStopped', '9N9CN2G0012A3P', 'com.a')
    const texts = useLogStore.getState().entries.map((e) => e.text)
    expect(texts[0]).not.toBe(texts[1])
    expect(texts[1]).not.toBe(texts[2])
    for (const text of texts) expect(text).toContain('com.a')
  })

  it('拉 APK：带包名和个数', () => {
    logApkPulled('9N9CN2G0012A3P', 'com.dji.sampleV5.aircraft', 2)
    const text = useLogStore.getState().entries[0]?.text ?? ''
    expect(text).toContain('com.dji.sampleV5.aircraft')
    expect(text).toContain('2')
  })

  it('安装：写出 .apk 文件名（用户拿手里的文件能对上）', () => {
    logApkInstalled('9N9CN2G0012A3P', 'C:/Users/Administrator/AppData/Local/Temp/a/doubao.apk')
    const text = useLogStore.getState().entries[0]?.text ?? ''
    expect(text).toContain('doubao.apk')
    expect(text).toContain('DJI RC Plus 2')
    // 只留文件名：完整临时路径对用户没有任何意义
    expect(text).not.toContain('AppData')
  })

  it('失败走 error 级别并给出人话原因（不是错误码）', () => {
    logAppFailed('9N9CN2G0012A3P', 'E_NO_PERMISSION')
    const entry = useLogStore.getState().entries[0]
    expect(entry?.level).toBe('error')
    expect(entry?.text).not.toContain('E_NO_PERMISSION')
    expect(entry?.text).toContain('DJI RC Plus 2')
  })

  it('设备掉线后仍能查到型号（掉线不等于记录消失）', () => {
    useDeviceStore.setState({
      devices: [{ serial: '9N9CN2G0012A3P', status: 'offline', transport: 'usb', model: 'DJI RC Plus 2' } as never],
    })
    logAppAction('launched', '9N9CN2G0012A3P', 'com.a')
    expect(useLogStore.getState().entries[0]?.text).toContain('DJI RC Plus 2')
  })

  it('未知设备只用尾巴，且不渲染出空型号段', () => {
    logAppAction('launched', 'UNKNOWN0009ZZZZ', 'com.a')
    const text = useLogStore.getState().entries[0]?.text ?? ''
    expect(text).toContain('ZZZZ')
    expect(text).not.toContain('·')
  })

  it('文案模板本身带 {device}，改文案时不会把设备段弄丢', () => {
    expect(t('log.app.uninstalled')).toContain('{device}')
    expect(t('log.app.uninstalled')).toContain('{pkg}')
    expect(t('log.install.preparing')).toContain('{apk}')
    expect(tf('log.app.uninstalled', { device: 'D', pkg: 'P' })).toContain('D')
  })
})