import { describe, expect, it } from 'vitest'
import { kontoFooter, parseChfAmount } from '../src/lib/konto'
import { demoSnapshot } from '../src/lib/demo'
import { STRINGS } from '../src/lib/i18n'

const lines = [
  { date: '12.08.2026', label: 'a', amount: '-12.50 CHF', balance: '87.50 CHF' },
  { date: '20.08.2026', label: 'b', amount: '100.00 CHF', balance: '187.50 CHF' },
]

describe('Kontoauszug footer', () => {
  it('parses CHF amounts', () => {
    expect(parseChfAmount('-12.50 CHF')).toBe(-12.5)
    expect(parseChfAmount("1'234.50 CHF")).toBe(1234.5)
    expect(parseChfAmount('12,50')).toBe(12.5)
    expect(parseChfAmount('n/a')).toBeNull()
  })

  it('prefers the Schulnetz Saldo, then the running Saldo, then the sum', () => {
    expect(kontoFooter(lines, '5.40 CHF')).toEqual({ kind: 'schulnetz', amount: '5.40 CHF' })
    expect(kontoFooter(lines, '')).toEqual({ kind: 'running', amount: '187.50 CHF' })
    const bare = [{ ...lines[0], balance: '' }, { ...lines[1], amount: "1'000.00", balance: '' }]
    expect(kontoFooter(bare, undefined)).toEqual({ kind: 'calculated', amount: '987.50 CHF' })
    expect(kontoFooter([], '')).toBeNull()
  })

  it('has both language strings and a demo Saldo', () => {
    expect(STRINGS.de.accountBalance).toBe('Kontostand')
    expect(STRINGS.en.accountBalanceCalculated).toBe('Balance (calculated)')
    expect(demoSnapshot('2026-11-10').kontoSaldo).toBeTruthy()
  })
})
