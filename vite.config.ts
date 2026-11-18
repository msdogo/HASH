import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import path from 'node:path'

const root = import.meta.dirname

export default defineConfig({
  base: './',
  plugins: [
    react(),
    electron({
      main: { entry: 'electron/main.ts' },
      preload: {
        input: path.join(root, 'electron/preload.ts'),
        // 显式锁定 CJS：package.json 是 type: module，若产物用 .mjs 扩展名却含 require()，
        // 只有 sandbox: true 下的 Electron 预加载器垫片能跑；关掉沙箱即静默失效。
        vite: {
          build: {
            rollupOptions: {
              output: { format: 'cjs', entryFileNames: '[name].cjs' },
            },
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@shared': path.join(root, 'src/shared'),
      '@': path.join(root, 'src'),
    },
  },
  server: { port: 5555, host: '127.0.0.1', strictPort: true },
})
