import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: [{
      // Transformers.js imports the all-provider ONNX entry by default. FaNotes
      // intentionally uses CPU/WASM only, so bind that exact bare import to the
      // matching WASM-only runtime and avoid shipping/initializing WebGPU JSEP.
      find: /^onnxruntime-web$/,
      replacement: path.resolve(
        __dirname,
        'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs',
      ),
    }],
  },
  server: {
    port: 5174,
    strictPort: true,
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
    // Web-mode add-on store: same-origin proxies to GitHub, mirroring the
    // production nginx config (fanotes-site/deploy). FANOTES_ADDONS_REGISTRY
    // points the raw-file proxy at a local static server for testing.
    proxy: {
      '/addons-registry': {
        target: process.env.FANOTES_ADDONS_REGISTRY ?? 'https://raw.githubusercontent.com',
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.replace(/^\/addons-registry/u, ''),
      },
      '/addons-api': {
        target: process.env.FANOTES_ADDONS_API ?? 'https://api.github.com',
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.replace(/^\/addons-api/u, ''),
        headers: { 'User-Agent': 'FaNotes-AddonStore' },
      },
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/pdfjs-dist')) return 'pdfjs'
          if (id.includes('node_modules/@codemirror') || id.includes('node_modules/@lezer')) return 'codemirror'
          if (id.includes('node_modules/katex')) return 'katex'
          if (id.includes('node_modules/react-dom') || id.includes('/node_modules/react/')) return 'react'
          return undefined
        },
      },
    },
  },
})
