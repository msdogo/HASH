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
      preload: { input: path.join(root, 'electron/preload.ts') },
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
