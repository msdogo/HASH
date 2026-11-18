import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { subscribeDeviceChanges } from './store/deviceStore'
import './index.css'

// 先挂订阅（内部会先拉首屏再订阅增量），再渲染 —— 顺序反了会丢掉启动瞬间的变化。
const unsubscribe = subscribeDeviceChanges()
window.addEventListener('beforeunload', () => { unsubscribe() })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
