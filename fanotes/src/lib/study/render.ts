/**
 * Renders study blocks as HTML/SVG strings. Every user string is escaped here, so the
 * result can be set as innerHTML in the editor widget and in the Markdown preview.
 */

import { asImage, escapeHtml as esc, isVaultImageRef, type StudyKind } from './blocks'
import { LABEL_METRICS, layoutKeyTree, type KeyData } from './keyTree'
import { layoutMap, type MapData } from './conceptMap'
import { unsortedCards, type SortData } from './sortBoard'
import { plateColumns, type PlateData, type TermData } from './cardsModels'

export type Palette = { text: string; muted: string; line: string; fill: string; accent: string; leaf: string; bg: string }

/** Live rendering follows the app theme through CSS variables. */
export const THEME_PALETTE: Palette = {
  text: 'var(--text, #1b1d23)',
  muted: 'var(--text-muted, #667085)',
  line: 'var(--border-strong, #98a2b3)',
  fill: 'var(--panel, #ffffff)',
  accent: 'var(--accent, #4f6bed)',
  leaf: 'var(--panel-strong, #eef1f8)',
  bg: 'transparent',
}
/** Exported images are always light so they read on a worksheet. */
export const EXPORT_PALETTE: Palette = { text: '#1b1d23', muted: '#4b5565', line: '#667085', fill: '#ffffff', accent: '#2f4bd0', leaf: '#e8edfb', bg: '#ffffff' }

/**
 * `<img>` for a stored picture: vault files are filled in later by hydrateVaultImages. Only what `asImage`
 * accepts is rendered (a worksheet file of the vault, or a small base64 png/jpeg/webp/gif data URL); any
 * other reference gives an empty string, so a caller that skipped the block normalisation cannot turn a
 * block into a remote tracking pixel, a `javascript:` URL or a `data:text/html` / SVG sink.
 */
export const imgTag = (ref: string, alt: string) => {
  const safe = asImage(ref)
  if (!safe) return ''
  return isVaultImageRef(safe) ? `<img data-vault-src="${esc(safe)}" alt="${esc(alt)}"/>` : `<img alt="${esc(alt)}" src="${esc(safe)}"/>`
}

const FONT = "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif"

const svgText = (lines: readonly string[], cx: number, top: number, palette: Palette, size = 12.5, weight = 500) => lines
  .map((line, index) => `<text x="${cx}" y="${top + 13 + index * 16}" text-anchor="middle" style="${FONT};font-size:${size}px;font-weight:${weight};fill:${palette.text}">${esc(line)}</text>`)
  .join('')

export type SvgImage = { svg: string; width: number; height: number }

export const renderKeyTreeSvg = (data: KeyData, palette: Palette = THEME_PALETTE): SvgImage => {
  const layout = layoutKeyTree(data.tree)
  const title = data.title.trim()
  const offset = title ? 26 : 0
  // Lines first, then the labels on top of them (a label hides the drop line behind it), then the boxes.
  const parts: string[] = layout.edges.map((edge) => `<path d="M${edge.x1} ${edge.y1 + offset} V${edge.busY + offset} H${edge.x2} V${edge.y2 + offset}" style="fill:none;stroke:${palette.line};stroke-width:1.4"/>`)
  for (const { labelBox: box } of layout.edges) {
    if (!box) continue
    parts.push(`<rect class="lw-key-label" x="${box.x}" y="${box.y + offset}" width="${box.w}" height="${box.h}" rx="4" style="fill:${palette.fill}"/>`)
    parts.push(box.lines.map((line, index) => `<text class="lw-key-label" x="${box.x + box.w / 2}" y="${box.y + offset + LABEL_METRICS.padY + LABEL_METRICS.ascent + index * LABEL_METRICS.lineHeight}" text-anchor="middle" style="${FONT};font-size:${LABEL_METRICS.font}px;fill:${palette.muted}">${esc(line)}</text>`).join(''))
  }
  for (const node of layout.nodes) {
    const leaf = node.kind === 'leaf'
    parts.push(`<rect x="${node.x}" y="${node.y + offset}" width="${node.w}" height="${node.h}" rx="${leaf ? node.h / 2 > 18 ? 10 : node.h / 2 : 8}" style="fill:${leaf ? palette.leaf : palette.fill};stroke:${leaf ? palette.line : palette.accent};stroke-width:${leaf ? 1.2 : 1.6}"/>`)
    parts.push(svgText(node.lines, node.x + node.w / 2, node.y + offset + 3, palette, 12.5, leaf ? 600 : 500))
  }
  const heading = title ? `<text x="8" y="17" style="${FONT};font-size:14px;font-weight:700;fill:${palette.text}">${esc(title)}</text>` : ''
  const width = Math.round(layout.width)
  const height = Math.round(layout.height + offset)
  const background = palette.bg === 'transparent' ? '' : `<rect width="${width}" height="${height}" style="fill:${palette.bg}"/>`
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(title || 'Bestimmungsschlüssel')}">${background}${heading}${parts.join('')}</svg>`, width, height }
}

let markerSeq = 0

export const renderMapSvg = (data: MapData, palette: Palette = THEME_PALETTE): SvgImage => {
  const layout = layoutMap(data)
  const title = data.title.trim()
  const offset = title ? 28 : 0
  // Every map has its own arrowhead id: with one shared id, a map in a hidden container (a closed editor tab, a collapsed
  // section) would be the one every other map's arrows refer to, and their heads would vanish.
  const arrow = `lw-arrow-${(markerSeq += 1)}`
  const parts: string[] = [`<defs><marker id="${arrow}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" style="fill:${palette.accent}"/></marker></defs>`]
  const shifted = (path: string) => path.replace(/([MC])([^MC]*)/gu, (_all, cmd: string, rest: string) => `${cmd}${rest.trim().split(/\s+/u).map((value, index) => (index % 2 ? String(Number(value) + offset) : value)).join(' ')}`)
  for (const edge of layout.edges) {
    parts.push(`<path d="${shifted(edge.path)}" marker-end="url(#${arrow})" style="fill:none;stroke:${palette.accent};stroke-width:1.6"/>`)
    if (edge.label) {
      const width = edge.label.length * 6 + 10
      parts.push(`<rect x="${edge.lx - width / 2}" y="${edge.ly + offset - 9}" width="${width}" height="17" rx="5" style="fill:${palette.fill};opacity:.92"/><text x="${edge.lx}" y="${edge.ly + offset + 4}" text-anchor="middle" style="${FONT};font-size:11px;font-style:italic;fill:${palette.muted}">${esc(edge.label)}</text>`)
    }
  }
  for (const node of layout.nodes) {
    parts.push(`<rect x="${node.x}" y="${node.y + offset}" width="${node.w}" height="${node.h}" rx="9" style="fill:${palette.fill};stroke:${palette.line};stroke-width:1.4"/>`)
    parts.push(svgText(node.lines, node.x + node.w / 2, node.y + offset + 3, palette))
  }
  const heading = title ? `<text x="8" y="18" style="${FONT};font-size:14px;font-weight:700;fill:${palette.text}">${esc(title)}</text>` : ''
  const width = Math.round(layout.width)
  const height = Math.round(layout.height + offset)
  const background = palette.bg === 'transparent' ? '' : `<rect width="${width}" height="${height}" style="fill:${palette.bg}"/>`
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(title || 'Begriffsnetz')}">${background}${heading}${parts.join('')}</svg>`, width, height }
}

const tableHtml = (data: KeyData) => {
  const { features, items } = data.table
  if (!features.length && !items.length) return ''
  const head = features.map((feature, index) => `<th>${esc(feature || `Merkmal ${index + 1}`)}</th>`).join('')
  const rows = items.map((item) => `<tr><th scope="row">${esc(item.name)}</th>${item.values.map((value) => `<td>${esc(value)}</td>`).join('')}</tr>`).join('')
  return `<div class="lw-table-wrap"><table class="lw-table"><thead><tr><th>Art</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
}

const renderKeyHtml = (data: KeyData) => {
  const tree = renderKeyTreeSvg(data)
  const compareImage = data.compareImage ? imgTag(data.compareImage, data.compareLabel || 'Vergleichsbaum') : ''
  const compare = compareImage ? `<figure class="lw-compare">${compareImage}<figcaption>${esc(data.compareLabel || 'Vergleich')}</figcaption></figure>` : ''
  return `${data.title ? `<div class="lw-title">${esc(data.title)}</div>` : ''}${tableHtml(data)}<div class="lw-key-views${compare ? ' is-compare' : ''}"><div class="lw-svg">${data.tree.nodes.length ? tree.svg : ''}</div>${compare}</div>`
}

const renderSortHtml = (data: SortData) => {
  const text = new Map(data.cards.map((card) => [card.id, card.text]))
  const pool = unsortedCards(data)
  const groups = data.groups.map((group) => `<div class="lw-group"><div class="lw-group-title">${esc(group.title || 'Gruppe')}</div>${group.cards.map((id, index) => `<div class="lw-card">${data.mode === 'sequence' ? `<b>${index + 1}.</b> ` : ''}${esc(text.get(id) ?? '')}</div>`).join('')}</div>`).join('')
  const open = pool.length ? `<div class="lw-pool">${pool.map((card) => `<span class="lw-card is-open">${esc(card.text)}</span>`).join('')}</div>` : ''
  return `${data.title ? `<div class="lw-title">${esc(data.title)}</div>` : ''}<div class="lw-groups">${groups}</div>${open}`
}

const renderPlateHtml = (data: PlateData) => {
  const cells = data.items.map((item) => `<figure class="lw-plate-item">${(item.img && imgTag(item.img, item.label)) || '<div class="lw-plate-empty"></div>'}${data.showLabels ? `<figcaption>${esc(item.label)}</figcaption>` : ''}</figure>`).join('')
  // The column count goes into a style attribute: clamp it here too, not only when the block is read.
  return `${data.title ? `<div class="lw-title">${esc(data.title)}</div>` : ''}<div class="lw-plate" style="grid-template-columns:repeat(${plateColumns(data.cols)},minmax(0,1fr))">${cells}</div>`
}

const renderTermHtml = (data: TermData) => data.terms.map((entry) => (
  `<div class="lw-term"><div class="lw-term-name">${esc(entry.term || 'Begriff')}</div>${entry.definition ? `<p>${esc(entry.definition)}</p>` : ''}${entry.example ? `<p class="lw-term-example"><b>Beispiel:</b> ${esc(entry.example)}</p>` : ''}${entry.source ? `<p class="lw-term-source">Quelle: ${esc(entry.source)}</p>` : ''}</div>`
)).join('')

export type StudyAnyData = KeyData | SortData | MapData | PlateData | TermData

export const renderStudyHtml = (kind: StudyKind, data: StudyAnyData): string => {
  switch (kind) {
    case 'key': return renderKeyHtml(data as KeyData)
    case 'sort': return renderSortHtml(data as SortData)
    case 'map': return `<div class="lw-svg">${(data as MapData).nodes.length ? renderMapSvg(data as MapData).svg : ''}</div>`
    case 'plate': return renderPlateHtml(data as PlateData)
    case 'term': return renderTermHtml(data as TermData)
  }
}
