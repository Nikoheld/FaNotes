/* Runs before first paint (classic script, CSP-safe): applies the saved theme background so no white flash shows. */
(function () {
  try {
    var theme = localStorage.getItem('fanotes.theme')
    var colors = { oled: '#000000', dark: '#191919', midnight: '#17181b', forest: '#171a18', aurora: '#18181c' }
    if (theme === 'system') theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    var bg = colors[theme]
    if (!bg) return
    var root = document.documentElement
    root.style.background = bg
    root.style.colorScheme = 'dark'
    root.setAttribute('data-boot-theme', theme)
    var style = document.createElement('style')
    style.textContent = 'body{background:' + bg + ' !important;color:#e8e8e8 !important}.boot-surface{background:' + bg + ' !important}.boot-card small{color:#a8a8a8 !important}.boot-mark{background:#e8e8e8 !important;color:#000 !important}.boot-progress{background:#262626 !important}.boot-progress::after{background:#e8e8e8 !important}'
    document.head.appendChild(style)
  } catch (e) {}
})()
