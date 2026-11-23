import { DEFAULT_CWD, normalizePath } from './file-view'

/**
 * R9：按设备序列号记住「上次停留的目录」——纯规则部分。
 *
 * ===== 为什么单独一个文件，而不是直接写在 FilesPage 里 =====
 *
 * 「恢复时该用哪个目录、什么时候算回退、回退后要不要提示」是这段功能里唯一的判断，
 * 而 FilesPage 是本工程测不到的地方（无 jsdom、只做 SSR 渲染，事件回调与 useEffect
 * 都观测不到 —— 这一点项目里已有多次记录）。把判断收成纯函数 + 注入式流程，
 * 才能用表驱动用例覆盖「有/无记录 × 成功/失败」四种组合。
 *
 * 本文件同时被渲染层与主进程编译：**不得** import 任何 node 内置模块，
 * 也**不得**碰 window.api（谁调 IPC 由 FilesPage 注入）。
 */

/* ============ 决策：用记录还是回退 ============ */

/** 一次恢复决策的结果。 */
export interface RestoreDecision {
  /** 最终该停在哪个目录。 */
  cwd: string
  /**
   * 是否发生了「记忆失效 → 回退到默认目录」。
   *
   * 值为 true 表示「这次是回退」，界面应当给一条**中性**提示（裁决 B：
   * 这不是故障，设备本身可能好好的，只是那个目录被删了 / 改名了）。
   * 注意它**不**保证回退后真的列举成功了 —— 那要看调用方拿到的列举结果。
   */
  fallback: boolean
}

/**
 * 一次恢复流程的完整结果 = 决策 + 「这一次到底动了没有」。
 *
 * restored = false 只在一种情况出现：分片已经加载过（切设备回来 / 重连），
 * 此时只发了一次刷新，既没用记忆值跳转、也没有回退。
 *
 * 单独一个类型而不是塞进 RestoreDecision：决策本身是纯函数（表驱动四组合），
 * 「动没动过」是流程层的事实 —— 混在一起会让那张决策表多出一个与输入无关的字段。
 */
export interface RestoreOutcome extends RestoreDecision {
  restored: boolean
}

/**
 * 持久化的记录是否可用（可以作为首次列举的目标）。
 *
 * 与存储层的校验刻意不同：这里只管「字符串能不能拿来当目录路径」，
 * 不判断「设备上还在不在」—— 后者要发 adb，只有列举本身能回答。
 */
function usableStoredCwd(stored: string | undefined): string | undefined {
  if (stored === undefined) return undefined
  const trimmed = stored.trim()
  if (trimmed === '') return undefined
  return normalizePath(trimmed)
}

/**
 * 首次列举该用哪个目录。
 *
 * 有记录用记录，没有就用默认目录。**不加任何猜测**：不要因为「看起来像旧格式」
 * 就悄悄换一个，用户看到的那一次跳转必须能从记录里解释清楚。
 */
export function firstCwdOf(stored: string | undefined): string {
  return usableStoredCwd(stored) ?? DEFAULT_CWD
}

/**
 * 恢复失败与否的**唯一判定**（表驱动用例覆盖四种组合）。
 *
 * | 有记录 | 列举成功 | 结果                        |
 * |--------|----------|-----------------------------|
 * | 有     | 成功     | 用记录，不提示              |
 * | 有     | 失败     | 回退 /sdcard，提示          |
 * | 无     | 失败     | 回退 /sdcard，提示          |
 * | 无     | 成功     | /sdcard，不提示             |
 *
 * 「无记录 + 失败」为什么也算回退：那条列举打的就是默认目录，它都打不开，
 * 说明问题在设备侧（掉线 / 未授权 / 未挂载），用户需要一句解释。
 *
 * @param stored 存储里的记录（undefined = 从没记过 / 记录是坏值被存储层丢弃）
 * @param listOk 用 firstCwdOf(stored) 那一次列举是否成功
 */
export function resolveRestoreCwd(stored: string | undefined, listOk: boolean): RestoreDecision {
  const usable = usableStoredCwd(stored)
  if (listOk) return { cwd: usable ?? DEFAULT_CWD, fallback: false }
  return { cwd: DEFAULT_CWD, fallback: true }
}

/* ============ 恢复流程（注入式，可测） ============ */

/** 恢复流程的依赖（生产里由 FilesPage 接 window.api 与 fileStore）。 */
export interface CwdRestoreDeps {
  /**
   * 读某台设备持久化的目录。
   *
   * 允许返回 undefined（没有记录 / 记录是坏值）。**允许抛错**：
   * 读设置失败不该拦住用户浏览文件，内部会降级成「没有记录」。
   */
  readStored: (serial: string) => Promise<string | undefined>
  /**
   * 打开目录，返回是否成功。
   *
   * 生产实现是 fileStore.openDir + 读分片判定（成功 = loadedOnce 且 cwd 已是目标）。
   * 返回 false 表示目录不存在 / 无权限 / 设备掉线 —— 具体原因由渲染层的
   * 错误态负责展示，这里只需要一个是非。
   */
  openDir: (serial: string, dir: string) => Promise<boolean>
  /**
   * 把「打算去的目录」先写进视图（分片还没建时用它建）。
   *
   * 为什么需要：分片的默认 cwd 是 /sdcard。有记录时若不一上来就把它改成记录里的目录，
   * 面包屑会先显示 /sdcard、等列举成功后再跳到真实目录（一次可见的闪动）。
   * 由调用方注入（生产是 fileStore.dispatch({ type: 'seedCwd', cwd })），本文件不碰 store。
   */
  seed: (serial: string, cwd: string) => void
  /** 标记「已回退」：界面据此显示那条中性提示。 */
  markFallback: (serial: string) => void
  /**
   * 该设备的分片是否**已经上过真实目录**。
   *
   * 切走再切回来时（设备重连推送也会走到这里）分片还在、内容还在，
   * 这时按记忆值再跳一次会把用户从他正在看的地方拽走。判据交给调用方注入
   * （生产读 fileStore 分片的 loadedOnce），本文件不碰 store。
   */
  isLoaded: (serial: string) => boolean
  /** 已经加载过时的动作：只要一次刷新，不要跳转（生产是 fileStore.refresh）。 */
  reload: (serial: string) => void
}

/** 恢复流程：设备上线时把「上次停留的目录」接回来。 */
export interface CwdRestore {
  /** 恢复某台设备的目录；返回本次结果（测试与调用方都可以据此判断）。 */
  restore: (serial: string) => Promise<RestoreOutcome>
}

/**
 * 造一个恢复流程。
 *
 * 顺序即语义：
 * 1. 读记录（失败 = 没有记录，不拦浏览）；
 * 2. 列举 firstCwdOf(记录)；
 * 3. 成功 → 结束（用记录）；失败且目标不是默认目录 → 再列一次默认目录；
 * 4. 回退那一次**成功**才标记 fallback（提示才有意义：用户确实被移动了）；
 *    回退也失败时什么都不标 —— 那时整页是错误态 + 重试按钮，再叠一条
 *    「已回到 /sdcard」只会自相矛盾（列表都没打开）。
 */
export function createCwdRestore(deps: CwdRestoreDeps): CwdRestore {
  const readStoredSafe = async (serial: string): Promise<string | undefined> => {
    try {
      return await deps.readStored(serial)
    } catch {
      // 读设置失败 = 没有记录。目录记忆是便利功能，它坏了不该让文件页打不开。
      return undefined
    }
  }

  return {
    restore: async (serial) => {
      /*
       * 已经上过真实目录：只刷新，不按记忆值跳转。
       * 用户的导航历史永远比记忆值新 —— 设备掉线重连的推送也走这条路。
       */
      if (deps.isLoaded(serial)) {
        deps.reload(serial)
        return { cwd: DEFAULT_CWD, fallback: false, restored: false }
      }

      const stored = await readStoredSafe(serial)
      const first = firstCwdOf(stored)
      deps.seed(serial, first)
      const ok = await deps.openDir(serial, first)
      const decision = resolveRestoreCwd(stored, ok)
      if (!decision.fallback) return { ...decision, restored: true }

      /*
       * 打的就是默认目录（从没记录 / 记录本身就是 /sdcard）：没有「回退」这一步可做，
       * 再列一次同一个目录只会多发一条 adb。但提示照给 —— 连默认目录都打不开，
       * 说明问题在设备侧（掉线 / 未授权 / 存储未挂载），用户需要一句解释。
       */
      if (first === DEFAULT_CWD) {
        deps.markFallback(serial)
        return { ...decision, restored: true }
      }

      const fallbackOk = await deps.openDir(serial, DEFAULT_CWD)
      /*
       * 回退那一次**成功**才标记提示：回退也失败时整页已经是错误态 + 重试按钮，
       * 再叠一条「已回到 /sdcard」会自相矛盾（列表根本没打开）。
       */
      if (fallbackOk) deps.markFallback(serial)
      return { ...decision, restored: true }
    },
  }
}

/* ============ 「这一次列举成功了没有」的唯一判定 ============ */

/** 判定所需的最小视图面（传 FileViewState 或它的部分字段都行）。 */
export interface OpenedViewFacts {
  cwd: string
  status: string
  loadedOnce: boolean
}

/**
 * 某台设备是否**已经停在** dir 上（= 那次 openDir 成功了）。
 *
 * 为什么需要它、且必须是纯函数：fileStore 的 openDir 只返回 Promise<void>
 * （它内部的失败会落到 reducer 的 error/addressError 上），调用方要判断成败
 * 只能回读分片。而这个判定的三个条件（已加载过一次 / 状态 ready / cwd 就是目标）
 * 一旦写错，恢复流程会**静默**用错目录或误报「已回退」——所以抽出来做表驱动用例。
 *
 * 注意 cwd 要归一化后比较：用户记录里可能是 '/sdcard/DCIM/'，
 * 而 reducer 提交的是 normalizePath 之后的 '/sdcard/DCIM'。
 */
export function openedAt(view: OpenedViewFacts | undefined, dir: string): boolean {
  if (view === undefined) return false
  if (!view.loadedOnce) return false
  if (view.status !== 'ready') return false
  return view.cwd === normalizePath(dir)
}

/* ============ 写盘：fire-and-forget ============ */

/** 记忆写盘的最小依赖。 */
export interface CwdMemoDeps {
  /**
   * 真正把 serial → cwd 写进设置。
   *
   * 返回 Promise（生产是 IPC invoke），但调用方**绝不 await** 它：
   * 目录记忆是便利功能，写盘快慢不该让用户等一次「打开目录」。
   */
  write: (serial: string, cwd: string) => Promise<unknown>
  /** 告警出口（测试可注入以断言「失败只 warn」）。缺省 console.warn。 */
  warn?: (message: string) => void
}

/** 目录记忆的写入口。 */
export interface CwdMemo {
  /**
   * 记住某台设备的当前目录。
   *
   * **同步返回 void**：这是「不阻塞 UI」在类型层的体现 —— 调用方（useEffect）
   * 没有可以 await 的东西，也就不存在「忘了 await 导致时序错」这种隐患。
   * 写盘在后台跑：成功什么都不做，失败只 warn（不弹错误框、不进错误态）。
   */
  remember: (serial: string | null, cwd: string) => void
}

/**
 * 造一个 fire-and-forget 的记忆写入器（裁决 A：每次成功进入目录就写，不防抖）。
 *
 * 三件事必须同时成立，缺一条就会变成「目录记忆拖慢浏览」：
 * 1. 调用方拿不到 Promise（返回 void）—— 结构上就不可能 await 它；
 * 2. write 的**同步抛错**也被 try/catch 吞掉（window.api 缺失时就是同步抛）；
 * 3. Promise 拒绝走 .catch → warn，不产生未处理的 rejection。
 */
export function createCwdMemo(deps: CwdMemoDeps): CwdMemo {
  const warn = deps.warn ?? ((message: string): void => { console.warn(message) })

  return {
    remember: (serial, cwd) => {
      // 没有设备 / 没有目录：不产生垃圾记录（存储层还有第二道同样的拒绝）
      if (serial === null || serial.trim() === '') return
      if (cwd.trim() === '') return
      try {
        void deps.write(serial, cwd).catch((err: unknown) => {
          warn('[cwd-memo] 记住设备 ' + serial + ' 的目录失败（不影响浏览）：' + String(err))
        })
      } catch (err) {
        // write 自己同步抛（例如 preload 还没注入）：同样只 warn
        warn('[cwd-memo] 记住设备 ' + serial + ' 的目录失败（不影响浏览）：' + String(err))
      }
    },
  }
}
