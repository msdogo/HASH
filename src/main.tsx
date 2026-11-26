import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { subscribeDeviceChanges } from './store/deviceStore'
import { subscribeTransferChanges } from './store/transferStore'
import { subscribeInstallLog } from './store/logStore'
import { exposeStoresForDebug } from './devtools'
import './index.css'

// 先挂订阅（内部会先拉首屏再订阅增量），再渲染 —— 顺序反了会丢掉启动瞬间的变化。
// 仅 dev：把真实 store 单例挂到 window，方便 DevTools 与手工验证脚本驱动（生产构建里被常量折叠掉）
exposeStoresForDebug()

const unsubscribe = subscribeDeviceChanges()
const unsubscribeTransfers = subscribeTransferChanges()
/*
 * 安装日志的订阅必须挂在**这里**而不是应用页里：
 * 切页会卸载应用页（见 App.tsx 的三页互斥渲染注释），
 * 而安装一个包要几十秒 —— 挂页面里就意味着切走之后进度与结果全丢，
 * 日志栏恰恰在最需要它的时候是空的。
 */
const unsubscribeInstallLog = subscribeInstallLog()
window.addEventListener('beforeunload', () => {
  unsubscribe()
  unsubscribeTransfers()
  unsubscribeInstallLog()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
