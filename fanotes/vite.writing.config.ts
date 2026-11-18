// Build of the stand-alone writing mode for the Android WebView
// (`npm run build:android-writing`). Only the writing entry, the headless
// handwriting recognition host (`recognition.html`) and their chunks; the fonts,
// thesaurus and spelling data are copied by the build script.
import { defineConfig, mergeConfig } from 'vite'
import base from './vite.config'

export default defineConfig(async (env) => {
  const resolved = typeof base === 'function' ? await base(env) : base
  return mergeConfig({ ...resolved, plugins: (resolved.plugins ?? []).filter((plugin) => !/pwa/iu.test(String((plugin as { name?: string })?.name ?? ''))) }, {
    publicDir: false,
    build: { outDir: 'dist-writing', emptyOutDir: true, rollupOptions: { input: { writing: 'writing.html', recognition: 'recognition.html' } } },
  })
})
