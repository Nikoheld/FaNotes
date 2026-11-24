// LaTeX math -> Office Math Markup Language (OMML), so Word and LibreOffice show real, editable equations.
// It covers the constructs notes use (fractions, scripts, roots, Greek, operators, big operators with limits,
// \left \right, \text, accents, matrices and cases). Anything it does not know is kept as literal LaTeX text,
// and a formula that cannot be parsed at all becomes one linear run, so conversion never throws.

export const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math'

type Style = 'p' | 'b' | 'bi' | 'nor' | 'i'
type Nodes = N[]
type N =
  | { t: 'ch'; s: string; sty?: Style }
  | { t: 'frac'; n: Nodes; d: Nodes; bar: boolean }
  | { t: 'script'; base: Nodes; sub?: Nodes; sup?: Nodes }
  | { t: 'rad'; deg?: Nodes; e: Nodes }
  | { t: 'delim'; l: string; r: string; e: Nodes }
  | { t: 'nary'; chr: string; sub?: Nodes; sup?: Nodes; e: Nodes }
  | { t: 'limfn'; name: string; sub?: Nodes; sup?: Nodes }
  | { t: 'matrix'; rows: Nodes[][] }
  | { t: 'eqarr'; rows: Nodes[] }
  | { t: 'acc'; chr: string; e: Nodes }
  | { t: 'bar'; e: Nodes; pos: 'top' | 'bot' }
  | { t: 'group'; e: Nodes }

const esc = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ',
  sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
}

const SYMBOLS: Record<string, string> = {
  cdot: '⋅', times: '×', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘', bullet: '∙', ltimes: '⋉', rtimes: '⋊',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝',
  ll: '≪', gg: '≫', prec: '≺', succ: '≻', preceq: '⪯', succeq: '⪰', doteq: '≐',
  infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', nexists: '∄', in: '∈', notin: '∉', ni: '∋',
  subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇', nsubseteq: '⊈', cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅',
  to: '→', rightarrow: '→', leftarrow: '←', gets: '←', Rightarrow: '⇒', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔', iff: '⇔',
  implies: '⇒', mapsto: '↦', uparrow: '↑', downarrow: '↓', longrightarrow: '⟶', longleftarrow: '⟵', Longrightarrow: '⟹', hookrightarrow: '↪',
  ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', angle: '∠', perp: '⊥', parallel: '∥', mid: '∣', degree: '°',
  neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨', oplus: '⊕', otimes: '⊗', odot: '⊙', top: '⊤', bot: '⊥', vdash: '⊢', models: '⊨',
  prime: '′', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', wp: '℘', imath: 'ı', jmath: 'ȷ', therefore: '∴', because: '∵',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', lbrace: '{', rbrace: '}', lbrack: '[', rbrack: ']', vert: '|', Vert: '‖',
  triangle: '△', square: '□', checkmark: '✓', dag: '†', ddag: '‡', S: '§', P: '¶', copyright: '©',
}

const ESCAPED = new Set(['{', '}', '%', '$', '&', '#', '_', '|'])
const SPACES: Record<string, string> = { ',': ' ', ';': ' ', ':': ' ', ' ': ' ', quad: ' ', qquad: '  ', '!': '' }

const NARY: Record<string, string> = {
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮', bigcup: '⋃', bigcap: '⋂', bigvee: '⋁', bigwedge: '⋀',
  bigoplus: '⨁', bigotimes: '⨂', biguplus: '⨄',
}
const LIMIT_FUNCTIONS = new Set(['lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf', 'argmax', 'argmin', 'det', 'gcd', 'Pr'])
const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp', 'dim', 'ker', 'deg', 'hom', 'arg', 'mod', 'Re', 'Im'])
const ACCENTS: Record<string, string> = {
  hat: '̂', widehat: '̂', tilde: '̃', widetilde: '̃', vec: '⃗', dot: '̇', ddot: '̈', check: '̌',
  acute: '́', grave: '̀', breve: '̆', bar: '̄', mathring: '̊', overrightarrow: '⃗',
}
const BLACKBOARD: Record<string, string> = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', H: 'ℍ', E: '𝔼', F: '𝔽', K: '𝕂', '1': '𝟙' }
const ENVIRONMENTS: Record<string, [string, string] | null> = {
  matrix: null, pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], smallmatrix: null,
}
const ARRAY_LIKE = new Set(['aligned', 'align', 'align*', 'alignat', 'gather', 'gather*', 'split', 'eqnarray', 'multline', 'equation', 'equation*', 'gathered'])

type Token = { k: 'cmd' | 'ch' | 'open' | 'close' | 'sup' | 'sub' | 'amp' | 'nl'; v: string }

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  for (let i = 0; i < source.length;) {
    const c = source[i]
    if (c === '\\') {
      const name = /^[A-Za-z]+/u.exec(source.slice(i + 1))?.[0]
      if (name) {
        tokens.push({ k: 'cmd', v: name })
        i += 1 + name.length
      } else if (source[i + 1] === '\\') { tokens.push({ k: 'nl', v: '\\\\' }); i += 2 } else if (i + 1 < source.length) {
        const next = String.fromCodePoint(source.codePointAt(i + 1)!)
        tokens.push({ k: 'cmd', v: next })
        i += 1 + next.length
      } else i += 1
    } else if (c === '{') { tokens.push({ k: 'open', v: c }); i += 1 } else if (c === '}') { tokens.push({ k: 'close', v: c }); i += 1 } else if (c === '^') { tokens.push({ k: 'sup', v: c }); i += 1 } else if (c === '_') { tokens.push({ k: 'sub', v: c }); i += 1 } else if (c === '&') { tokens.push({ k: 'amp', v: c }); i += 1 } else if (/\s/u.test(c)) i += 1
    else {
      const ch = String.fromCodePoint(source.codePointAt(i)!)
      tokens.push({ k: 'ch', v: ch })
      i += ch.length
    }
  }
  return tokens
}

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  private peek() { return this.tokens[this.pos] }

  /** Parses atoms until a closer; `stop` decides whether a token ends the sequence. */
  seq(stop: (token: Token) => boolean, style?: Style): Nodes {
    const out: Nodes = []
    while (this.pos < this.tokens.length) {
      const token = this.peek()
      if (stop(token)) break
      if (token.k === 'close') { this.pos += 1; continue }
      const atom = this.atomWithScripts(style)
      if (atom) out.push(...atom)
    }
    return out
  }

  private atomWithScripts(style?: Style): Nodes | null {
    const base = this.atom(style)
    if (!base) return null
    // Big operators and limit functions keep their scripts as limits.
    const first = base[0]
    let sub: Nodes | undefined
    let sup: Nodes | undefined
    for (;;) {
      const next = this.peek()
      if (next?.k === 'sub' && !sub) { this.pos += 1; sub = this.argument(style) } else if (next?.k === 'sup' && !sup) { this.pos += 1; sup = this.argument(style) } else break
    }
    if (base.length === 1 && first.t === 'nary') {
      first.sub = sub
      first.sup = sup
      first.e = this.naryBody(style)
      return base
    }
    if (base.length === 1 && first.t === 'limfn') {
      first.sub = sub
      first.sup = sup
      return base
    }
    if (!sub && !sup) return base
    return [{ t: 'script', base: base.length === 1 ? base : [{ t: 'group', e: base }], sub, sup }]
  }

  /** The operand of a big operator: the following atoms up to the next relation or sum sign. */
  private naryBody(style?: Style): Nodes {
    const body: Nodes = []
    let depth = 0
    while (this.pos < this.tokens.length) {
      const token = this.peek()
      if (token.k === 'close' || token.k === 'amp' || token.k === 'nl') break
      if (token.k === 'cmd' && (token.v === 'right' || token.v === 'end')) break
      if (token.k === 'ch' && depth === 0 && body.length && /[+\-=<>,;±∓≤≥≠≈]/u.test(token.v)) break
      if (token.k === 'cmd' && depth === 0 && body.length && ['leq', 'le', 'geq', 'ge', 'neq', 'ne', 'approx', 'equiv', 'pm', 'mp', 'to', 'quad', 'qquad'].includes(token.v)) break
      if (token.k === 'ch' && token.v === '(') depth += 1
      if (token.k === 'ch' && token.v === ')') depth = Math.max(0, depth - 1)
      const atom = this.atomWithScripts(style)
      if (atom) body.push(...atom)
    }
    return body
  }

  /** `{...}` or one token. */
  private argument(style?: Style): Nodes {
    const token = this.peek()
    if (!token) return []
    if (token.k === 'open') {
      this.pos += 1
      const inner = this.seq((t) => t.k === 'close', style)
      if (this.peek()?.k === 'close') this.pos += 1
      return inner
    }
    // An unbraced argument is one token (`x^2_i` scripts belong to the outer atom).
    return this.atom(style) ?? []
  }

  private raw(): string {
    // Text of a braced group (for \text, \operatorname, \begin{name}).
    const token = this.peek()
    if (!token) return ''
    if (token.k !== 'open') { this.pos += 1; return token.v }
    this.pos += 1
    let depth = 1
    let text = ''
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos]
      this.pos += 1
      if (t.k === 'open') depth += 1
      else if (t.k === 'close') { depth -= 1; if (depth === 0) break } else if (t.k === 'cmd') text += SPACES[t.v] ?? (t.v.length === 1 ? t.v : GREEK[t.v] ?? SYMBOLS[t.v] ?? t.v)
      else text += t.v
    }
    return text
  }

  private delimiter(): string {
    const token = this.peek()
    if (!token) return ''
    this.pos += 1
    if (token.k === 'ch') return token.v === '.' ? '' : token.v
    if (token.k === 'cmd') {
      if (token.v === '{' || token.v === '}' || token.v === '|') return token.v
      return SYMBOLS[token.v] ?? ''
    }
    if (token.k === 'open') return '{'
    if (token.k === 'close') return '}'
    return ''
  }

  private atom(style?: Style): Nodes | null {
    const token = this.peek()
    if (!token) return null
    this.pos += 1
    switch (token.k) {
      case 'ch': return [{ t: 'ch', s: token.v, sty: style }]
      case 'open': {
        const inner = this.seq((t) => t.k === 'close', style)
        if (this.peek()?.k === 'close') this.pos += 1
        return [{ t: 'group', e: inner }]
      }
      case 'sup': case 'sub': return [{ t: 'ch', s: token.v, sty: 'nor' }]
      case 'amp': case 'nl': return null
      case 'cmd': return this.command(token.v, style)
      default: return null
    }
  }

  private command(name: string, style?: Style): Nodes | null {
    if (GREEK[name]) return [{ t: 'ch', s: GREEK[name], sty: style }]
    if (NARY[name]) return [{ t: 'nary', chr: NARY[name], e: [] }]
    if (LIMIT_FUNCTIONS.has(name) && name !== 'det' && name !== 'gcd' && name !== 'Pr') return [{ t: 'limfn', name }]
    if (FUNCTIONS.has(name) || name === 'det' || name === 'gcd' || name === 'Pr') return [{ t: 'ch', s: name, sty: 'p' }]
    if (SYMBOLS[name]) return [{ t: 'ch', s: SYMBOLS[name], sty: style === 'nor' ? 'nor' : undefined }]
    if (name in SPACES) return SPACES[name] ? [{ t: 'ch', s: SPACES[name], sty: 'nor' }] : null
    if (name.length === 1 && ESCAPED.has(name)) return [{ t: 'ch', s: name, sty: style }]
    switch (name) {
      case 'frac': case 'dfrac': case 'tfrac': case 'cfrac': {
        const n = this.argument(style)
        const d = this.argument(style)
        return [{ t: 'frac', n, d, bar: true }]
      }
      case 'binom': case 'dbinom': case 'tbinom': {
        const n = this.argument(style)
        const d = this.argument(style)
        return [{ t: 'delim', l: '(', r: ')', e: [{ t: 'frac', n, d, bar: false }] }]
      }
      case 'sqrt': {
        let deg: Nodes | undefined
        const next = this.peek()
        if (next?.k === 'ch' && next.v === '[') {
          this.pos += 1
          deg = this.seq((t) => t.k === 'ch' && t.v === ']', style)
          if (this.peek()?.k === 'ch') this.pos += 1
        }
        return [{ t: 'rad', deg, e: this.argument(style) }]
      }
      case 'left': {
        const l = this.delimiter()
        const e = this.seq((t) => t.k === 'cmd' && t.v === 'right', style)
        let r = ''
        if (this.peek()?.k === 'cmd' && this.peek().v === 'right') { this.pos += 1; r = this.delimiter() }
        return [{ t: 'delim', l, r, e }]
      }
      case 'right': return null
      case 'bigl': case 'bigr': case 'Bigl': case 'Bigr': case 'biggl': case 'biggr': case 'big': case 'Big': case 'bigg': case 'Bigg': case 'displaystyle': case 'textstyle': case 'scriptstyle': case 'limits': case 'nolimits': case 'mathbin': case 'mathrel': case 'mathop': case 'middle': case 'allowbreak': case 'strut': case 'nonumber': case 'notag':
        return null
      case 'text': case 'mbox': case 'textrm': case 'textnormal': case 'textsf': case 'textit': case 'textbf': case 'hbox': return [{ t: 'ch', s: this.raw(), sty: 'nor' }]
      case 'operatorname': case 'mathrm': case 'rm': case 'mathsf': case 'mathtt': case 'mathit': {
        const next = this.peek()
        if (name === 'operatorname' || next?.k !== 'open') return [{ t: 'ch', s: this.raw(), sty: 'p' }]
        return [{ t: 'group', e: this.argument('p') }]
      }
      case 'mathbf': case 'boldsymbol': case 'bm': case 'bf': return [{ t: 'group', e: this.argument('b') }]
      case 'mathbb': {
        const raw = this.raw()
        return [{ t: 'ch', s: [...raw].map((letter) => BLACKBOARD[letter] ?? letter).join('') }]
      }
      case 'mathcal': case 'mathscr': case 'mathfrak': case 'cal': return [{ t: 'group', e: this.argument(style) }]
      case 'overline': return [{ t: 'bar', e: this.argument(style), pos: 'top' }]
      case 'underline': return [{ t: 'bar', e: this.argument(style), pos: 'bot' }]
      case 'overbrace': case 'underbrace': case 'overset': case 'underset': case 'stackrel': case 'phantom': case 'vphantom': case 'hphantom': case 'boxed': case 'cancel': case 'color': {
        if (name === 'color') { this.raw(); return null }
        if (name === 'overset' || name === 'underset' || name === 'stackrel') this.argument(style)
        return [{ t: 'group', e: this.argument(style) }]
      }
      case 'begin': return this.environment(style)
      case 'end': this.raw(); return null
      case 'not': return [{ t: 'ch', s: '̸', sty: 'nor' }]
      default:
        if (ACCENTS[name]) return [{ t: 'acc', chr: ACCENTS[name], e: this.argument(style) }]
        // Unknown command: keep it visible as literal LaTeX instead of dropping it.
        return [{ t: 'ch', s: `\\${name}`, sty: 'nor' }]
    }
  }

  private environment(style?: Style): Nodes {
    const name = this.raw()
    if (name === 'array' || name === 'subarray') this.raw()
    const rows: Nodes[][] = [[]]
    let cell: Nodes = []
    const endCell = () => { rows[rows.length - 1].push(cell); cell = [] }
    while (this.pos < this.tokens.length) {
      const token = this.peek()
      if (token.k === 'cmd' && token.v === 'end') { this.pos += 1; this.raw(); break }
      if (token.k === 'amp') { this.pos += 1; endCell(); continue }
      if (token.k === 'nl') { this.pos += 1; endCell(); rows.push([]); continue }
      if (token.k === 'close') { this.pos += 1; continue }
      const atom = this.atomWithScripts(style)
      if (atom) cell.push(...atom)
    }
    endCell()
    const filled = rows.filter((row, index) => index < rows.length - 1 || row.some((c) => c.length))
    if (name === 'cases' || name === 'dcases' || name === 'rcases') {
      const eq: Nodes = [{ t: 'eqarr', rows: filled.map((row) => joinCells(row, ' ')) }]
      return name === 'rcases' ? [{ t: 'delim', l: '', r: '}', e: eq }] : [{ t: 'delim', l: '{', r: '', e: eq }]
    }
    if (ARRAY_LIKE.has(name)) return [{ t: 'eqarr', rows: filled.map((row) => joinCells(row, '')) }]
    const fence = ENVIRONMENTS[name]
    const matrix: N = { t: 'matrix', rows: filled.length ? filled : [[[]]] }
    return fence ? [{ t: 'delim', l: fence[0], r: fence[1], e: [matrix] }] : [matrix]
  }
}

const joinCells = (cells: Nodes[], gap: string): Nodes => cells.flatMap((cell, index) => (index && gap ? [{ t: 'ch', s: gap, sty: 'nor' } as N, ...cell] : cell))

// ── emitter ────────────────────────────────────────────────────────────────────────────────

const FONT = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math" w:eastAsia="Cambria Math" w:cs="Cambria Math"/></w:rPr>'

const run = (text: string, style?: Style) => {
  if (!text) return ''
  const props = style === 'p' ? '<m:rPr><m:sty m:val="p"/></m:rPr>'
    : style === 'b' ? '<m:rPr><m:sty m:val="b"/></m:rPr>'
      : style === 'bi' ? '<m:rPr><m:sty m:val="bi"/></m:rPr>'
        : style === 'nor' ? '<m:rPr><m:nor/></m:rPr>' : ''
  return `<m:r>${props}${FONT}<m:t xml:space="preserve">${esc(text)}</m:t></m:r>`
}

const wrapArg = (tag: string, nodes: Nodes | undefined) => `<m:${tag}>${emit(nodes ?? [])}</m:${tag}>`

function emit(nodes: Nodes): string {
  let out = ''
  let pending = ''
  let pendingStyle: Style | undefined
  const flush = () => { out += run(pending, pendingStyle); pending = '' }
  for (const node of nodes) {
    if (node.t === 'ch') {
      if (pending && node.sty !== pendingStyle) flush()
      pendingStyle = node.sty
      pending += node.s
      continue
    }
    flush()
    switch (node.t) {
      case 'group': out += emit(node.e); break
      case 'frac': out += `<m:f>${node.bar ? '' : '<m:fPr><m:type m:val="noBar"/></m:fPr>'}${wrapArg('num', node.n)}${wrapArg('den', node.d)}</m:f>`; break
      case 'script': {
        const base = wrapArg('e', node.base)
        if (node.sub && node.sup) out += `<m:sSubSup>${base}${wrapArg('sub', node.sub)}${wrapArg('sup', node.sup)}</m:sSubSup>`
        else if (node.sub) out += `<m:sSub>${base}${wrapArg('sub', node.sub)}</m:sSub>`
        else out += `<m:sSup>${base}${wrapArg('sup', node.sup)}</m:sSup>`
        break
      }
      case 'rad': out += `<m:rad><m:radPr>${node.deg ? '' : '<m:degHide m:val="1"/>'}</m:radPr>${wrapArg('deg', node.deg)}${wrapArg('e', node.e)}</m:rad>`; break
      case 'delim': out += `<m:d><m:dPr><m:begChr m:val="${esc(node.l)}"/><m:endChr m:val="${esc(node.r)}"/></m:dPr>${wrapArg('e', node.e)}</m:d>`; break
      case 'nary': {
        const hidden = `${node.sub ? '' : '<m:subHide m:val="1"/>'}${node.sup ? '' : '<m:supHide m:val="1"/>'}`
        const limits = ['∑', '∏', '∐', '⋃', '⋂', '⋁', '⋀', '⨁', '⨂', '⨄'].includes(node.chr) ? 'undOvr' : 'subSup'
        out += `<m:nary><m:naryPr><m:chr m:val="${node.chr}"/><m:limLoc m:val="${limits}"/>${hidden}</m:naryPr>${wrapArg('sub', node.sub)}${wrapArg('sup', node.sup)}${wrapArg('e', node.e)}</m:nary>`
        break
      }
      case 'limfn': {
        const name = `<m:e>${run(node.name, 'p')}</m:e>`
        if (node.sub && node.sup) out += `<m:sSubSup>${name}${wrapArg('sub', node.sub)}${wrapArg('sup', node.sup)}</m:sSubSup>`
        else if (node.sub) out += `<m:limLow>${name}${wrapArg('lim', node.sub)}</m:limLow>`
        else if (node.sup) out += `<m:limUpp>${name}${wrapArg('lim', node.sup)}</m:limUpp>`
        else out += run(node.name, 'p')
        break
      }
      case 'matrix': {
        const columns = Math.max(1, ...node.rows.map((row) => row.length))
        const rows = node.rows.map((row) => `<m:mr>${Array.from({ length: columns }, (_, i) => wrapArg('e', row[i] ?? [])).join('')}</m:mr>`).join('')
        out += `<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="${columns}"/><m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs></m:mPr>${rows}</m:m>`
        break
      }
      case 'eqarr': out += `<m:eqArr>${node.rows.map((row) => wrapArg('e', row)).join('')}</m:eqArr>`; break
      case 'acc': out += `<m:acc><m:accPr><m:chr m:val="${node.chr}"/></m:accPr>${wrapArg('e', node.e)}</m:acc>`; break
      case 'bar': out += `<m:bar><m:barPr><m:pos m:val="${node.pos}"/></m:barPr>${wrapArg('e', node.e)}</m:bar>`; break
    }
  }
  flush()
  return out
}

/** The OMML content (runs and structures) of a LaTeX formula, without the `m:oMath` wrapper. */
export function latexToOmmlContent(latex: string): string {
  try {
    const parser = new Parser(tokenize(latex))
    const nodes = parser.seq(() => false)
    const xml = emit(nodes)
    if (xml) return xml
  } catch {
    // Falls through to the linear text.
  }
  return run(latex.trim(), 'nor')
}

/** An inline equation for a Word paragraph. */
export const latexToOmml = (latex: string) => `<m:oMath>${latexToOmmlContent(latex)}</m:oMath>`

/** A display equation: a paragraph-level `m:oMathPara` (put it inside a `w:p`). */
export const latexToOmmlPara = (latex: string) => `<m:oMathPara><m:oMath>${latexToOmmlContent(latex)}</m:oMath></m:oMathPara>`
