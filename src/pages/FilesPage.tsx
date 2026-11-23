import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Eye, EyeOff, Info, RefreshCw, X, AlertTriangle as Warn } from 'lucide-react'
import type { FileEntry } from '@shared/types'
import {
  emptyReason,
  isHiddenName,
  keyToSelectionAction,
  makeSelectAllHandler,
  navKeyCommand,
  openTarget,
  searchSummary,
  summarizeEntries,
  viewFromPartial,
  visibleEntries,
  type SelectMode,
} from '@shared/file-view'
import { errorText, t, tf } from '@shared/i18n'
import { createCwdMemo, createCwdRestore, openedAt } from '@shared/cwd-memo'
import { makeDownloadHandler } from '@shared/download-flow'
import { downloadDirForDownload } from '@shared/settings'
import { dragOutTargets, dropNotice, enqueueDroppedFiles, prepareDropTarget, readDroppedFiles } from '@shared/drag'
import { createTerminalRefreshWatcher, type RefreshContext } from '@shared/upload-refresh'
import {
  contextSelectionFor,
  menuItemsFor,
  selectedCountAfterContext,
  type MenuActionId,
} from '@shared/context-menu'
import { Breadcrumb } from '@/components/Breadcrumb'
import { ContextMenu } from '@/components/ContextMenu'
import { FileTable } from '@/components/FileTable'
import { FileToolbar } from '@/components/FileToolbar'
import { OpDialogHost } from '@/components/OpDialog'
import { useDeviceStore } from '@/store/deviceStore'
import { useFileStore } from '@/store/fileStore'
import { useOpStore } from '@/store/opStore'
import { useSettingsStore } from '@/store/settingsStore'
import { useTransferStore } from '@/store/transferStore'
import { useDragStore } from '@/store/dragStore'
import { joinEntryPath } from '@shared/file-view'

/**
 * 文件页（任务 7）。
 *
 * 数据流：deviceStore 给 serial → fileStore 按 serial 取分片 → 主进程 fs:list → 模型落地。
 * 组件只做三件事：把事件转成 action、把状态转成 DOM、把排序/过滤包进 useMemo（裁决 4）。
 *
 * 每台设备的状态（cwd / 条目 / 排序 / 隐藏开关 / 选中 / 滚动位置）都存在各自的 store 分片里，
 * 所以 A 机停在 /sdcard/DCIM、B 机停在 /sdcard/Download，切回来各自恢复（裁决 7）。
 */
export function FilesPage() {
  const serial = useDeviceStore((state) => state.activeSerial)
  const devices = useDeviceStore((state) => state.devices)
  /*
   * 只订阅「影响渲染」的字段，**不订阅 scrollTop / generation**（裁决 4 + 审查轮 1 的收窄要求）。
   *
   * 为什么必须这样：滚动时每帧都会 dispatch 一次 setScrollTop。若直接订阅整个 view 分片，
   * 每帧都会让整个文件页重渲染（万级目录下就是滚动掉帧的主因）。用 useShallow 做浅比较后，
   * scrollTop 变化不会引起重渲染；需要读它时（回填滚动位置）直接 getState() 现取。
   */
  const view = useFileStore(
    useShallow((state) =>
      serial === null
        ? null
        : {
            cwd: state.views[serial]?.cwd,
            sort: state.views[serial]?.sort,
            sortDir: state.views[serial]?.sortDir,
            showHidden: state.views[serial]?.showHidden,
            query: state.views[serial]?.query,
            entries: state.views[serial]?.entries,
            status: state.views[serial]?.status,
            error: state.views[serial]?.error,
            addressError: state.views[serial]?.addressError,
            notice: state.views[serial]?.notice,
            noticeDismissed: state.views[serial]?.noticeDismissed,
            tzOffsetMinutes: state.views[serial]?.tzOffsetMinutes,
            selected: state.views[serial]?.selected,
            loadedOnce: state.views[serial]?.loadedOnce,
          },
    ),
  )
  const ensure = useFileStore((state) => state.ensure)
  const dispatch = useFileStore((state) => state.dispatch)
  const openDir = useFileStore((state) => state.openDir)
  const refresh = useFileStore((state) => state.refresh)
  const syncDevices = useFileStore((state) => state.syncDevices)

  /*
   * 全选的唯一实现（R2-2）。
   *
   * 工具条按钮与 Ctrl+A 都调它 —— 两处各写一遍是这类功能最典型的漂移来源。
   * 逻辑本体在 @shared/file-view 的 makeSelectAllHandler（纯函数，有行为用例），
   * 这里只把 store 的 dispatch 注入进去。抽出去的理由见那个函数的注释：
   * 按钮 onClick 那一行在无 jsdom 的工程里观测不到，所以「取哪些名字 + 派发什么」
   * 这段必须能被直接测到。
   */
  const selectAll = useMemo(() => makeSelectAllHandler({ dispatch }), [dispatch])

  /*
   * 文件操作（任务 9）。
   *
   * 注意这里**只拿 action，不订阅 op 状态**：对话框的状态由 OpDialogHost 自己订阅，
   * 页面订阅它会让每次「busy 翻转」都重渲染整个文件列表（万级条目下是可见的卡顿）。
   */
  const openOp = useOpStore((state) => state.open)
  const prepareDelete = useOpStore((state) => state.prepareDelete)
  const download = useOpStore((state) => state.download)

  /*
   * 拖拽（简报 C）。
   *
   * 只订阅 preparing 与 notice 两个原始字段：它们变化频率极低
   * （一次拖拽几次），不会像进度那样把整页拖进重渲染地狱。
   */
  const dragPreparing = useDragStore((state) => state.preparing)
  const dragNotice = useDragStore((state) => state.notice)
  const dragOut = useDragStore((state) => state.dragOut)
  const dismissDragNotice = useDragStore((state) => state.dismissNotice)

  /*
   * 设置里的默认下载路径（R2-2 用户裁决）。
   *
   * 只订阅 data 这一个字段：它只在用户改设置时变化，不会像进度那样把整页拖进重渲染。
   * 下载目标**不再**取本地面板的 cwd —— 判定集中在 @shared/settings 的
   * downloadDirForDownload（有专门的优先级用例），组件只负责把结果注入下载流程。
   */
  const settingsData = useSettingsStore((state) => state.data)
  const loadSettings = useSettingsStore((state) => state.load)

  // 首次进入文件页时确保设置已加载：下载目标依赖它，没加载就会出现「没读到路径」的提示
  useEffect(() => { void loadSettings() }, [loadSettings])

  /** 上传/下载这类「队列类」操作的提示（走底栏，不走 op 结果条）。 */
  const [queueNotice, setQueueNotice] = useState<string | null>(null)

  /**
   * 右键菜单状态（R5 事项 2）：视口坐标 + 右键的那一行名字。
   *
   * 存 **entry 名字**而不是 FileEntry 对象：菜单动作全部复用既有的
   * handleRename / handleDelete / handleDownload，它们都从 store 现取选中项，
   * 所以这里只需要知道「弹在屏幕的哪儿」，不需要持有条目。
   * 持有对象反而会让刷新后的陈旧引用活在菜单里。
   */
  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(null)

  // 【I5/I6】把设备表的变化接到分片生命周期上：
  // 新设备建分片；消失的设备 forget（否则每台设备存一整份 entries，内存单调增长）。
  //
  // 【终审 I-3 / 第 11 次假护栏】这一行**调用点本身没有门禁**，如实声明（同 N10）：
  // 修前守它的是 expect(page).toContain('syncDevices(')（import 行就满足），终审实测把
  // 这条 useEffect 删掉后全量 1164 仍全绿。现在这条文本断言已删除，下游三层都有真实
  // 行为用例（tests/device-lifecycle.test.ts）：syncDevices 建分片 / manager 30 分钟 gc
  // 后分片 forget / 超上限时在线设备不被淘汰。但「组件里这行有没有被调用」在
  // environment: node、无 jsdom 的测试工程里观测不到 —— 与 N10 同类，靠 code review。
  const deviceSerials = useMemo(() => devices.map((device) => device.serial), [devices])
  useEffect(() => { syncDevices(deviceSerials) }, [deviceSerials, syncDevices])

  /*
   * R9：按设备记住「上次停留的目录」。
   *
   * 两个注入式流程（判断全在 @shared/cwd-memo，组件只接 window.api / store）：
   *   - restore：设备上线时把记忆的目录接回来；打不开就回退 /sdcard 并给中性提示；
   *   - memo：每次**成功**进入目录后写盘（裁决 A），fire-and-forget（不 await）。
   *
   * 为什么用 useMemo 而不是模块级单例：两个工厂都捕获了 window.api / dispatch，
   * 而 window.api 在测试里会被替换（与本项目 dragStore 踩过的坑同类）。
   */
  const cwdMemo = useMemo(
    () => createCwdMemo({
      write: (targetSerial, cwd) => window.api.settings.setDeviceCwd({ serial: targetSerial, cwd }),
    }),
    [],
  )

  const cwdRestore = useMemo(
    () => createCwdRestore({
      readStored: async (targetSerial) => {
        const result = await window.api.settings.getDeviceCwd({ serial: targetSerial })
        // 空串 = 没有记录（不是错误），其余错误同样降级成「没有记录」
        return result.ok && result.data !== '' ? result.data : undefined
      },
      seed: (targetSerial, cwd) => { dispatch(targetSerial, { type: 'seedCwd', cwd }) },
      openDir: async (targetSerial, dir) => {
        await openDir(targetSerial, dir)
        const state = useFileStore.getState().views[targetSerial]
        // 成败判定抽成纯函数 openedAt（表驱动用例）：openDir 只回 Promise<void>，
        // 真实结果落在分片上（loadedOnce / status / cwd 三者同时成立才算进去了）
        return openedAt(state, dir)
      },
      markFallback: (targetSerial) => { dispatch(targetSerial, { type: 'cwdFallback' }) },
      /*
       * 分片已经上过真实目录（切设备回来 / 掉线重连推送）：只刷新，不按记忆值跳转。
       * 记忆写盘也在那时更新过，这个值永远不比用户当前位置新。
       */
      isLoaded: (targetSerial) => useFileStore.getState().views[targetSerial]?.loadedOnce ?? false,
      reload: (targetSerial) => { void refresh(targetSerial) },
    }),
    [dispatch, openDir, refresh],
  )

  // 首次进入（设备切换）时建分片，并**经恢复流程**加载（记忆的目录 / 回退 / 提示都在里面）。
  // 同一目录的重复加载由协调器按 serial+dir 去重，StrictMode 双执行也不会发两次 adb 命令
  useEffect(() => {
    if (serial === null) return
    ensure(serial)
    void cwdRestore.restore(serial)
  }, [serial, ensure, cwdRestore])

  // 订阅到的是「字段不全」的对象（刻意不订阅 scrollTop），必须补齐。
  // 返回类型是 FileViewSlice：写 current.generation 会直接编译报错（审查轮 1 的提示项）
  const current = viewFromPartial(view ?? undefined)

  /*
   * R9 / 裁决 A：进入目录**成功后**立刻记下它（不防抖、不等退出）。
   *
   * 依赖里用 current.cwd 与 current.status：只有 ready 才是「真的进去了」
   * （C1：失败时 cwd 不前移，所以也不会把打不开的目录写进记忆）。
   *
   * 写盘是 fire-and-forget —— cwdMemo.remember 返回 void（没有可 await 的东西），
   * 失败只 warn。目录记忆是便利功能，它不该让浏览等一次 IPC。
   */
  useEffect(() => {
    if (serial === null) return
    if (current.status !== 'ready') return
    cwdMemo.remember(serial, current.cwd)
  }, [serial, current.status, current.cwd, cwdMemo])

  // 裁决 4：过滤 + 排序只在这里算一次，且依赖明确。
  // 绝不能放进渲染路径里每次重算 —— 万级条目下滚动会直接掉帧。
  const entries = useMemo(
    () =>
      visibleEntries(current.entries, {
        showHidden: current.showHidden,
        // R6：搜索是【当前目录内】的过滤，零 adb 调用 —— 只筛已加载的 entries
        query: current.query,
        sort: current.sort,
        sortDir: current.sortDir,
      }),
    [current.entries, current.showHidden, current.query, current.sort, current.sortDir],
  )

  // 空目录提示要区分「真的空」与「只有隐藏项」（隐藏项默认不显示，裁决 5）
  const hiddenFiltered = useMemo(
    () => !current.showHidden && current.entries.some((entry) => isHiddenName(entry.name)),
    [current.entries, current.showHidden],
  )

  const summary = useMemo(() => summarizeEntries(entries), [entries])

  /*
   * R6：搜索生效时，底栏的统计只数「过滤后」的条目（用户看到几行就统计几行）。
   * 旁挂一条「匹配 N / 共 M」，让用户知道是搜索筛掉的、不是文件丢了 ——
   * 2977 个 route-*.kmz 过滤成 12 个时，没有这句话就是一次「文件去哪了」的惊吓。
   */
  const matchLine = useMemo(
    () => searchSummary(current.entries, { showHidden: current.showHidden, query: current.query }),
    [current.entries, current.showHidden, current.query],
  )

  /*
   * R6：空列表要说清是哪一种「空」（加载中 / 出错 / 被搜掉 / 只有隐藏项 / 真空）。
   * 判定在 @shared/file-view 的 emptyReason（表驱动用例），组件只负责渲染。
   */
  const empty = emptyReason({
    status: current.status,
    total: current.entries.length,
    hiddenFiltered,
    query: current.query,
  })

  /*
   * 链接轨迹与跳数（防环，N2 / M1c）：**点击时直接从 store 现取**，不缓存、不订阅。
   *
   * 修前用了一个 useRef 缓存，依赖是 [serial, current.cwd] —— 而「跟随失败」不改变 cwd，
   * 于是 ref 与 store 长期分叉：store 里轨迹早就被回滚/丢弃了，ref 还抱着旧值做判环，
   * 把合法链接误拦成 E_LINK_CYCLE（复审真机复现的就是这个）。
   * 现在每次点击都读最新状态，从根上消除分叉；不订阅是有意的 ——
   * 它们不在渲染输出里，订阅只会让每次跟随多一次整页重渲染。
   */
  const readLinkState = useCallback(() => {
    const view = serial === null ? undefined : useFileStore.getState().views[serial]
    return { trail: view?.linkTrail ?? [], hops: view?.linkHops ?? 0 }
  }, [serial])

  const reportLinkError = useCallback(
    (code: string) => {
      if (serial === null) return
      // 【I4】链接进不去时给明确提示（走 i18n 错误文案），而不是静默无反应
      dispatch(serial, { type: 'addressError', code })
    },
    [serial, dispatch],
  )

  const handleOpen = useCallback(
    (entry: FileEntry) => {
      if (serial === null) return
      // 【I4】链接目录也要能进：目标解析、无法解析、成环三种情况都在 openTarget 里判（有单测）
      const { trail, hops } = readLinkState()
      const target = openTarget(entry, current.cwd, trail, hops)
      if (target.kind === 'enter') {
        // 【N2】跟随链接时把 linkTarget 传下去，reducer 才会真正写轨迹与跳数；
        // 普通目录不传（会重置轨迹），这样防环只在「连续跟随链接」的链上生效。
        //
        // 【M2】错误码由主进程给准（E_NOT_FOUND / E_NOT_A_DIRECTORY 已在 remote 的
        // classifyError 里按 stderr 区分），前端不再做任何「猜测式」改写。
        void openDir(serial, target.path, target.followedLink ? target.path : undefined)
        return
      }
      if (target.kind === 'error') {
        reportLinkError(target.code)
        return
      }
      // 普通文件：本任务不做打开（留给任务 9 的下载/预览）
    },
    [serial, openDir, current.cwd, readLinkState, reportLinkError, dispatch],
  )

  const handleSelect = useCallback(
    (entry: FileEntry, mode: SelectMode) => {
      if (serial === null) return
      dispatch(serial, { type: 'select', name: entry.name, mode })
    },
    [serial, dispatch],
  )

  const handleJump = useCallback(
    (path: string) => {
      if (serial === null) return
      // 【C1】openDir 只登记目标：失败时当前目录与列表原样保留，错误走行内提示
      void openDir(serial, path)
    },
    [serial, openDir],
  )

  // 回填滚动位置时现取 store 里的值：这个函数用作 getter，不参与渲染依赖（见上方注释）
  const getRestoreScrollTop = useCallback(
    () => (serial === null ? 0 : useFileStore.getState().views[serial]?.scrollTop ?? 0),
    [serial],
  )
  const onScrollTop = useCallback(
    (value: number) => {
      if (serial === null) return
      dispatch(serial, { type: 'setScrollTop', value })
    },
    [serial, dispatch],
  )

  /*
   * 【I7】键盘导航（规格 9.5：Enter 打开 / Backspace 上级 / F5 刷新）。
   *
   * 只在列表容器上监听：输入框（地址栏）里的按键不该被这里吞掉 ——
   * 事件从 input 冒泡上来时会先被 Browser 的默认行为处理，这里再用
   * tagName 判断排除，避免「在地址栏里按 Backspace 结果回上级目录」。
   */
  const onListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if (serial === null) return
      /*
       * 【多选增强 / 问题 2】selectAll 与 clear 是同一条 keydown 里的两个分支，
       * 与 Backspace / F5 共用一处键盘处理 —— 两套 keydown 早晚漂移（本项目已有先例）。
       * 判定在 keyToSelectionAction 里（纯函数，可单测；输入框保护也在那儿）。
       */
      const selection = keyToSelectionAction(event)
      if (selection.kind === 'selectAll') {
        event.preventDefault()
        /*
         * 与工具条「全选」按钮走**同一条**实现（makeSelectAllHandler）：
         * 全选的是【当前可见】条目（与表格同一个 entries，已过滤+排序）。
         * 两处各写一遍是这类功能最典型的漂移来源（隐藏项/排序变化后选到不同集合）。
         */
        selectAll(serial, entries)
        return
      }
      if (selection.kind === 'clear') {
        event.preventDefault()
        dispatch(serial, { type: 'clearSelection' })
        return
      }
      const command = navKeyCommand(event.key, current.cwd)
      if (command.kind === 'up') {
        event.preventDefault()
        handleJump(command.path)
        return
      }
      if (command.kind === 'refresh') {
        event.preventDefault()
        void refresh(serial)
      }
    },
    [serial, current.cwd, handleJump, refresh, dispatch, entries],
  )

  /*
   * 选中项对应的完整路径（文件操作都要绝对路径）。
   *
   * 从 store 现取当前 entries：visibleEntries 是「过滤+排序后」的展示数组，
   * 而 selected 里存的是名字 —— 两者按名字对齐即可，不必再订阅一份 entries。
   */
  const selectedTargets = useCallback((): string[] => {
    if (serial === null) return []
    const view = useFileStore.getState().views[serial]
    const names = view?.selected ?? []
    const base = view?.cwd ?? current.cwd
    return names.map((name) => joinEntryPath(base, name))
  }, [serial, current.cwd])

  /**
   * 下载到本地（裁决 7：任务 8 遗留 I4 的界面入口）。
   *
   * 走传输队列（transfer.enqueue）：**跨端**传输必须有进度与取消能力，
   * 那是队列的职责；而同一设备内的 cp/mv 才允许直接 shell（见 operations.ts）。
   */
  const handleDownload = useCallback(
    () =>
      makeDownloadHandler({
        serial,
        run: download,
        selectedTargets,
        /*
         * 【R2-2 用户裁决】普通下载的目标 = 设置里的默认下载路径。
         *
         * 修前这里取的是本地面板的当前目录（useLocalStore.getState().data?.cwd），
         * 于是用户必须先把本地栏切到想要的位置，否则文件会落在一个他不认识的地方。
         * 现在两件事彻底分开：普通下载看设置，拖拽下载看资源管理器的落点。
         *
         * settingsData 来自 store 订阅（渲染期已就位），不需要再 getState() 现取。
         * 【R4 事项 2】第二参数（本地面板 cwd）已随本地面板一起删除：现在签名只收 settings，
         * 「下载目标没有第二个来源」由签名本身表达，而不是靠一条传两个参数的用例证明。
         */
        localDir: () => downloadDirForDownload(settingsData),
        notify: setQueueNotice,
      })(),
    [serial, selectedTargets, download, settingsData],
  )

  /*
   * 【R4 事项 1】上传**真正传完**之后自动刷新当前目录。
   *
   * 修前只有「入队成功」时刷一次（enqueue 返回即 refresh），而 adb push 是排队异步跑的，
   * 几秒到几分钟后才落盘 —— 于是用户看到「底栏显示已完成，但文件列表里没有它」，
   * 只能手动按右上角刷新。上传入口在上轮也变了：本地面板已删除（R4 事项 2），
   * 剩下「拖入」与「传输底栏的上传按钮」两个，两条都不能再指望调用方刷。
   *
   * 判断本体全在 @shared/upload-refresh（纯函数 + 可注入时钟的看门狗，有 33 条用例）：
   * 方向必须是 push、状态必须是 done、serial 必须是当前设备、
   * 且 dst 的目录（归一别名后）必须等于当前 cwd。
   *
   * 这里只剩三行接线（订阅 / 喂快照 / 卸载）—— 它们发生在 useEffect 里，
   * 而本工程 environment: node、无 jsdom，SSR 只跑一次 render 不跑 effect，
   * 所以**这三行本身没有门禁**，已如实登记进「已知无门禁清单」。
   */
  useEffect(() => {
    const readContext = (): RefreshContext => {
      // 现取：用户随时会切设备/切目录，判定必须用**事件到来时**的那一份
      const active = useDeviceStore.getState().activeSerial
      return {
        serial: active,
        cwd: active === null ? '' : (useFileStore.getState().views[active]?.cwd ?? ''),
      }
    }
    const watcher = createTerminalRefreshWatcher(
      {
        readContext,
        refresh: (target) => { void refresh(target) },
        schedule: (delayMs, run) => {
          const timer = setTimeout(run, delayMs)
          return () => { clearTimeout(timer) }
        },
      },
      // 起始快照只用来「不把历史任务当成刚完成」，随后的变化都走订阅
      useTransferStore.getState().snapshot.tasks,
    )
    // transferStore 已订阅主进程的整份快照推送（main.tsx 挂一次）；这里再订阅一份**本地状态**
    // 的变化 —— 因为快照对象是不可变替换的，引用比较即可去掉无意义的重复回调。
    const unsubscribe = useTransferStore.subscribe((state, previous) => {
      if (state.snapshot === previous.snapshot) return
      watcher.onSnapshot(state.snapshot.tasks)
    })
    return () => {
      unsubscribe()
      watcher.dispose()
    }
  }, [refresh])


  /**
   * 拖入：资源管理器 → 当前设备目录。
   *
   * 业务逻辑就是用户的原话：**记录原始文件路径和目标路径，然后直接调用上传功能**。
   * 这里只做三件事：把 DOM 事件交给 shared 的纯函数、拿到 File 列表、
   * 交给 enqueueDroppedFiles（它负责去重/跳过非磁盘文件/逐项入队）。
   */
  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    prepareDropTarget(event)
  }, [])

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      // 必须 preventDefault：否则浏览器会尝试导航到被拖进来的文件
      event.preventDefault()
      if (serial === null) return
      const files = readDroppedFiles(event)
      if (files.length === 0) return
      void enqueueDroppedFiles(
        { getPath: (file) => window.api.transfer.getPathForFile(file), enqueue: window.api.transfer.enqueue },
        serial,
        files,
        current.cwd,
      ).then((result) => {
        setQueueNotice(dropNotice(result))
        if (result.queued > 0) void refresh(serial)
      })
    },
    [serial, current.cwd, refresh],
  )

  /**
   * 拖出：设备 → 资源管理器。
   *
   * 顺序与资源管理器一致：没选中就先选中这一行（replace），再按 dragOutTargets
   * 给出的路径集合发起拖出（已多选时拖整个选中集）。
   *
   * **必须 preventDefault()**：Electron 的 startDrag 只能由主进程发起，
   * 浏览器默认的拖拽必须取消——否则会同时发生「拖一个空 HTML 元素」和「主进程拖真文件」。
   */
  const handleDragStartRow = useCallback(
    (entry: FileEntry, event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      if (serial === null) return
      const targets = dragOutTargets(entry, current.selected, current.cwd)
      if (targets.selectFirst) dispatch(serial, { type: 'select', name: entry.name, mode: 'replace' })
      void dragOut(serial, targets.paths)
    },
    [serial, current.selected, current.cwd, dispatch, dragOut],
  )

  /** 新建文件夹：打开输入框；提交由对话框负责。 */
  const handleNewFolder = useCallback(() => {
    openOp({ type: 'openConfirm', kind: 'newFolder', targets: [] })
  }, [openOp])

  /** 重命名：必须是单选（工具条已按 selectedCount 禁用多项）。 */
  const handleRename = useCallback(() => {
    if (serial === null) return
    const targets = selectedTargets()
    if (targets.length !== 1) { setQueueNotice(t('op.noSelection')); return }
    openOp({ type: 'openConfirm', kind: 'rename', targets })
  }, [serial, selectedTargets, openOp])

  /**
   * 删除：**必须先取事实再开框**（裁决 1）。
   *
   * 取事实失败（例如整批都被拒绝）时不打开确认框 —— 宁可什么都不发生，
   * 也不弹一个信息不全的确认框让用户盲删。
   */
  const handleDelete = useCallback(async () => {
    if (serial === null) return
    const targets = selectedTargets()
    if (targets.length === 0) { setQueueNotice(t('op.noSelection')); return }
    const code = await prepareDelete(serial, targets)
    if (code !== null) setQueueNotice(errorText(code))
  }, [serial, selectedTargets, prepareDelete])

  /*
   * 全选（R2-2：多选功能早就实现了，但界面上没有任何入口 —— 用户直接问「多选在哪里」）。
   *
   * 复用 file-view 里既有的 selectAll action，且**与 Ctrl+A 走同一条**：
   * 选中范围都是「当前可见条目」（已过滤 + 排序后的 entries），都由 FilesPage 的同一个
   * useMemo 结果给出。两处各算一份是这类功能最常见的漂移来源
   * （隐藏项/排序变化后 Ctrl+A 与按钮选到不同的集合）。
   *
   * 无选中项时按钮**不禁用**：全选的意义正是「当前什么都没选」。
   */
  const handleSelectAll = useCallback(() => {
    selectAll(serial, entries)
  }, [serial, entries, selectAll])

  const handleCopyTo = useCallback(() => {
    const targets = selectedTargets()
    if (targets.length === 0) { setQueueNotice(t('op.noSelection')); return }
    openOp({ type: 'openConfirm', kind: 'copy', targets })
  }, [selectedTargets, openOp])

  const handleMoveTo = useCallback(() => {
    const targets = selectedTargets()
    if (targets.length === 0) { setQueueNotice(t('op.noSelection')); return }
    openOp({ type: 'openConfirm', kind: 'move', targets })
  }, [selectedTargets, openOp])

  /**
   * 右键一行（R5 事项 2）。
   *
   * 选中语义是用户裁决的落点，判定在 @shared/context-menu 的 contextSelectionFor（表驱动用例）：
   * - 右键**未选中**的行 → 先把它设为唯一选中项，再弹菜单；
   * - 右键**已选中**的行（多选）→ 保持多选不变，菜单作用于整批。
   *
   * 坐标取 clientX/clientY（视口坐标系）：ContextMenu 是 position: fixed，
   * 用滚动容器相对坐标会在虚拟列表滚动后整体错位。
   */
  const handleContextMenuRow = useCallback(
    (entry: FileEntry, event: React.MouseEvent<HTMLDivElement>) => {
      if (serial === null) return
      if (contextSelectionFor(entry.name, current.selected) === 'replace') {
        dispatch(serial, { type: 'select', name: entry.name, mode: 'replace' })
      }
      setMenu({ x: event.clientX, y: event.clientY, name: entry.name })
    },
    [serial, current.selected, dispatch],
  )

  /** 菜单关闭（点击外部 / Esc / 选项后 / 滚动）。 */
  const closeMenu = useCallback(() => { setMenu(null) }, [])

  /**
   * 菜单动作 → **复用既有 handler**（R5 事项 2 的硬约束：不重写一套业务逻辑）。
   *
   * 三个动作与工具条按钮走的是同一批函数：
   *   rename   → handleRename（内部 openOp rename，需恰好 1 项）
   *   delete   → handleDelete（内部先 prepareDelete 取事实再开框）
   *   download → handleDownload（内部走传输队列）
   *
   * 唯一要注意的是**顺序**：右键未选中行时，上面刚 dispatch 了 select，
   * 而 handleDelete / handleDownload 通过 selectedTargets() 从 store 现取选中项 ——
   * zustand 的 set 是同步的，所以这里读到的一定是「右键之后」的选中集合，
   * 不会拿旧集合去删/去下。
   */
  const handleMenuAction = useCallback(
    (id: MenuActionId) => {
      if (id === 'rename') { handleRename(); return }
      if (id === 'delete') { void handleDelete(); return }
      void handleDownload()
    },
    [handleRename, handleDelete, handleDownload],
  )

  /*
   * 菜单项由「右键之后的选中数量」决定（不是当前渲染期的 current.selected.length）：
   * 右键未选中行时 select 是同一轮事件里刚派发的，current.selected 要等下一次渲染才更新。
   * selectedCountAfterContext 就是那个「右键之后」的数字（有单测），
   * 保证「菜单里有几项」与「实际选中几项」严格同源。
   */
  const menuItems = useMemo(
    () => (menu === null ? [] : menuItemsFor(selectedCountAfterContext(menu.name, current.selected))),
    [menu, current.selected],
  )

  if (serial === null) {
    return <p className="p-8 text-sm text-neutral-500">{t('devices.selectHint')}</p>
  }

  const notice = current.notice !== null && !current.noticeDismissed ? current.notice : null
  const restoreKey = serial + '\u0001' + current.cwd + '\u0001' + current.status

  return (
    <div className="flex h-full min-h-0 w-full">
    <section className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/*
        * 【已知无门禁 / 合并前复审 I-2】下面 onDownload 那一行是**纯转发**：把工具条的
        * 点击转给 handleDownload（其逻辑在 makeDownloadHandler，见 @shared/download-flow）。
        * download-flow.test.ts 有 5 条行为用例（入参逐字段、未选中时 run 零调用、
        * 无本地目录时 run 零调用、下载期 busy=true、结束复位）。
        *
        * 但「本行有没有真的调用 handleDownload」**测不出来**：FilesPage 是组件，
        * 工程无 jsdom、只做 SSR 渲染（renderToStaticMarkup），而这条转发发生在
        * 点击后的事件回调里，SSR 拿不到。复审实测把它换成「空函数」→ 全量 1203 绿。
        * 按裁决 2：不造假静态断言，改为在此如实标注，并记进
        * .superpowers/sdd/adb-file-manager/progress.md 的「已知无门禁清单」。
        */}
      <FileToolbar
        selectedCount={current.selected.length}
        ready
        onCreateFolder={handleNewFolder}
        onRename={handleRename}
        onDelete={() => { void handleDelete() }}
        onCopyTo={handleCopyTo}
        onMoveTo={handleMoveTo}
        onDownload={() => { void handleDownload() }}
        onSelectAll={handleSelectAll}
        downloadHint={queueNotice}
        /* R6：搜索框在工具条右端（不新增行高）。过滤词进 store 分片，切设备各记各的。 */
        query={current.query}
        onQueryChange={(value) => { dispatch(serial, { type: 'setQuery', value }) }}
      />
      <div className="flex items-center gap-1 border-b border-neutral-300 pr-2">
        <div className="min-w-0 flex-1">
          <Breadcrumb
            path={current.cwd}
            onJump={handleJump}
            addressError={current.addressError}
            onAddressError={(code) => { dispatch(serial, { type: 'addressError', code }) }}
          />
        </div>
        <button
          type="button"
          onClick={() => { dispatch(serial, { type: 'setShowHidden', value: !current.showHidden }) }}
          title={current.showHidden ? t('files.hideHidden') : t('files.showHidden')}
          className={
            'shrink-0 rounded p-1.5 ' +
            (current.showHidden
              ? 'bg-neutral-200 text-neutral-900'
              : 'text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900')
          }
        >
          {current.showHidden
            ? <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            : <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={() => { void refresh(serial) }}
          title={t('files.refresh')}
          className="shrink-0 rounded p-1.5 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900"
        >
          <RefreshCw className={'h-3.5 w-3.5 ' + (current.status === 'loading' ? 'animate-spin' : '')} aria-hidden="true" />
        </button>
      </div>

      {/*
        * 「正在准备拖拽（N/M）」—— 用户确认过不设大小门槛，所以 500 MB 的拖出
        * 会先下载到临时目录再开始拖，期间的等待必须看得见。
        * 这一条绝不能省：没有它，用户看到的就是「拖了一下，然后什么都没发生」。
        */}
      {dragPreparing !== null && (
        <div className="flex items-center gap-2 border-b border-sky-200 bg-sky-50 px-3 py-1.5 text-[11px] leading-snug text-sky-700">
          <span className="flex-1">
            {tf('files.dragPreparing', { done: dragPreparing.done, total: dragPreparing.total })}
            {' '}
            {t('files.dragPreparingHint')}
          </span>
        </div>
      )}

      {/* 拖拽的提示（成功摘要 / 失败原因）：与队列提示同一位置，用户不必找两处 */}
      {dragNotice !== null && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] leading-snug text-amber-700">
          <Warn className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="flex-1">{dragNotice}</span>
          <button
            type="button"
            onClick={dismissDragNotice}
            className="shrink-0 rounded p-0.5 text-amber-600/70 hover:bg-amber-100 hover:text-amber-800"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      )}

      {/*
        * R9 / 裁决 B：上次停留的目录已不可用，已回到 /sdcard。
        *
        * 配色刻意用**中性灰**而不是错误红 / 警告琥珀：这不是故障 ——
        * 那个目录可能只是被用户自己删了，设备好好的。用红色会让用户以为设备出问题。
        * 文案也不含「失败」字样（见 i18n 的 files.cwdFallback）。
        */}
      {current.cwdFallback && (
        <div className="flex items-start gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 text-[11px] leading-snug text-neutral-600">
          <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="flex-1">{t('files.cwdFallback')}</span>
          <button
            type="button"
            onClick={() => { dispatch(serial, { type: 'dismissCwdFallback' }) }}
            title={t('files.cwdFallbackDismiss')}
            className="shrink-0 rounded p-0.5 text-neutral-500/70 hover:bg-neutral-200 hover:text-neutral-700"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      )}

      {notice !== null && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] leading-snug text-amber-700">
          <Warn className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="flex-1">
            {notice.degraded
              ? tf('files.notice.degraded', { count: notice.unparsed })
              : t('files.notice.exitCode')}
          </span>
          <button
            type="button"
            onClick={() => { dispatch(serial, { type: 'dismissNotice' }) }}
            title={t('files.notice.dismiss')}
            className="shrink-0 rounded p-0.5 text-amber-600/70 hover:bg-amber-100 hover:text-amber-800"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* 刷新失败（不是跳转失败）：保留列表，只在顶部提示（裁决 3 的同一条原则） */}
      {current.error !== null && current.entries.length > 0 && (
        <div className="border-b border-red-200 bg-red-50 px-3 py-1 text-[11px] text-red-600">
          {errorText(current.error)}
        </div>
      )}

      {/* 键盘处理挂在 FileTable 的根容器上（只挂一处，避免 Backspace 被处理两次） */}
      <div className="flex min-h-0 flex-1 flex-col outline-none">
        <FileTable
          entries={entries}
          selected={current.selected}
          tzOffsetMinutes={current.tzOffsetMinutes}
          status={current.status}
          error={current.error}
          emptyReason={empty}
          restoreKey={restoreKey}
          getRestoreScrollTop={getRestoreScrollTop}
          onScrollTop={onScrollTop}
          onOpen={handleOpen}
          onSelect={handleSelect}
          onRetry={() => { void refresh(serial) }}
          sort={current.sort}
          sortDir={current.sortDir}
          onSort={(sort) => { dispatch(serial, { type: 'setSort', sort }) }}
          onKeyNav={onListKeyDown}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragStartRow={handleDragStartRow}
          onContextMenuRow={handleContextMenuRow}
        />
      </div>

      {/*
        * 多选操作提示（R2-2）。
        *
        * 修前多选功能完整可用（Shift 区间 / Ctrl 加选 / Ctrl+A / Esc），但界面零提示，
        * 只有在左下角选中后才有「已选 N 项」—— 用户根本不知道能用。
        *
        * 显示条件：**有内容可选的目录**（还没加载完/空目录时不占位）。
        * 选中后就淡下去（opacity）而不是整条消失：消失会让布局跳动一次，
        * 而用户正在用这些快捷键时最不该看到的就是界面在跳。
        */}
      {entries.length > 0 && (
        <div
          className={
            'border-t border-neutral-300/70 px-3 py-1 text-[10px] text-neutral-400 transition-opacity ' +
            (current.selected.length > 0 ? 'opacity-60' : 'opacity-100')
          }
        >
          {t('files.selectHint')}
        </div>
      )}

      <div className="flex items-center gap-3 border-t border-neutral-300 px-3 py-1 text-[11px] text-neutral-500">
        <span>{tf('files.summary', { dirs: summary.dirs, files: summary.files })}</span>
        {/*
          * R6：搜索筛掉了一部分时，明说「匹配 N / 共 M」。
          * 底栏的统计只数过滤后的条目（用户看到几行就统计几行），没有这一句，
          * 2977 个文件变成 12 个时用户会以为另外 2965 个不见了。
          */}
        {matchLine !== null && (
          <span className="text-neutral-600">
            {tf('files.summaryMatch', { matched: matchLine.matched, total: matchLine.total })}
          </span>
        )}
        {current.selected.length > 0 && (
          <span className="text-neutral-600">{tf('files.selected', { count: current.selected.length })}</span>
        )}
      </div>

      {/*
        * 右键菜单（R5 事项 2）。
        *
        * 挂在 section 下、position: fixed 定位：它必须跳出虚拟列表的滚动容器，
        * 否则会被 overflow-auto 裁掉（菜单靠近列表下边缘时就看不全了）。
        */}
      {menu !== null && menuItems.length > 0 && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onAction={handleMenuAction}
          onClose={closeMenu}
        />
      )}

      {/* 操作对话框与结果提示：绝对定位覆盖在文件页内（不挡住底栏的传输进度） */}
      <OpDialogHost
        serial={serial}
        cwd={current.cwd}
        onRefresh={() => { void refresh(serial) }}
      />
    </section>
    </div>
  )
}
