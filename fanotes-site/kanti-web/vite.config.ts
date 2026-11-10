import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const testing = Boolean(process.env.VITEST)

// One source for the school logic (the server's schulnetz-logic.mjs), the brand mark and the font
// (the Android app's), so the browser cannot drift from either.
export default defineConfig({
  plugins: [react()],
  base: '/',
  resolve: {
    alias: {
      '@shared/schulnetz-logic': here('../schulnetz-logic.mjs'),
      '@brand': here('../../android/companion/docs/brand'),
      '@font': here('../../android/companion/src/main/res/font'),
      // The browser never calls the few server-only helpers (gzip, sha256, IP literals).
      ...(testing ? {} : {
        'node:zlib': here('src/lib/node-stubs.ts'),
        'node:crypto': here('src/lib/node-stubs.ts'),
        'node:net': here('src/lib/node-stubs.ts'),
      }),
    },
  },
  server: { fs: { allow: [here('..'), here('../../android/companion')] } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    target: 'es2022',
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
  },
})
