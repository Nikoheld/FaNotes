# Kanti+ im Browser — design language ("Stundentakt", desktop)

Calm, precise, a little editorial. It must read as the Kanti+ Android app laid out for a laptop.
Reference implementation: the shell (`src/styles/shell.css`, `src/App.tsx`) and the dashboard
(`src/styles/today.css`, `src/views/Today.tsx`). Look at them before you design anything.

## Rules
- **Tokens only** (`src/styles/tokens.css`): colours via `--bg --surface --sunken --raised --text --muted
  --hairline --outline --accent --accent-soft --success(-soft) --warning(-soft) --danger(-soft) --tint`,
  brand `--brand-navy --brand-gold` (logo colours; sparingly), space `--s1…--s10` (4px grid), radius
  `--radius-s/m/l/xl`, type `--text-xs/s/m/l/xl/2xl`, elevation `--shadow-1/2/3`, motion `--fast --ease`.
  Never hard-code a colour that a theme should change (8 themes: light, sepia, snow, dark, midnight,
  forest, aurora + system). Derive tints with `color-mix(in srgb, …)`.
- **Type**: Instrument Sans. Headings 650, tight tracking. Numbers (times, marks, points, dates in
  tables) use `.tabular` (condensed tabular figures) — that is the brand's signature; big figures are
  bold condensed. Small uppercase labels (`.section-label h2`, table `th`) = 12–13px, 650, +0.02em.
- **Surfaces**: page `--bg`; cards `.card` (surface, hairline, radius 16, `--shadow-1`); lists inside a
  card use `.card.list` with rows that tint on hover (`--tint`); interactive cards lift to `--shadow-2`.
  One hero element per view at most (accent-soft radial gradient like `.hero`).
- **Status colour is meaning, not decoration**: accent = now/selected, success = good/on time,
  warning = exam/estimate/changed, danger = cancelled/fail. Cancelled lessons say "Fällt aus" in words.
- **Components to reuse** (`src/styles/base.css`, `src/components/ui.tsx`): `.button(-primary/-outline/
  -quiet/-small)`, `.icon-button`, `.link`, `.tag(-accent/-success/-warning/-danger)`, `.room-pill`,
  `.segments`, `.banner`, `.card`, `.section-label`, `.empty`, `.stat-row/.stat`, `.meter`, `.entry-row`,
  `.mark`, tables, `.details`, dialogs. Add a new shared component to base.css only if two views need it.
- **Layout**: content area is ~1120px wide at 1440 (sidebar 256). Use the width: 2–3 columns on
  desktop, stacking below ~1180px (tablet has a 72px icon rail), single column on phones. No
  horizontal scroll at 820px or 390px. No layout shift: reserve sizes for anything that loads.
- **A11y**: WCAG AA contrast in every theme (check light + dark at least), visible `:focus-visible`,
  real buttons/links, labels for controls, charts get `role="img"` + `aria-label` and the numbers stay
  available as text. Motion ≤ 220ms, opacity/translate only; `prefers-reduced-motion` is handled globally.
- **CSP**: no inline `<style>`, no `style="…"` strings in HTML files. React `style={{…}}` (CSSOM) is fine
  for computed positions/widths only. No external fonts, images or scripts. SVG inline.
- No "nur lesen" / "read-only" labels anywhere. Demo data only.

## Working
- Screenshots (synthetic demo data, fixed clock Wed 11 Nov 2026 10:02):
  `PORT=<your port> PLAYWRIGHT_BROWSERS_PATH=/srv/agents/fanotes/chats/companion-683d7e0e/.work/pw-browsers node scripts/review-shots.mjs <out-dir> <view,view>`
  views: heute stundenplan noten termine absenzen mitteilungen pendeln einstellungen anmelden about 404;
  `SIZES=desktop,tablet,phone THEMES=light,dark`. Read the PNGs and be your own harshest critic:
  alignment, rhythm, truncation, empty space, contrast, dark mode. Iterate until it looks premium.
- Checks: `npm run typecheck`, `npx vitest run`. Keep every existing behaviour, text and test intact.
