import { createRoot } from 'react-dom/client'
import { App } from './App'
import { KantiProvider } from './state'
import './styles/app.css'

createRoot(document.getElementById('root')!).render(
  <KantiProvider>
    <App />
  </KantiProvider>,
)
