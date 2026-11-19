import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { subscribeDeviceChanges } from './store/deviceStore'
import { subscribeTransferChanges } from './store/transferStore'
import { exposeStoresForDebug } from './devtools'
import './index.css'

// 先挂订阅（内部会先拉首屏再订阅增量），再渲染 —— 顺序反了会丢掉启动瞬间的变化。
// 仅 dev：把真实 store 单例挂到 window，方便 DevTools 与手工验证脚本驱动（生产构建里被常量折叠掉）
exposeStoresForDebug()

const unsubscribe = subscribeDeviceChanges()
const unsubscribeTransfers = subscribeTransferChanges()
window.addEventListener('beforeunload', () => {
  unsubscribe()
  unsubscribeTransfers()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)