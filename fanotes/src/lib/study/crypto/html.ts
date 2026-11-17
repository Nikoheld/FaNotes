/** Read-only HTML of a crypto block (note editor widget and preview). Every user string is escaped. */

import { escapeHtml as esc } from '../blocks'
import { PLAIN_ROW, checkAlphabet, keywordParts, shiftAlphabet } from './caesar'
import { applyMap, frequencyRows } from './freq'
import { cellText } from './letters'
import { CRYPTO_TOOL_LABELS, type CryptoData } from './model'
import { vigenereRows } from './vigenere'
import { xorLetters } from './xor'

const cell = (value: string, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${esc(value)}</td>`

const text = (label: string, value: string) => (value.trim() ? `<div class="lw-crypto-line"><b>${esc(label)}</b> <span class="lw-crypto-text">${esc(value)}</span></div>` : '')

const strip = (cipher: string) => {
  if (cipher.length !== 26) return ''
  const rows = [PLAIN_ROW, cipher].map((row, index) => `<tr class="${index ? 'is-cipher' : 'is-plain'}">${[...row].map((ch) => cell(ch)).join('')}</tr>`).join('')
  return `<div class="lw-table-wrap"><table class="lw-crypto-strip"><tbody>${rows}</tbody></table></div>`
}

const caesarHtml = (data: Extract<CryptoData, { tool: 'caesar' }>) => {
  let cipher = ''
  if (data.mode === 'shift') cipher = shiftAlphabet(data.shift)
  else if (data.mode === 'alphabet') { const check = checkAlphabet(data.alphabet); cipher = check.ok ? check.letters : '' }
  else cipher = [...data.built.padEnd(26, '_').slice(0, 26)].map((ch) => cellText(ch).toUpperCase() || '·').join('')
  const keyword = data.mode === 'keyword' && data.keyword
    ? `<div class="lw-crypto-line"><b>Schlüsselwort</b> ${keywordParts(data.keyword).map((part) => (part.kind === 'repeat' ? `<s>${esc(part.ch)}</s>` : esc(part.ch))).join('')}</div>`
    : ''
  const mode = data.mode === 'shift' ? `Verschiebung um ${data.shift}` : data.mode === 'alphabet' ? 'Vorgegebenes Alphabet' : 'Schlüsselwort'
  return `<div class="lw-crypto-line"><b>${esc(mode)}</b></div>${keyword}${strip(cipher)}${text('Text', data.task)}${text('Antwort', data.answer)}`
}

const freqHtml = (data: Extract<CryptoData, { tool: 'freq' }>) => {
  const rows = frequencyRows(data.text).filter((row) => row.count > 0).slice(0, 12)
  const bars = rows.map((row) => `<tr><th>${esc(row.letter)}</th><td><span class="lw-crypto-bar" style="width:${Math.min(100, Math.round(row.percent * 4))}%"></span></td>${cell(`${row.percent.toFixed(1)} % (${row.count})`)}</tr>`).join('')
  const mapped = applyMap(data.text, data.map).map((token) => (token.plain ? `<span class="lw-crypto-plain">${esc(token.plain)}</span>` : esc(token.ch))).join('')
  return `${bars ? `<div class="lw-table-wrap"><table class="lw-crypto-bars"><tbody>${bars}</tbody></table></div>` : ''}${data.text.trim() ? `<div class="lw-crypto-line"><span class="lw-crypto-text">${mapped}</span></div>` : ''}`
}

const alignedRows = (rows: Array<[string, string[]]>) => `<div class="lw-table-wrap"><table class="lw-crypto-rows"><tbody>${rows.map(([label, values]) => `<tr><th>${esc(label)}</th>${values.map((value) => cell(value)).join('')}</tr>`).join('')}</tbody></table></div>`

const vigenereHtml = (data: Extract<CryptoData, { tool: 'vigenere' }>) => {
  const rows = vigenereRows(data.key, data.plain)
  if (!rows.plain) return ''
  const answer = [...rows.plain].map((_, index) => cellText(data.answer[index]).toUpperCase())
  return alignedRows([['Klartext', [...rows.plain]], ['Schlüssel', [...rows.key]], ['Geheimtext', answer]])
}

const xorHtml = (data: Extract<CryptoData, { tool: 'xor' }>) => {
  const letters = xorLetters(data.plain, data.key)
  if (!letters.plain) return ''
  const bits = (list: string[]) => [...letters.plain].map((_, index) => [...(list[index] ?? '')].map((bit) => cellText(bit) || '·').join(''))
  return alignedRows([['Klartext', [...letters.plain]], ['Klartext (ASCII)', bits(data.p)], ['Schlüssel', [...letters.key]], ['Schlüssel (ASCII)', bits(data.k)], ['Geheimtext', bits(data.c)]])
}

const opText = (op: string) => (op === '*' ? '·' : op === '+' ? '+' : 'hoch')

const modHtml = (data: Extract<CryptoData, { tool: 'mod' }>) => {
  const head = data.a && data.b && data.m ? `<div class="lw-crypto-line"><b>(${esc(data.a)} ${opText(data.op)} ${esc(data.b)}) mod ${esc(data.m)}</b></div>` : ''
  const steps = [['a mod m', data.s1], ...(data.op === '^' ? [] : [['b mod m', data.s2]]), [data.op === '*' ? 'Produkt' : data.op === '+' ? 'Summe' : '(a mod m) hoch b', data.s3], ['Resultat mod m', data.s4]]
    .filter(([, value]) => value)
    .map(([label, value]) => `<div class="lw-crypto-line">${esc(label)} = <b>${esc(value)}</b></div>`).join('')
  return `${head}${steps}`
}

const dhHtml = (data: Extract<CryptoData, { tool: 'dh' }>) => {
  const given = [['Y', data.y], ['P', data.p], ['A', data.a], ['B', data.b]].filter(([, value]) => value)
  const own = [['α', data.alpha], ['β', data.beta], ['s (Alice)', data.sa], ['s (Bob)', data.sb]].filter(([, value]) => value)
  const line = (items: string[][]) => (items.length ? `<div class="lw-crypto-line">${items.map(([label, value]) => `${esc(label)} = <b>${esc(value)}</b>`).join(' · ')}</div>` : '')
  return `${line(given)}${line(own)}`
}

export const renderCryptoHtml = (data: CryptoData): string => {
  let inner = ''
  switch (data.tool) {
    case 'caesar': inner = caesarHtml(data); break
    case 'freq': inner = freqHtml(data); break
    case 'vigenere': inner = vigenereHtml(data); break
    case 'xor': inner = xorHtml(data); break
    case 'mod': inner = modHtml(data); break
    case 'dh': inner = dhHtml(data); break
  }
  const title = data.title.trim() || CRYPTO_TOOL_LABELS[data.tool]
  return `<div class="lw-crypto"><div class="lw-title">${esc(title)} <span class="lw-crypto-tool">${esc(CRYPTO_TOOL_LABELS[data.tool])}</span></div>${inner}</div>`
}
