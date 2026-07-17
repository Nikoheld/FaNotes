import type { CategoryId, LabelDefinition } from '../types'

export const CATEGORIES: { id: CategoryId; label: string; shortLabel: string }[] = [
  { id: 'math', label: 'Mathematik', shortLabel: 'Mathe' },
  { id: 'digits', label: 'Zahlen', shortLabel: '0–9' },
  { id: 'uppercase', label: 'Großbuchstaben', shortLabel: 'A–Z' },
  { id: 'lowercase', label: 'Kleinbuchstaben', shortLabel: 'a–z' },
  { id: 'greek', label: 'Griechisch', shortLabel: 'α–ω' },
  { id: 'german', label: 'Deutsche Sonderzeichen', shortLabel: 'Ä Ö Ü' },
  { id: 'custom', label: 'Eigene Zeichen', shortLabel: 'Eigene' },
]

const math: LabelDefinition[] = [
  ['operator_plus', '+', 'Plus', '+'],
  ['operator_minus', '−', 'Minus', '-'],
  ['operator_multiply', '×', 'Mal', '\\times'],
  ['operator_dot', '·', 'Malpunkt', '\\cdot'],
  ['operator_divide', '÷', 'Geteilt', '\\div'],
  ['relation_equal', '=', 'Gleich', '='],
  ['relation_not_equal', '≠', 'Ungleich', '\\neq'],
  ['relation_less', '<', 'Kleiner als', '<'],
  ['relation_greater', '>', 'Größer als', '>'],
  ['relation_less_equal', '≤', 'Kleiner gleich', '\\leq'],
  ['relation_greater_equal', '≥', 'Größer gleich', '\\geq'],
  ['operator_plus_minus', '±', 'Plusminus', '\\pm'],
  ['relation_approx', '≈', 'Ungefähr gleich', '\\approx'],
  ['relation_equiv', '≡', 'Identisch gleich', '\\equiv'],
  ['symbol_infinity', '∞', 'Unendlich', '\\infty'],
  ['operator_sum', '∑', 'Summe', '\\sum'],
  ['operator_product', '∏', 'Produkt', '\\prod'],
  ['operator_integral', '∫', 'Integral', '\\int'],
  ['operator_double_integral', '∬', 'Doppelintegral', '\\iint'],
  ['operator_triple_integral', '∭', 'Dreifachintegral', '\\iiint'],
  ['operator_contour_integral', '∮', 'Kurvenintegral', '\\oint'],
  ['operator_big_union', '⋃', 'Große Vereinigung', '\\bigcup'],
  ['operator_big_intersection', '⋂', 'Großer Schnitt', '\\bigcap'],
  ['operator_sqrt', '√', 'Wurzel', '\\sqrt{}'],
  ['operator_partial', '∂', 'Partielle Ableitung', '\\partial'],
  ['operator_nabla', '∇', 'Nabla', '\\nabla'],
  ['operator_percent', '%', 'Prozent', '\\%'],
  ['operator_factorial', '!', 'Fakultät', '!'],
  ['operator_prime', '′', 'Ableitungsstrich', '\\prime'],
  ['symbol_degree', '°', 'Gradzeichen', '\\circ'],
  ['operator_slash', '/', 'Schrägstrich', '/'],
  ['operator_caret', '^', 'Hochzeichen', '^'],
  ['punctuation_underscore', '_', 'Unterstrich', '\\_'],
  ['decimal_point', '.', 'Dezimalpunkt', '.'],
  ['decimal_comma', ',', 'Dezimalkomma', ','],
  ['punctuation_colon', ':', 'Doppelpunkt', ':'],
  ['punctuation_semicolon', ';', 'Semikolon', ';'],
  ['punctuation_question', '?', 'Fragezeichen', '?'],
  ['punctuation_apostrophe', "'", 'Apostroph', "'"],
  ['punctuation_quote', '"', 'Anführungszeichen', '"'],
  ['absolute_bar', '|', 'Betragsstrich', '\\lvert'],
  ['relation_proportional', '∝', 'Proportional', '\\propto'],
  ['set_element', '∈', 'Element von', '\\in'],
  ['set_not_element', '∉', 'Kein Element von', '\\notin'],
  ['set_subset', '⊂', 'Teilmenge', '\\subset'],
  ['set_subset_equal', '⊆', 'Teilmenge gleich', '\\subseteq'],
  ['set_union', '∪', 'Vereinigung', '\\cup'],
  ['set_intersection', '∩', 'Schnittmenge', '\\cap'],
  ['set_empty', '∅', 'Leere Menge', '\\varnothing'],
  ['logic_forall', '∀', 'Für alle', '\\forall'],
  ['logic_exists', '∃', 'Es existiert', '\\exists'],
  ['logic_and', '∧', 'Logisches Und', '\\land'],
  ['logic_or', '∨', 'Logisches Oder', '\\lor'],
  ['logic_not', '¬', 'Logische Negation', '\\neg'],
  ['arrow_right', '→', 'Pfeil rechts', '\\rightarrow'],
  ['arrow_both', '↔', 'Pfeil beidseitig', '\\leftrightarrow'],
  ['arrow_implies', '⇒', 'Impliziert', '\\Rightarrow'],
  ['arrow_iff', '⇔', 'Genau dann wenn', '\\Leftrightarrow'],
  ['geometry_parallel', '∥', 'Parallel', '\\parallel'],
  ['geometry_perpendicular', '⊥', 'Senkrecht', '\\perp'],
  ['bracket_left_round', '(', 'Klammer links', '('],
  ['bracket_right_round', ')', 'Klammer rechts', ')'],
  ['bracket_left_square', '[', 'Eckige Klammer links', '['],
  ['bracket_right_square', ']', 'Eckige Klammer rechts', ']'],
  ['bracket_left_curly', '{', 'Geschweifte Klammer links', '\\{'],
  ['bracket_right_curly', '}', 'Geschweifte Klammer rechts', '\\}'],
].map(([id, char, name, latex]) => ({ id, char, name, latex, category: 'math' }))

const digits: LabelDefinition[] = Array.from({ length: 10 }, (_, value) => ({
  id: `digit_${value}`,
  char: String(value),
  name: `Ziffer ${value}`,
  latex: String(value),
  category: 'digits',
}))

const uppercase: LabelDefinition[] = Array.from({ length: 26 }, (_, index) => {
  const char = String.fromCharCode(65 + index)
  return {
    id: `latin_upper_${char}`,
    char,
    name: `Großes ${char}`,
    latex: char,
    category: 'uppercase',
  }
})

const lowercase: LabelDefinition[] = Array.from({ length: 26 }, (_, index) => {
  const char = String.fromCharCode(97 + index)
  return {
    id: `latin_lower_${char}`,
    char,
    name: `Kleines ${char.toUpperCase()}`,
    latex: char,
    category: 'lowercase',
  }
})

const german: LabelDefinition[] = [
  ['german_upper_A_umlaut', 'Ä', 'Großes Ä', '\\"A'],
  ['german_upper_O_umlaut', 'Ö', 'Großes Ö', '\\"O'],
  ['german_upper_U_umlaut', 'Ü', 'Großes Ü', '\\"U'],
  ['german_lower_a_umlaut', 'ä', 'Kleines Ä', '\\"a'],
  ['german_lower_o_umlaut', 'ö', 'Kleines Ö', '\\"o'],
  ['german_lower_u_umlaut', 'ü', 'Kleines Ü', '\\"u'],
].map(([id, char, name, latex]) => ({ id, char, name, latex, category: 'german' as const }))

const greekData = [
  ['alpha', 'α', 'Alpha', '\\alpha'],
  ['beta', 'β', 'Beta', '\\beta'],
  ['gamma', 'γ', 'Gamma', '\\gamma'],
  ['delta', 'δ', 'Delta', '\\delta'],
  ['epsilon', 'ε', 'Epsilon', '\\epsilon'],
  ['zeta', 'ζ', 'Zeta', '\\zeta'],
  ['eta', 'η', 'Eta', '\\eta'],
  ['theta', 'θ', 'Theta', '\\theta'],
  ['iota', 'ι', 'Iota', '\\iota'],
  ['kappa', 'κ', 'Kappa', '\\kappa'],
  ['lambda', 'λ', 'Lambda', '\\lambda'],
  ['mu', 'μ', 'My', '\\mu'],
  ['nu', 'ν', 'Ny', '\\nu'],
  ['xi', 'ξ', 'Xi', '\\xi'],
  ['omicron', 'ο', 'Omikron', 'o'],
  ['pi', 'π', 'Pi', '\\pi'],
  ['rho', 'ρ', 'Rho', '\\rho'],
  ['sigma', 'σ', 'Sigma', '\\sigma'],
  ['tau', 'τ', 'Tau', '\\tau'],
  ['upsilon', 'υ', 'Ypsilon', '\\upsilon'],
  ['phi', 'φ', 'Phi', '\\phi'],
  ['chi', 'χ', 'Chi', '\\chi'],
  ['psi', 'ψ', 'Psi', '\\psi'],
  ['omega', 'ω', 'Omega', '\\omega'],
  ['delta_upper', 'Δ', 'Großes Delta', '\\Delta'],
  ['lambda_upper', 'Λ', 'Großes Lambda', '\\Lambda'],
  ['omega_upper', 'Ω', 'Großes Omega', '\\Omega'],
].map(([slug, char, name, latex]) => ({
  id: `greek_${slug}`,
  char,
  name,
  latex,
  category: 'greek' as const,
}))

export const BASE_CATALOG: LabelDefinition[] = [
  ...math,
  ...digits,
  ...uppercase,
  ...lowercase,
  ...greekData,
  ...german,
]

export const DEFAULT_LABEL_ID = 'operator_integral'

export const categoryName = (id: CategoryId) =>
  CATEGORIES.find((category) => category.id === id)?.label ?? id
