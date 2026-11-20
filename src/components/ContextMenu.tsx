import { useEffect, useRef } from 'react'
import { Pencil, Trash2, ArrowDownToLine } from 'lucide-react'
import { t } from '@shared/i18n'
import {
  clampMenuPosition,
  menuBoxSize,
  type MenuActionId,
  type MenuItem,
} from '@shared/context-menu'

/**
 * 文件列表的右键菜单（R5 事项 2）。
 *
 * ===== 坐标系：position: fixed + 视口坐标 =====
 * 用 clientX/clientY 直接定位一个 fixed 元素，**不用**滚动容器的相对坐标：
 * 文件列表是 @tanstack/react-virtual 的虚拟列表，容器本身在滚动、行还在 translateY
 * 变换里 —— 相对坐标会在滚动后整体错位，而且虚拟列表回收行时连参照物都没了。
 *
 * ===== 判断全在 @shared/context-menu（有单测）=====
 * 本组件只做三件事：
 *   1. 把菜单项画出来（文案走 i18n，复用工具条已有的 key）；
 *   2. 把「哪一项被点了」转给 onAction（再转发到 FilesPage 既有的 handler）；
 *   3. 点击外部 / Esc 关闭。
 * 「几项」「翻到哪边」都由 shared 的纯函数算，组件里不做任何业务判断。
 */

export interface ContextMenuProps {
  /** 右键点在视口坐标系里的位置（clientX / clientY）。 */
  x: number
  y: number
  /** 菜单项（来自 menuItemsFor，顺序即显示顺序）。 */
  items: MenuItem[]
  /** 选中任一项：先关闭菜单，再交给上层复用既有的重命名/删除/下载 handler。 */
  onAction: (id: MenuActionId) => void
  /** 关闭菜单（点击外部、Esc、滚动、窗口失焦）。 */
  onClose: () => void
}

/** 动作图标（与工具条同一套 lucide 图标，视觉上能对应上是同一个动作）。 */
const ACTION_ICONS: Record<MenuActionId, React.ReactNode> = {
  rename: <Pencil className="h-3.5 w-3.5" aria-hidden="true" />,
  delete: <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />,
  download: <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden="true" />,
}

export function ContextMenu(props: ContextMenuProps) {
  const { x, y, items, onAction, onClose } = props
  const menuRef = useRef<HTMLDivElement | null>(null)

  /*
   * 外框尺寸由 CSS 决定（min-w + 行内容），但夹取要在**渲染前**就知道尺寸，
   * 所以用 shared 的 menuBoxSize 算一份确定值，渲染时把它写死成 width/height。
   * 两处（计算与样式）共用同一组常量，不会出现「算的是 66、画出来是 70」。
   */
  const box = menuBoxSize(items.length)
  const point = clampMenuPosition({
    x,
    y,
    width: box.width,
    height: box.height,
    // 视口尺寸只在浏览器里才有；SSR（测试）走兜底值，组件不因此崩
    viewport: typeof window === 'undefined'
      ? { width: box.width, height: box.height }
      : { width: window.innerWidth, height: window.innerHeight },
  })

  /*
   * 关闭的三个触发（简报要求：点击外部 / Esc / 选择任一项后）。
   * 「选择任一项」由 onClick 里先 onAction 再 onClose 完成，这里只管前两个 + 滚动。
   *
   * 为什么用捕获阶段监听 document：菜单项的点击会冒泡到 document，
   * 若用冒泡且不判断目标，点菜单项会先被「点击外部」逻辑关掉。
   * 这里按 menuRef.contains(target) 排除菜单内部，两种阶段都安全；
   * 用捕获是为了在其它组件的 stopPropagation 之前先关掉菜单。
   */
  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Node && menuRef.current !== null && menuRef.current.contains(target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === 'Esc') {
        event.preventDefault()
        onClose()
      }
    }
    // 列表一滚动菜单就与行脱开了（fixed 不跟滚动），直接关掉比让它飘在错的位置好
    const onScroll = (): void => { onClose() }
    // 窗口失焦（切到别的应用）：菜单留着没有意义，回来时右键上下文已经变了
    const onBlur = (): void => { onClose() }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [onClose])

  if (items.length === 0) return null

  return (
    <div
      ref={menuRef}
      role="menu"
      data-testid="file-context-menu"
      /*
       * 亮色主题（与工具条的 border-neutral-300 + bg-neutral-100 一族对齐）：
       * 面板 bg-white 保证与文本对比度；边框比工具条深一档（neutral-300），
       * 因为它要浮在内容之上、必须能跟下面的行分开。
       * z-50 高于 OpDialogHost 的 z-20：结果提示条不该盖住正在操作的菜单。
       */
      className="fixed z-50 overflow-hidden rounded-md border border-neutral-300 bg-white py-1 shadow-xl"
      style={{ left: point.x, top: point.y, width: box.width }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          title={t(item.labelKey)}
          onClick={() => {
            // 先交给上层（它可能打开对话框），再关闭菜单 —— 顺序反了在真机上会有
            // 「菜单消失但对话框没弹」的一帧闪烁
            onAction(item.id)
            onClose()
          }}
          className={
            // 亮色主题下的危险项做成红字 + 红 hover 底（与工具条的删除按钮同一套语义）；
            // 其余用 neutral-700，hover 才加深到 900 —— 与工具条 ToolButton 一致。
            'flex h-7 w-full items-center gap-2 px-2 text-left text-xs disabled:opacity-40 ' +
            (item.id === 'delete'
              ? 'text-red-700 hover:bg-red-50'
              : 'text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900')
          }
        >
          {ACTION_ICONS[item.id]}
          <span className="truncate">{t(item.labelKey)}</span>
        </button>
      ))}
    </div>
  )
}
