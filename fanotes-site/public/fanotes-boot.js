// Runs before first paint (blocking, tiny): marks JavaScript support and
// applies a saved colour scheme so the page never flashes the wrong theme.
(() => {
  const root = document.documentElement
  root.classList.add('js')
  try {
    const saved = localStorage.getItem('fanotes-site-theme')
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved
  } catch {
    // Storage can be blocked; the system colour scheme still applies.
  }
})()
