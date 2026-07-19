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
  },
  build: {
    target: 'es2022',
  },
})
