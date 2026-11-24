import { createRoot } from 'react-dom/client'
import { App } from './App'
import { KantiProvider } from './state'
import { registerServiceWorker } from './lib/webpush'
import { VaultProvider } from './vault/store'
import './styles/app.css'

registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <KantiProvider>
    <VaultProvider>
      <App />
    </VaultProvider>
  </KantiProvider>,
)
