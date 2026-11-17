import { Check, Lightbulb } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import {
  PLAIN_ROW, checkAlphabet, checkAnswer, checkBuilt, hintAnswer, keywordAlphabet, keywordParts, shiftAlphabet, summariseAnswer, unusedLetters,
} from '../../lib/study/crypto/caesar'
import { checkDhField, dhProblems, secretsAgree, type DhField } from '../../lib/study/crypto/dh'
import { applyMap, duplicateAssignments, frequencyRows, referenceRows } from '../../lib/study/crypto/freq'
import { ALPHABET, cellText, isLetter, setCharAt, type CellState } from '../../lib/study/crypto/letters'
import { CRYPTO_LIMITS, type CaesarData, type CryptoData, type DhData, type FreqData, type ModData, type VigenereData, type XorData } from '../../lib/study/crypto/model'
import { MOD_RULES, checkModField, modFields, modProblem } from '../../lib/study/crypto/modular'
import { checkVigenere, hintVigenere, nextOpenVigenere, vigenereLetter, vigenereRows } from '../../lib/study/crypto/vigenere'
import { BITS, asciiBits, checkBitsRow, emptyBits, fitCells, insertCodes, xorLetters, type XorRow } from '../../lib/study/crypto/xor'

type Props = { data: CryptoData; onChange: (data: CryptoData) => void }

const MARK: Record<CellState, string> = { ok: '✓', bad: '✗', open: '' }
const MARK_LABEL: Record<CellState, string> = { ok: 'richtig', bad: 'falsch', open: 'noch leer' }
const digitsOnly = (value: string, max: number = CRYPTO_LIMITS.number) => value.replace(/\D/gu, '').slice(0, max)
const lastChar = (value: string) => value.slice(-1)

function Mark({ state }: { state: CellState }) {
  return state === 'open' ? null : <span className={`lw-cx-mark is-${state}`} role="img" aria-label={MARK_LABEL[state]}>{MARK[state]}</span>
}

function TitleField({ data, onChange }: Props) {
  return (
    <label className="lw-cx-title"><span>Titel</span>
      <input value={data.title} maxLength={CRYPTO_LIMITS.title} onChange={(event) => onChange({ ...data, title: event.target.value })} />
    </label>
  )
}

function Rule({ children }: { children: ReactNode }) {
  return <p className="lw-hint lw-cx-rule">{children}</p>
}

// -- Caesar -------------------------------------------------------------------------------------------

const MODES: Array<[CaesarData['mode'], string]> = [['shift', 'Verschiebung'], ['alphabet', 'Vorgegebenes Alphabet'], ['keyword', 'Schlüsselwort']]

function CaesarTool({ data, onChange }: { data: CaesarData; onChange: (data: CryptoData) => void }) {
  const [checked, setChecked] = useState(false)
  const [pick, setPick] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const edit = (patch: Partial<CaesarData>) => { setChecked(false); setNote(''); onChange({ ...data, ...patch }) }

  const given = useMemo(() => checkAlphabet(data.alphabet), [data.alphabet])
  const target = data.mode === 'shift' ? shiftAlphabet(data.shift) : data.mode === 'alphabet' ? (given.ok ? given.letters : '') : keywordAlphabet(data.keyword)
  const shown = data.mode === 'keyword'
    ? Array.from({ length: 26 }, (_, index) => cellText(data.built[index]).toUpperCase())
    : Array.from({ length: 26 }, (_, index) => target[index] ?? '')
  const builtStates = useMemo(() => checkBuilt(data.keyword, data.built), [data.keyword, data.built])
  const cells = useMemo(() => (checked && target ? checkAnswer(data.task, data.answer, target) : []), [checked, target, data.task, data.answer])
  const summary = summariseAnswer(data.task, cells)
  const parts = keywordParts(data.keyword)
  const free = unusedLetters(data.built)

  const hint = () => {
    const result = target ? hintAnswer(data.task, data.answer, target) : null
    if (!result) { setNote(target ? 'Es gibt nichts mehr zu verraten: Alle Buchstaben stimmen.' : 'Für einen Hinweis braucht es ein gültiges Alphabet.'); return }
    setChecked(false)
    setNote(`Ein Buchstabe wurde bei Position ${result.index + 1} eingesetzt.`)
    onChange({ ...data, answer: result.answer })
  }

  return (
    <>
      <div className="lw-cx-modes" role="group" aria-label="Art des Alphabets">
        {MODES.map(([mode, label]) => <button key={mode} type="button" className={`lw-chip ${data.mode === mode ? 'is-on' : ''}`} aria-pressed={data.mode === mode} onClick={() => edit({ mode })}>{label}</button>)}
      </div>
      {data.mode === 'shift' && (
        <label className="lw-cx-field"><span>Verschiebung (0 bis 25)</span>
          <input type="number" min={0} max={25} value={data.shift} onChange={(event) => edit({ shift: Math.max(0, Math.min(25, Math.trunc(Number(event.target.value)) || 0)) })} />
        </label>
      )}
      {data.mode === 'alphabet' && (
        <div className="lw-cx-field"><label><span>Vorgegebenes Geheimalphabet (26 Buchstaben)</span>
          <input value={data.alphabet} maxLength={CRYPTO_LIMITS.alphabet} placeholder="z. B. L P A I Q J B C T R W Z Y D S K E G F X H U O N V M" onChange={(event) => edit({ alphabet: event.target.value })} />
        </label>
          {data.alphabet.trim() && !given.ok && (
            <p className="lw-error" role="alert">
              {given.invalid.length > 0 && `Ungültige Zeichen: ${given.invalid.join(' ')}. `}
              {given.duplicates.length > 0 && `Mehrfach vorhanden: ${given.duplicates.join(' ')}. `}
              {given.missing.length > 0 && `Es fehlen: ${given.missing.join(' ')}.`}
            </p>
          )}
        </div>
      )}
      {data.mode === 'keyword' && (
        <div className="lw-cx-field"><label><span>Schlüsselwort</span>
          <input value={data.keyword} maxLength={CRYPTO_LIMITS.keyword} placeholder="z. B. kantonsschule" onChange={(event) => edit({ keyword: event.target.value })} />
        </label>
          {data.keyword.trim() && (
            <>
              <p className="lw-cx-keyword" aria-label="Schlüsselwort ohne Wiederholungen">
                {parts.map((part, index) => <span key={index} className={`lw-cx-k is-${part.kind}`}>{part.kind === 'space' ? ' ' : part.ch.toUpperCase()}</span>)}
              </p>
              <Rule>Streiche Leerzeichen und doppelte Buchstaben (durchgestrichen) weg, schreibe das Wort in die Zeile unten und fülle mit den freien Buchstaben weiter, beginnend nach dem letzten Buchstaben des Schlüsselworts.</Rule>
              <p className="lw-cx-free" aria-label="Noch nicht eingesetzte Buchstaben">
                {[...ALPHABET].map((ch) => <span key={ch} className={`lw-cx-k ${free.includes(ch) ? 'is-free' : 'is-used'}`}>{ch}</span>)}
              </p>
            </>
          )}
        </div>
      )}

      <div className="lw-cx-scroll">
        <table className="lw-cx-strip" aria-label="Alphabetstreifen">
          <tbody>
            <tr>{[...PLAIN_ROW].map((ch, index) => (
              <td key={ch}><button type="button" className={`lw-cx-letter ${pick === index ? 'is-pick' : ''}`} aria-pressed={pick === index} aria-label={`Klartextbuchstabe ${ch}`} onClick={() => setPick(pick === index ? null : index)}>{ch}</button></td>
            ))}</tr>
            <tr>{shown.map((ch, index) => (
              data.mode === 'keyword'
                ? (
                  <td key={index} className={pick === index ? 'is-pick' : ''}>
                    <input className={`lw-cx-cell ${checked && builtStates[index] !== 'open' ? `is-${builtStates[index]}` : ''}`} maxLength={1} aria-label={`Geheimbuchstabe zu ${PLAIN_ROW[index]}`} value={ch} onFocus={() => setPick(index)}
                      onChange={(event) => { const next = lastChar(event.target.value); if (!next || isLetter(next)) edit({ built: setCharAt(data.built, index, next.toUpperCase(), 26) }) }} />
                  </td>
                )
                : <td key={index} className={`lw-cx-cipher ${pick === index ? 'is-pick' : ''}`}>{ch}</td>
            ))}</tr>
          </tbody>
        </table>
      </div>
      {data.mode === 'keyword' && (
        <div className="lw-actions">
          <button type="button" className="secondary-button" disabled={!data.keyword.trim()} onClick={() => setChecked(true)}><Check size={14} /> Alphabet prüfen</button>
          {checked && builtStates.some((state) => state !== 'open') && <span className="lw-hint">{builtStates.filter((state) => state === 'ok').length} von 26 Feldern stimmen{builtStates.some((state) => state === 'bad') ? ', die falschen sind rot markiert' : ''}.</span>}
        </div>
      )}

      <label className="lw-cx-field"><span>Aufgabentext (Klartext)</span>
        <textarea rows={2} maxLength={CRYPTO_LIMITS.text} value={data.task} onChange={(event) => edit({ task: event.target.value })} />
      </label>
      <label className="lw-cx-field"><span>Deine Antwort (Geheimtext, Leerzeichen und Satzzeichen wie im Text)</span>
        <textarea rows={2} className="lw-cx-mono" spellCheck={false} maxLength={CRYPTO_LIMITS.answer} value={data.answer} onChange={(event) => edit({ answer: event.target.value })} />
      </label>
      <div className="lw-actions">
        <button type="button" className="secondary-button" disabled={!target || !data.task.trim()} onClick={() => setChecked(true)}><Check size={14} /> Prüfen</button>
        <button type="button" className="secondary-button" disabled={!target || !data.task.trim()} onClick={hint} title="Verrät genau einen richtigen Buchstaben"><Lightbulb size={14} /> Hinweis</button>
        {!target && data.mode !== 'keyword' && <span className="lw-hint">Prüfen und Hinweis brauchen ein gültiges Alphabet.</span>}
        {!target && data.mode === 'keyword' && <span className="lw-hint">Prüfen und Hinweis brauchen ein Schlüsselwort.</span>}
      </div>
      {checked && cells.length > 0 && (
        <div className="lw-cx-result" role="status">
          <p className="lw-cx-marked" aria-label="Geprüfte Antwort">{cells.map((cell, index) => <span key={index} className={`lw-cx-ch is-${cell.state}`}>{cell.ch === ' ' ? ' ' : cell.ch}</span>)}</p>
          <p className="lw-hint">{summary.ok} richtig, {summary.bad} falsch, {summary.open} offen (von {summary.total} Buchstaben).</p>
        </div>
      )}
      {note && <p className="lw-hint" role="status">{note}</p>}
    </>
  )
}

// -- Frequency analysis -------------------------------------------------------------------------------

function Bars({ rows, max, label }: { rows: Array<{ letter: string; percent: number; count: number }>; max: number; label: string }) {
  return (
    <ul className="lw-cx-bars" aria-label={label}>
      {rows.map((row) => (
        <li key={row.letter}>
          <b>{row.letter}</b>
          <span className="lw-cx-track"><span className="lw-cx-fill" style={{ width: `${max ? Math.max(0, Math.min(100, (row.percent / max) * 100)) : 0}%` }} /></span>
          <span className="lw-cx-pct">{row.percent.toFixed(1)} %{row.count ? ` · ${row.count}` : ''}</span>
        </li>
      ))}
    </ul>
  )
}

function FreqTool({ data, onChange }: { data: FreqData; onChange: (data: CryptoData) => void }) {
  const rows = useMemo(() => frequencyRows(data.text), [data.text])
  const present = rows.filter((row) => row.count > 0)
  const reference = useMemo(() => referenceRows(data.lang), [data.lang])
  const max = Math.max(1, ...present.map((row) => row.percent), ...reference.map((row) => row.percent))
  const tokens = useMemo(() => applyMap(data.text, data.map), [data.text, data.map])
  const duplicates = duplicateAssignments(data.map)
  const assign = (cipher: string, plain: string) => {
    const map = { ...data.map }
    if (plain) map[cipher] = plain
    else delete map[cipher]
    onChange({ ...data, map })
  }
  return (
    <>
      <label className="lw-cx-field"><span>Geheimtext einfügen</span>
        <textarea rows={4} className="lw-cx-mono" spellCheck={false} maxLength={CRYPTO_LIMITS.freqText} value={data.text} onChange={(event) => onChange({ ...data, text: event.target.value })} />
      </label>
      <div className="lw-cx-modes" role="group" aria-label="Sprache der Referenz">
        {(['de', 'en'] as const).map((lang) => <button key={lang} type="button" className={`lw-chip ${data.lang === lang ? 'is-on' : ''}`} aria-pressed={data.lang === lang} onClick={() => onChange({ ...data, lang })}>{lang === 'de' ? 'Deutsch' : 'Englisch'}</button>)}
      </div>
      {present.length > 0 && (
        <div className="lw-cx-two">
          <div><h4>Dein Geheimtext</h4><Bars rows={present} max={max} label="Buchstabenhäufigkeit im Geheimtext" /></div>
          <div><h4>{data.lang === 'de' ? 'Deutsch (Skript)' : 'Englisch (Standardwerte)'}</h4><Bars rows={reference} max={max} label="Referenzhäufigkeit" /></div>
        </div>
      )}
      {present.length > 0 && (
        <>
          <h4>Zuordnung: Geheimbuchstabe → Klartextbuchstabe</h4>
          <div className="lw-cx-grid">
            {present.map((row) => {
              const plain = data.map[row.letter] ?? ''
              const dupe = plain && duplicates[plain]
              return (
                <label key={row.letter} className={`lw-cx-assign ${dupe ? 'is-dupe' : ''}`}><b>{row.letter}</b>
                  <input maxLength={1} aria-label={`Klartextbuchstabe für ${row.letter}`} value={plain}
                    onChange={(event) => { const next = lastChar(event.target.value).toLowerCase(); if (!next || /^[a-z]$/u.test(next)) assign(row.letter, next) }} />
                </label>
              )
            })}
          </div>
          {Object.entries(duplicates).map(([plain, ciphers]) => <p key={plain} className="lw-error" role="alert">Der Buchstabe „{plain}“ ist mehrfach vergeben ({ciphers.join(', ')}). Ein Klartextbuchstabe passt zu genau einem Geheimbuchstaben.</p>)}
          <h4>Text mit deinen Zuordnungen</h4>
          <p className="lw-cx-mono lw-cx-text" aria-label="Geheimtext mit eingesetzten Buchstaben">
            {tokens.map((token, index) => (token.plain ? <span key={index} className="lw-cx-sub">{token.plain}</span> : <span key={index}>{token.ch}</span>))}
          </p>
          <Rule>Eingesetzte Buchstaben sind farbig, die übrigen bleiben Geheimbuchstaben. Das Werkzeug schlägt nichts vor: Vergleiche die Balken und entscheide selbst.</Rule>
        </>
      )}
    </>
  )
}

// -- Vigenère -----------------------------------------------------------------------------------------

function VigenereTool({ data, onChange }: { data: VigenereData; onChange: (data: CryptoData) => void }) {
  const [checked, setChecked] = useState(false)
  const [focus, setFocus] = useState<number | null>(null)
  const rows = useMemo(() => vigenereRows(data.key, data.plain), [data.key, data.plain])
  const states = useMemo(() => (checked ? checkVigenere(rows, data.answer) : []), [checked, rows, data.answer])
  const edit = (patch: Partial<VigenereData>) => { setChecked(false); onChange({ ...data, ...patch }) }
  const keyLetter = focus !== null ? rows.key[focus] : ''
  const plainLetter = focus !== null ? rows.plain[focus] : ''
  const entered = focus !== null && Boolean(cellText(data.answer[focus]))
  const setLetter = (index: number, ch: string) => {
    edit({ answer: setCharAt(data.answer, index, ch.toUpperCase(), rows.plain.length) })
    if (ch) window.setTimeout(() => document.querySelector<HTMLInputElement>(`[data-vig="${index + 1}"]`)?.focus(), 0)
  }
  const hint = () => {
    const index = focus !== null && focus < rows.plain.length ? focus : nextOpenVigenere(rows, data.answer)
    if (index < 0) return
    setFocus(index)
    edit({ answer: hintVigenere(rows, data.answer, index) })
  }
  return (
    <>
      <div className="lw-cx-pair">
        <label className="lw-cx-field"><span>Schlüssel</span><input value={data.key} maxLength={CRYPTO_LIMITS.key} placeholder="z. B. OBWALDEN" onChange={(event) => edit({ key: event.target.value })} /></label>
        <label className="lw-cx-field"><span>Klartext (ohne Leerzeichen)</span><input value={data.plain} maxLength={CRYPTO_LIMITS.text} onChange={(event) => edit({ plain: event.target.value })} /></label>
      </div>
      <Rule>Suche die Zeile des Schlüsselbuchstabens und die Spalte des Klartextbuchstabens. Der Geheimbuchstabe steht dort, wo sie sich treffen.</Rule>
      <div className="lw-cx-scroll lw-cx-square-wrap">
        <table className="lw-cx-square" aria-label="Vigenère-Quadrat">
          <thead><tr><th aria-hidden="true" />{[...ALPHABET].map((ch) => <th key={ch} scope="col" className={plainLetter === ch ? 'is-pick' : ''}>{ch}</th>)}</tr></thead>
          <tbody>
            {[...ALPHABET].map((row) => (
              <tr key={row}>
                <th scope="row" className={keyLetter === row ? 'is-pick' : ''}>{row}</th>
                {[...ALPHABET].map((col) => (
                  <td key={col} className={`${keyLetter === row ? 'is-row' : ''} ${plainLetter === col ? 'is-col' : ''} ${entered && keyLetter === row && plainLetter === col ? 'is-hit' : ''}`}>{vigenereLetter(row, col)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.plain && rows.key ? (
        <div className="lw-cx-columns" role="group" aria-label="Klartext, Schlüssel und Geheimtext untereinander">
          {[...rows.plain].map((ch, index) => (
            <div key={index} className={`lw-cx-col ${focus === index ? 'is-focus' : ''}`}>
              <span aria-label="Klartext">{ch}</span>
              <span className="lw-cx-keyrow" aria-label="Schlüssel">{rows.key[index]}</span>
              <input data-vig={index} maxLength={1} className={`lw-cx-cell ${states[index] && states[index] !== 'open' ? `is-${states[index]}` : ''}`} aria-label={`Geheimtext, Position ${index + 1}`} value={cellText(data.answer[index]).toUpperCase()}
                onFocus={() => setFocus(index)} onChange={(event) => { const next = lastChar(event.target.value); if (!next || isLetter(next)) setLetter(index, next) }} />
            </div>
          ))}
        </div>
      ) : <p className="lw-hint">Gib Schlüssel und Klartext ein.</p>}
      <div className="lw-actions">
        <button type="button" className="secondary-button" disabled={!rows.key || !rows.plain} onClick={() => setChecked(true)}><Check size={14} /> Prüfen</button>
        <button type="button" className="secondary-button" disabled={!rows.key || !rows.plain} onClick={hint} title="Setzt genau einen Buchstaben ein: die markierte Stelle oder die nächste offene"><Lightbulb size={14} /> Hinweis</button>
        {checked && states.length > 0 && <span className="lw-hint">{states.filter((state) => state === 'ok').length} richtig, {states.filter((state) => state === 'bad').length} falsch, {states.filter((state) => state === 'open').length} offen.</span>}
      </div>
    </>
  )
}

// -- ASCII / XOR --------------------------------------------------------------------------------------

const XOR_ROWS: Array<[XorRow, string]> = [['p', 'Klartext (ASCII)'], ['k', 'Schlüssel (ASCII)'], ['c', 'Geheimtext']]

function XorTool({ data, onChange }: { data: XorData; onChange: (data: CryptoData) => void }) {
  const [checked, setChecked] = useState(false)
  const letters = useMemo(() => xorLetters(data.plain, data.key), [data.plain, data.key])
  const cells = useMemo(() => fitCells({ p: data.p, k: data.k, c: data.c }, letters.plain.length), [data.p, data.k, data.c, letters.plain.length])
  const commit = (next: { p: string[]; k: string[]; c: string[] }, patch: Partial<XorData> = {}) => { setChecked(false); onChange({ ...data, ...patch, ...next }) }
  const edit = (patch: Partial<XorData>) => {
    const next = xorLetters(patch.plain ?? data.plain, patch.key ?? data.key)
    commit(fitCells(cells, next.plain.length), patch)
  }
  const setBit = (row: XorRow, index: number, bit: number, value: string) => {
    const list = [...cells[row]]
    list[index] = setCharAt(list[index] ?? emptyBits(), bit, value, BITS)
    commit({ ...cells, [row]: list })
    if (value) window.setTimeout(() => document.querySelector<HTMLInputElement>(`[data-xor="${row}-${index}-${bit + 1}"]`)?.focus(), 0)
  }
  return (
    <>
      <div className="lw-cx-pair">
        <label className="lw-cx-field"><span>Klartext (Grossbuchstaben)</span><input value={data.plain} maxLength={CRYPTO_LIMITS.text} placeholder="z. B. GEGNERGREIFTAN" onChange={(event) => edit({ plain: event.target.value })} /></label>
        <label className="lw-cx-field"><span>Schlüssel</span><input value={data.key} maxLength={CRYPTO_LIMITS.key} placeholder="z. B. DEZEMBERMORGEN" onChange={(event) => edit({ key: event.target.value })} /></label>
      </div>
      <Rule>XOR bitweise: gleich → 0, verschieden → 1. Der Schlüssel wird über den Klartext wiederholt. Es werden höchstens {CRYPTO_LIMITS.rows} Buchstaben bearbeitet.</Rule>
      <details className="lw-cx-ascii"><summary>ASCII-Tabelle A bis Z (7 Bit)</summary>
        <ul>{[...ALPHABET].map((ch) => <li key={ch}><b>{ch}</b> {asciiBits(ch)}</li>)}</ul>
      </details>
      {letters.plain && letters.key ? (
        <div className="lw-cx-xor" role="group" aria-label="Bits je Buchstabe">
          {[...letters.plain].map((ch, index) => (
            <div key={index} className="lw-cx-xorcol">
              <div className="lw-cx-xorhead"><b>{ch}</b><span>{letters.key[index]}</span></div>
              {XOR_ROWS.map(([row, label]) => {
                const states = checked ? checkBitsRow(letters, cells, row, index) : []
                return (
                  <div key={row} className="lw-cx-bits" role="group" aria-label={`${label}, Buchstabe ${index + 1}`}>
                    <small>{label}</small>
                    <span>{Array.from({ length: BITS }, (_, bit) => (
                      <input key={bit} data-xor={`${row}-${index}-${bit}`} maxLength={1} inputMode="numeric" className={`lw-cx-cell is-bit ${states[bit] && states[bit] !== 'open' ? `is-${states[bit]}` : ''}`} aria-label={`${label}, Bit ${bit + 1}`}
                        value={cellText((cells[row][index] ?? '')[bit])} onChange={(event) => { const next = lastChar(event.target.value); if (!next || next === '0' || next === '1') setBit(row, index, bit, next) }} />
                    ))}</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      ) : <p className="lw-hint">Gib Klartext und Schlüssel ein.</p>}
      <div className="lw-actions">
        <button type="button" className="secondary-button" disabled={!letters.key || !letters.plain} onClick={() => setChecked(true)}><Check size={14} /> Prüfen</button>
        <button type="button" className="secondary-button" disabled={!letters.key || !letters.plain} onClick={() => commit(insertCodes(letters, cells))} title="Füllt nur die Zeilen Klartext (ASCII) und Schlüssel (ASCII) aus der Tabelle. Den Geheimtext rechnest du selbst."><Lightbulb size={14} /> Codes einsetzen</button>
      </div>
    </>
  )
}

// -- Modulo -------------------------------------------------------------------------------------------

const OPS: Array<[ModData['op'], string]> = [['*', 'a · b'], ['+', 'a + b'], ['^', 'a hoch b']]

function ModTool({ data, onChange }: { data: ModData; onChange: (data: CryptoData) => void }) {
  const problem = modProblem(data.op, data.a, data.b, data.m)
  const fields = modFields(data.op)
  const edit = (patch: Partial<ModData>) => onChange({ ...data, ...patch })
  const input = (key: 'a' | 'b' | 'm', label: string) => (
    <label className="lw-cx-field"><span>{label}</span><input inputMode="numeric" value={data[key]} onChange={(event) => edit({ [key]: digitsOnly(event.target.value) })} /></label>
  )
  return (
    <>
      <div className="lw-cx-modes" role="group" aria-label="Rechenart">
        {OPS.map(([op, label]) => <button key={op} type="button" className={`lw-chip ${data.op === op ? 'is-on' : ''}`} aria-pressed={data.op === op} onClick={() => edit({ op, s1: '', s2: '', s3: '', s4: '' })}>{label}</button>)}
      </div>
      <div className="lw-cx-pair is-three">{input('a', 'a')}{input('b', data.op === '^' ? 'b (Exponent)' : 'b')}{input('m', 'm (Modulus)')}</div>
      <ul className="lw-cx-rules" aria-label="Rechenregeln">{MOD_RULES.map((rule) => <li key={rule}>{rule}</li>)}</ul>
      {data.a && data.b && data.m && (
        <p className="lw-cx-task"><b>{data.op === '^' ? `${data.a} hoch ${data.b}` : `${data.a} ${data.op === '*' ? '·' : '+'} ${data.b}`} mod {data.m}</b></p>
      )}
      {problem ? <p className="lw-hint">{problem}</p> : (
        <div className="lw-cx-steps">
          {fields.map((field) => {
            const typed = data[field.key]
            const state = checkModField(data.op, data.a, data.b, data.m, field.key, typed)
            return (
              <label key={field.key} className="lw-cx-step"><span>{field.label} =</span>
                <input inputMode="numeric" className={state === 'open' ? '' : `is-${state}`} value={typed} onChange={(event) => edit({ [field.key]: digitsOnly(event.target.value, field.key === 's3' ? 400 : CRYPTO_LIMITS.number) })} />
                <Mark state={state} />
              </label>
            )
          })}
        </div>
      )}
    </>
  )
}

// -- Diffie-Hellman -----------------------------------------------------------------------------------

const DH_LABELS: Record<DhField, string> = { alpha: 'α = Y hoch A mod P', beta: 'β = Y hoch B mod P', sa: 's (Alice) = β hoch A mod P', sb: 's (Bob) = α hoch B mod P' }

function DhTool({ data, onChange }: { data: DhData; onChange: (data: CryptoData) => void }) {
  const [asked, setAsked] = useState<Partial<Record<DhField, boolean>>>({})
  const problems = dhProblems(data.y, data.p, data.a, data.b)
  const edit = (patch: Partial<DhData>) => { setAsked({}); onChange({ ...data, ...patch }) }
  const input = (key: 'y' | 'p' | 'a' | 'b', label: string) => (
    <label className="lw-cx-field"><span>{label}</span><input inputMode="numeric" value={data[key]} onChange={(event) => edit({ [key]: digitsOnly(event.target.value) })} /></label>
  )
  const agree = secretsAgree(data.sa, data.sb)
  const field = (key: DhField) => {
    const state = asked[key] ? checkDhField(data.y, data.p, data.a, data.b, key, data[key]) : 'open'
    return (
      <div className="lw-cx-step"><label><span>{DH_LABELS[key]}</span>
        <input inputMode="numeric" className={state === 'open' ? '' : `is-${state}`} value={data[key]} onChange={(event) => { setAsked({ ...asked, [key]: false }); onChange({ ...data, [key]: digitsOnly(event.target.value) }) }} />
      </label>
        <button type="button" className="secondary-button" disabled={!data[key].trim() || problems.length > 0} onClick={() => setAsked({ ...asked, [key]: true })}><Check size={14} /> Prüfen</button>
        <Mark state={state} />
      </div>
    )
  }
  return (
    <>
      <div className="lw-cx-pair is-four">{input('y', 'Y (öffentlich, kleiner als P)')}{input('p', 'P (öffentlich)')}{input('a', 'A (privat, Alice)')}{input('b', 'B (privat, Bob)')}</div>
      {data.y && data.p && data.a && data.b && problems.map((problem) => <p key={problem} className="lw-error" role="alert">{problem}</p>)}
      <div className="lw-cx-dh">
        <section aria-label="Alice"><h4>Alice</h4>{field('alpha')}{field('sa')}</section>
        <section aria-label="Bob"><h4>Bob</h4>{field('beta')}{field('sb')}</section>
      </div>
      <Rule>Alice schickt α an Bob, Bob schickt β an Alice. Beide rechnen dann den gemeinsamen Schlüssel s aus: s (Alice) und s (Bob) müssen gleich sein.</Rule>
      {agree === true && <p className="lw-notice" role="status">s (Alice) und s (Bob) sind gleich.</p>}
      {agree === false && <p className="lw-error" role="alert">s (Alice) und s (Bob) sind verschieden. Mindestens eine Rechnung enthält einen Fehler.</p>}
    </>
  )
}


export function CryptoEditor({ data, onChange }: Props) {
  return (
    <div className="lw-editor lw-cx">
      <TitleField data={data} onChange={onChange} />
      {data.tool === 'caesar' && <CaesarTool data={data} onChange={onChange} />}
      {data.tool === 'freq' && <FreqTool data={data} onChange={onChange} />}
      {data.tool === 'vigenere' && <VigenereTool data={data} onChange={onChange} />}
      {data.tool === 'xor' && <XorTool data={data} onChange={onChange} />}
      {data.tool === 'mod' && <ModTool data={data} onChange={onChange} />}
      {data.tool === 'dh' && <DhTool data={data} onChange={onChange} />}
    </div>
  )
}

