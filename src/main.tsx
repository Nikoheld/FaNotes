import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initializeGlyphenWerkLocalization } from './i18n'
import 'katex/dist/katex.min.css'
import './styles.css'

void initializeGlyphenWerkLocalization().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
