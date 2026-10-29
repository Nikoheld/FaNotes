import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const { hasConnectedAiProvider } = await server.ssrLoadModule('/src/lib/aiProviderConnection.ts')
  const empty = {
    lmStudioModel: '',
    ollamaModel: '',
    openCodeModel: '',
    openAiModel: '',
    openAiApiKey: '',
    geminiModel: '',
    geminiApiKey: '',
    anthropicModel: '',
    anthropicApiKey: '',
    grokModel: '',
    grokApiKey: '',
  }
  assert.equal(hasConnectedAiProvider(empty), false)
  assert.equal(hasConnectedAiProvider({ ...empty, lmStudioModel: '  ' }), false)
  assert.equal(hasConnectedAiProvider({ ...empty, lmStudioModel: 'local/lm' }), true)
  assert.equal(hasConnectedAiProvider({ ...empty, ollamaModel: 'qwen:latest' }), true)
  assert.equal(hasConnectedAiProvider({ ...empty, openCodeModel: 'anthropic/claude-test' }), true)
  assert.equal(hasConnectedAiProvider({ ...empty, openAiApiKey: 'sk-test' }), true)
  assert.equal(hasConnectedAiProvider({ ...empty, openAiModel: 'gpt-test' }), true)
  assert.equal(hasConnectedAiProvider({ ...empty, geminiApiKey: 'gem-test' }), true)
  assert.equal(hasConnectedAiProvider({ ...empty, anthropicModel: 'claude-test' }), true)
  assert.equal(hasConnectedAiProvider({ ...empty, grokApiKey: 'xai-test' }), true)
  assert.equal(hasConnectedAiProvider({ ...empty, grokModel: 'grok-4.7' }), true)
  const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
  assert.match(app, /\{hasConnectedAiProvider\(settings\) && \([\s\S]*?aria-label="AI-Assistent öffnen"/u)
  console.log('ai provider button ok')
} finally {
  await server.close()
}
