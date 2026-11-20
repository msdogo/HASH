import { describe, it, expect, vi } from 'vitest'
import { makeDownloadHandler, runDownload } from '../src/shared/download-flow'
import { EMPTY_OP_STATE, canConfirm, opReducer, type OpAction, type OpState } from '../src/shared/op-view'
import { E_DEVICE_OFFLINE, E_PROTECTED_PATH } from '../src/shared/errors'
import { errorText, t } from '../src/shared/i18n'

/*
 * 【第 2 轮复审 N1】下载流程的 busy 复位。
 *
 * 修前这段逻辑整个写在 src/store/opStore.ts 里，零测试覆盖 ——
 * 于是「成功路径忘记复位 busy」一路滑到复审：下载成功后 busy 永久为 true，
 * 而 op-view 的 openConfirm 在 busy 时直接丢弃 action（op-view.ts:96），
 * 删除/复制/移动/重命名/新建**全部点不动**，只有重启应用才恢复。
 * 复审实测 BUSY_AFTER_SUCCESS_DOWNLOAD=true。
 *
 * 这里的断言刻意落在**行为**上而不是「有没有调 setBusy」：
 * 用一个真的状态机（opReducer）接住 dispatch，跑完下载后再问
 * 「现在能不能打开删除确认框」—— 那才是用户感知到的东西。
 */

type EnqueueResult = { ok: true; data: unknown } | { ok: false; error: string }
type EnqueueArg = { serial: string; direction: string; src: string; dstDir: string }

/** 造一个「真状态机 + 假 IPC」的被测对象。 */
function harness(enqueue: (arg: EnqueueArg) => Promise<EnqueueResult>) {
  let state: OpState = { ...EMPTY_OP_STATE }
  const dispatch = (action: OpAction): void => {
    state = opReducer(state, action)
  }
  return {
    deps: { enqueue, dispatch },
    get state(): OpState { return state },
  }
}

const SERIAL = 'TESTSERIAL'
const LOCAL_DIR = 'C:/Users/me/Downloads'
const okResult = async (): Promise<EnqueueResult> => ({ ok: true, data: {} })

describe('第 2 轮复审 N1：下载结束后 busy 必须复位', () => {
  it('下载成功后 busy 复位，且随后能打开删除确认框（修前这里是死的）', async () => {
    const enqueue = vi.fn(okResult)
    const h = harness(enqueue)

    const code = await runDownload(h.deps, SERIAL, ['/sdcard/a.txt'], LOCAL_DIR)
    expect(code).toBeNull()
    expect(enqueue).toHaveBeenCalledTimes(1)

    // 关键断言 1：busy 必须为 false（修前是 true，后续所有操作被静默丢弃）
    expect(h.state.busy).toBe(false)
    // 关键断言 2：成功不弹「N 项全部成功」的噪音框（界面已有「已加入下载队列」提示）
    expect(h.state.lastSummary).toBeNull()

    // 关键断言 3：真正有意义的那个 —— 用户接下来还能不能继续操作
    const after = opReducer(h.state, {
      type: 'openConfirm',
      kind: 'delete',
      targets: ['/sdcard/a.txt'],
      facts: { count: 1, names: ['a.txt'], truncated: false, hasNonEmptyDir: false, blocked: [] },
    })
    expect(after.dialog?.kind).toBe('delete')
    expect(canConfirm(after)).toBe(true)
  })

  it('下载途中抛异常时 busy 也必须复位（异常路径不能漏）', async () => {
    const h = harness(async () => {
      throw new Error('IPC 断了')
    })

    const code = await runDownload(h.deps, SERIAL, ['/sdcard/a.txt'], LOCAL_DIR)
    expect(h.state.busy).toBe(false)
    expect(code).not.toBeNull()
    // 失败要有交代：弹结果框，且框里能看到那一项失败
    expect(h.state.lastSummary?.failed).toBe(1)
  })

  it('下载失败后 busy 复位，且仍能继续操作', async () => {
    const h = harness(async () => ({ ok: false, error: E_DEVICE_OFFLINE }))

    const code = await runDownload(h.deps, SERIAL, ['/sdcard/a.txt'], LOCAL_DIR)
    expect(code).toBe(E_DEVICE_OFFLINE)
    expect(h.state.busy).toBe(false)
    expect(h.state.lastSummary?.failures[0]?.code).toBe(E_DEVICE_OFFLINE)

    const after = opReducer(h.state, { type: 'openConfirm', kind: 'newFolder', targets: [] })
    expect(after.dialog?.kind).toBe('newFolder')
  })

  it('逐项收集：一项失败不影响后续项入队（复审 M4 的行为，顺带压住）', async () => {
    const seen: string[] = []
    const h = harness(async (arg) => {
      seen.push(arg.src)
      return arg.src === '/sdcard/bad.txt'
        ? { ok: false, error: E_DEVICE_OFFLINE }
        : { ok: true, data: {} }
    })

    const code = await runDownload(
      h.deps,
      SERIAL,
      ['/sdcard/ok1.txt', '/sdcard/bad.txt', '/sdcard/ok2.txt'],
      LOCAL_DIR,
    )
    // 三项都要被试过（修前第一项失败就 return，后两项根本不会入队）
    expect(seen).toEqual(['/sdcard/ok1.txt', '/sdcard/bad.txt', '/sdcard/ok2.txt'])
    // 返回值仍是首个失败码，调用点（FilesPage）不用改
    expect(code).toBe(E_DEVICE_OFFLINE)
    expect(h.state.lastSummary?.ok).toBe(2)
    expect(h.state.lastSummary?.failed).toBe(1)
    expect(h.state.busy).toBe(false)
  })

  it('全部成功时返回 null（调用点据此不弹错误提示）', async () => {
    const h = harness(okResult)
    const code = await runDownload(h.deps, SERIAL, ['/sdcard/a.txt', '/sdcard/b.txt'], LOCAL_DIR)
    expect(code).toBeNull()
    expect(h.state.lastSummary).toBeNull()
    expect(h.state.busy).toBe(false)
  })

  it('空的下载清单：不会把 busy 卡在 true', async () => {
    const enqueue = vi.fn(okResult)
    const h = harness(enqueue)

    const code = await runDownload(h.deps, SERIAL, [], LOCAL_DIR)
    expect(code).toBeNull()
    expect(enqueue).not.toHaveBeenCalled()
    expect(h.state.busy).toBe(false)
  })

  it('入参逐项透传（serial / direction / dstDir 不能被改写）', async () => {
    const seen: EnqueueArg[] = []
    const h = harness(async (arg) => { seen.push(arg); return { ok: true, data: {} } })
    await runDownload(h.deps, SERIAL, ['/sdcard/a.txt'], LOCAL_DIR)
    expect(seen).toEqual([
      { serial: SERIAL, direction: 'pull', src: '/sdcard/a.txt', dstDir: LOCAL_DIR },
    ])
  })

  it('中途失败也保留已成功的项（用户要知道哪几个已经进了队列）', async () => {
    const h = harness(async (arg) => arg.src === '/sdcard/2.txt'
      ? { ok: false, error: E_PROTECTED_PATH }
      : { ok: true, data: {} })
    await runDownload(h.deps, SERIAL, ['/sdcard/1.txt', '/sdcard/2.txt', '/sdcard/3.txt'], LOCAL_DIR)
    const summary = h.state.lastSummary
    expect(summary?.ok).toBe(2)
    expect(summary?.total).toBe(3)
    // 【R2-1】样例错误码从 E_OUTSIDE_ROOT（已删除）换成仍然存在的 E_PROTECTED_PATH：
    // 本用例测的是「失败项逐个透传」，不是越界拦截。
    expect(summary?.failures.map((item) => item.code)).toEqual([E_PROTECTED_PATH])
  })
})

/*
 * 【终审 I-2 / 第 10 次假护栏】「文件页有下载入口」曾经是纯源码文本断言：
 *   expect(page).toContain('onDownload=')
 *   expect(page).toContain('download(')
 * 后者连函数定义（const handleDownload = …）都能满足。终审实测：把 FilesPage 的
 * onDownload 接到空操作后，按钮照样渲染、照样可点，点击毫无反应，
 * 而全量 1164 passed、tsc exit 0 —— 正是任务 9 裁决 7 明令禁止的「有队列没界面」。
 *
 * 现在这段判断在 shared/download-flow.ts 的 makeDownloadHandler 里（组件只做注入），
 * 断言的是**行为**：有没有真的调到下载入口、带的是什么参数、提示说了什么。
 */
describe('终审 I-2：下载入口的接线（makeDownloadHandler）', () => {
  type RunArg = { serial: string; sources: string[]; localDir: string }

  function harness(over: Partial<{
    serial: string | null
    targets: string[]
    /** false 表示本地面板还没选目录（localDir() 返回 undefined）。 */
    hasLocalDir: boolean
    result: string | null
  }> = {}) {
    const calls: RunArg[] = []
    const notices: Array<string | null> = []
    const handler = makeDownloadHandler({
      serial: over.serial === undefined ? SERIAL : over.serial,
      run: async (serial, sources, localDir) => {
        calls.push({ serial, sources, localDir })
        return over.result ?? null
      },
      selectedTargets: () => over.targets ?? ['/sdcard/a.txt', '/sdcard/b.txt'],
      localDir: () => (over.hasLocalDir === false ? undefined : LOCAL_DIR),
      notify: (text) => { notices.push(text) },
    })
    return { handler, calls, notices }
  }

  it('调 run 时 serial / sources / localDir 逐字节正确', async () => {
    const h = harness()
    const code = await h.handler()
    expect(code).toBeNull()
    expect(h.calls).toEqual([
      { serial: SERIAL, sources: ['/sdcard/a.txt', '/sdcard/b.txt'], localDir: LOCAL_DIR },
    ])
    expect(h.notices).toEqual([t('op.downloaded')])
  })

  it('没有选中项时**不调用** run，并提示先选中', async () => {
    const h = harness({ targets: [] })
    await h.handler()
    expect(h.calls).toEqual([])
    expect(h.notices).toEqual([t('op.noSelection')])
  })

  it('本地还没选目录时**不调用** run，并提示选目录', async () => {
    const h = harness({ hasLocalDir: false })
    await h.handler()
    expect(h.calls).toEqual([])
    expect(h.notices).toEqual([t('op.needLocalDir')])
  })

  it('没有设备时什么都不做（不调用、不提示）', async () => {
    const h = harness({ serial: null })
    await h.handler()
    expect(h.calls).toEqual([])
    expect(h.notices).toEqual([])
  })

  it('失败时把错误码翻成中文提示并返回该码（调用点据此提示）', async () => {
    const h = harness({ result: E_DEVICE_OFFLINE })
    const code = await h.handler()
    expect(code).toBe(E_DEVICE_OFFLINE)
    expect(h.calls).toHaveLength(1)
    expect(h.notices).toEqual([errorText(E_DEVICE_OFFLINE)])
    // 用户看到的必须是文案而不是裸错误码
    expect(h.notices[0]).not.toBe(E_DEVICE_OFFLINE)
  })
})
