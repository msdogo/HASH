import { defineConfig } from 'vitest/config'
import path from 'node:path'

const root = import.meta.dirname

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.join(root, 'src/shared'),
      '@': path.join(root, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
