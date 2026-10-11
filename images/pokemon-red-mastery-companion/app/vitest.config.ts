import { defineConfig } from 'vitest/config'
import preact from '@preact/preset-vite'
export default defineConfig({
  plugins: [preact()],
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
  },
})
