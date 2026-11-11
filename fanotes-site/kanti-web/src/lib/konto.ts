import type { KontoLine } from '../types'

/** Parses "-12.50 CHF", "1'234.50 CHF" or "12,50"; null when there is no number. */
export const parseChfAmount = (raw: string): number | null => {
  const cleaned = String(raw || '').replace(/CHF/gi, '').replace(/['’\s]/g, '').replace(/−/g, '-')
  const match = /[-+]?\d+(?:[.,]\d+)?/.exec(cleaned)
  if (!match) return null
  const value = Number(match[0].replace(',', '.'))
  return Number.isFinite(value) ? value : null
}

export type KontoFooter = { kind: 'schulnetz' | 'running' | 'calculated'; amount: string }

/** Footer choice: Schulnetz's own Saldo, else the last row's running Saldo, else the sum of the amounts. */
export const kontoFooter = (lines: KontoLine[], kontoSaldo?: string): KontoFooter | null => {
  if (kontoSaldo?.trim()) return { kind: 'schulnetz', amount: kontoSaldo.trim() }
  if (!lines.length) return null
  const running = lines[lines.length - 1].balance?.trim()
  if (running) return { kind: 'running', amount: running }
  const amounts = lines.map((line) => parseChfAmount(line.amount)).filter((value): value is number => value !== null)
  if (!amounts.length) return null
  const sum = Math.round(amounts.reduce((total, value) => total + value, 0) * 100) / 100
  return { kind: 'calculated', amount: `${sum.toFixed(2)} CHF` }
}
