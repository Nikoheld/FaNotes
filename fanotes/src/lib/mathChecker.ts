import nerdamer from 'nerdamer/all.min'
import { normalizeMathInput } from './mathSolverInput'

export type MathCheckLineStatus = 'start' | 'correct' | 'incorrect' | 'uncertain' | 'unreadable' | 'unchecked'

export type MathCheckLineResult = {
  index: number
  input: string
  normalizedInput?: string
  status: MathCheckLineStatus
  message: string
  highlight?: 'changed' | 'line'
}

export type MathCheckResult = {
  status: 'correct' | 'incorrect' | 'uncertain' | 'unreadable'
  lines: MathCheckLineResult[]
  errorLineIndex?: number
  message: string
  suggestion?: string
}

type EquivalenceResult = {
  equivalent: boolean | null
  message: string
  highlight?: 'changed' | 'line'
}

const MAX_STEPS = 20
const MAX_SOLUTIONS = 12
const CONSTANTS = new Set(['e', 'i', 'pi'])

const equationParts = (expression: string) => {
  const separator = expression.indexOf('=')
  return separator < 0 ? null : {
    left: expression.slice(0, separator),
    right: expression.slice(separator + 1),
  }
}

const residualFor = (expression: string) => {
  const parts = equationParts(expression)
  if (!parts?.left || !parts.right) throw new Error('Eine Gleichung benötigt links und rechts vom Gleichheitszeichen einen Ausdruck.')
  return nerdamer(`expand((${parts.left})-(${parts.right}))`).text('fractions')
}

const variablesFor = (expression: string) => nerdamer(expression).variables()
  .filter((variable) => !CONSTANTS.has(variable))
const isDomainSensitive = (expression: string) => /\/|sqrt\(|log\(|tan\(|asin\(|acos\(|factorial\(/u.test(expression)

const simplified = (expression: string) => nerdamer(`simplify(${expression})`).text('fractions')
const isZero = (expression: string) => simplified(expression) === '0'
const valueEquivalence = (left: string, right: string): boolean | null => {
  const difference = simplified(`(${left})-(${right})`)
  if (difference === '0') return true
  const variables = variablesFor(difference)
  const samples = [-3, -2, -1, 0, 1, 2, 3]
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    try {
      const substitutions = Object.fromEntries(variables.map((variable, index) => [
        variable,
        String(samples[(sampleIndex + index * 2) % samples.length]),
      ]))
      const evaluated = nerdamer(difference, substitutions).evaluate().text('fractions')
      if (!variablesFor(evaluated).length && !isZero(evaluated)) return false
    } catch {
      // Singular sample points are skipped; one valid counterexample is enough to disprove equivalence.
    }
  }
  return variables.length ? null : false
}
const sameValue = (left: string, right: string) => valueEquivalence(left, right) === true

const solutionsFor = (equation: string, variable: string) => {
  const values = nerdamer.solveEquations(equation, variable)
    .map((solution) => typeof solution === 'string' ? solution : solution.text('fractions'))
    .filter(Boolean)
    .filter((solution, index, all) => all.indexOf(solution) === index)
  return { values: values.slice(0, MAX_SOLUTIONS), complete: values.length <= MAX_SOLUTIONS }
}

const compareSolutionSets = (left: string[], right: string[]): boolean | null => {
  if (left.length !== right.length) return false
  const available = new Set(right.map((_, index) => index))
  let uncertain = false
  for (const solution of left) {
    let match = -1
    for (const index of available) {
      const comparison = valueEquivalence(solution, right[index])
      if (comparison === true) {
        match = index
        break
      }
      if (comparison === null) uncertain = true
    }
    if (match < 0) return uncertain ? null : false
    available.delete(match)
  }
  return true
}

const subsetSolutions = (left: string[], right: string[]) => left.every((solution) => (
  right.some((candidate) => sameValue(solution, candidate))
))

const equationEquivalence = (previous: string, current: string): EquivalenceResult => {
  const previousResidual = residualFor(previous)
  const currentResidual = residualFor(current)
  const previousZero = isZero(previousResidual)
  const currentZero = isZero(currentResidual)
  if (previousZero || currentZero) {
    if (isDomainSensitive(previous) || isDomainSensitive(current)) {
      return {
        equivalent: null,
        message: 'Die Umformung enthält Definitionslücken; ohne explizite Definitionsmenge wird sie nicht automatisch als richtig oder falsch markiert.',
      }
    }
    return previousZero === currentZero
      ? { equivalent: true, message: 'Beide Zeilen sind für alle Variablen wahr.' }
      : { equivalent: false, message: 'Der Schritt verändert eine allgemeingültige Gleichung.' }
  }

  const variables = [...new Set([
    ...variablesFor(previousResidual),
    ...variablesFor(currentResidual),
  ])].sort()
  if (!variables.length) {
    // Both non-zero constant residuals describe contradictions and are therefore logically equivalent.
    return { equivalent: true, message: 'Beide Zeilen sind widersprüchliche Zahlengleichungen.' }
  }

  try {
    const ratio = nerdamer(`simplify((${currentResidual})/(${previousResidual}))`)
    if (!ratio.variables().length && !isZero(ratio.text('fractions'))) {
      return { equivalent: true, message: 'Auf beiden Seiten wurde dieselbe zulässige Umformung ausgeführt.' }
    }
  } catch {
    // Solution-set comparison below is the safer fallback.
  }

  if (variables.length === 1) {
    try {
      const variable = variables[0]
      const previousSolutions = solutionsFor(previous, variable)
      const currentSolutions = solutionsFor(current, variable)
      if (!previousSolutions.complete || !currentSolutions.complete) {
        return {
          equivalent: null,
          message: `Die Lösungsmenge für ${variable} ist zu groß, um sie lokal vollständig und sicher zu vergleichen.`,
        }
      }
      if (previousSolutions.values.length || currentSolutions.values.length) {
        const equivalent = compareSolutionSets(previousSolutions.values, currentSolutions.values)
        if (equivalent === null) {
          return {
            equivalent: null,
            message: `Einzelne symbolische Lösungen für ${variable} konnten nicht beweissicher verglichen werden.`,
          }
        }
        const lostOrAddedSolutions = equivalent === false && (
          subsetSolutions(previousSolutions.values, currentSolutions.values)
          || subsetSolutions(currentSolutions.values, previousSolutions.values)
        )
        return equivalent
          ? { equivalent: true, message: `Die Lösungsmenge für ${variable} bleibt unverändert.` }
          : {
              equivalent: false,
              message: `Die Lösungsmenge für ${variable} ändert sich in diesem Schritt${lostOrAddedSolutions ? '; dabei geht mindestens eine Lösung verloren oder kommt unzulässig hinzu' : ''}.`,
              highlight: lostOrAddedSolutions ? 'line' : 'changed',
            }
      }
    } catch {
      // Some transcendental or piecewise equations cannot be exhaustively solved by the local CAS.
    }
  }

  if (variables.length > 1) {
    return {
      equivalent: null,
      message: 'Diese mehrvariable Umformung ist nicht proportional; FaNotes markiert sie ohne sicheren Beweis nicht als falsch.',
    }
  }
  return {
    equivalent: null,
    message: 'Die Gleichungen konnten lokal weder als äquivalent bewiesen noch durch vollständige Lösung sicher widerlegt werden.',
  }
}

const transitionEquivalence = (previous: string, current: string): EquivalenceResult => {
  const previousEquation = equationParts(previous)
  const currentEquation = equationParts(current)
  if (Boolean(previousEquation) !== Boolean(currentEquation)) {
    return {
      equivalent: false,
      message: 'Hier wechselt der Rechenweg ohne gültige Begründung zwischen Term und Gleichung.',
      highlight: 'line',
    }
  }
  if (previousEquation && currentEquation) return equationEquivalence(previous, current)
  const equivalent = valueEquivalence(previous, current)
  return equivalent === true
    ? { equivalent: true, message: 'Der Term behält denselben Wert.' }
    : equivalent === false
      ? { equivalent: false, message: 'Ein Gegenbeispiel beweist, dass der neue Term nicht gleichwertig ist.', highlight: 'changed' }
      : { equivalent: null, message: 'Die Termgleichheit konnte lokal nicht beweissicher entschieden werden.' }
}

const suggestionFor = (expression: string) => {
  const parts = equationParts(expression)
  if (!parts) {
    const value = simplified(expression)
    return value === expression ? undefined : value
  }
  const variables = [...new Set(variablesFor(residualFor(expression)))]
  if (variables.length !== 1) return undefined
  try {
    const solutions = solutionsFor(expression, variables[0])
    if (!solutions.complete || !solutions.values.length || solutions.values.length > 4) return undefined
    return solutions.values.map((solution) => `${variables[0]}=${solution}`).join(' oder ')
  } catch {
    return undefined
  }
}

export const checkMathSteps = (inputs: string[]): MathCheckResult => {
  if (!Array.isArray(inputs) || inputs.length < 2) {
    return {
      status: 'uncertain',
      lines: (inputs ?? []).map((input, index) => ({ index, input, status: index ? 'unchecked' : 'start', message: '' })),
      message: 'Wähle mindestens zwei untereinander geschriebene Rechenschritte aus.',
    }
  }
  if (inputs.length > MAX_STEPS) throw new Error(`Wähle höchstens ${MAX_STEPS} Rechenschritte auf einmal aus.`)

  const results: MathCheckLineResult[] = inputs.map((input, index) => ({
    index,
    input,
    status: index === 0 ? 'start' : 'unchecked',
    message: index === 0 ? 'Ausgangszeile' : 'Noch nicht geprüft',
  }))
  const normalized: string[] = []
  for (let index = 0; index < inputs.length; index += 1) {
    try {
      const value = normalizeMathInput(inputs[index])
      const parts = equationParts(value)
      if (parts) {
        nerdamer(parts.left)
        nerdamer(parts.right)
      } else {
        nerdamer(value)
      }
      normalized.push(value)
      results[index].normalizedInput = value
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Diese Zeile konnte nicht als Mathematik gelesen werden.'
      results[index] = { ...results[index], status: 'unreadable', message }
      return {
        status: 'unreadable',
        lines: results,
        errorLineIndex: index,
        message: `Schritt ${index + 1} muss zuerst geprüft oder korrigiert werden: ${message}`,
      }
    }
  }

  for (let index = 1; index < normalized.length; index += 1) {
    const comparison = transitionEquivalence(normalized[index - 1], normalized[index])
    if (comparison.equivalent === true) {
      results[index] = { ...results[index], status: 'correct', message: comparison.message }
      continue
    }
    if (comparison.equivalent === null) {
      results[index] = { ...results[index], status: 'uncertain', message: comparison.message }
      return {
        status: 'uncertain',
        lines: results,
        errorLineIndex: index,
        message: `Schritt ${index + 1} konnte nicht beweissicher bewertet werden.`,
      }
    }
    results[index] = {
      ...results[index],
      status: 'incorrect',
      message: comparison.message,
      highlight: comparison.highlight ?? 'changed',
    }
    const suggestion = suggestionFor(normalized[index - 1])
    return {
      status: 'incorrect',
      lines: results,
      errorLineIndex: index,
      message: `Der erste sichere Fehler liegt im Übergang zu Schritt ${index + 1}. ${comparison.message}`,
      suggestion,
    }
  }

  return {
    status: 'correct',
    lines: results,
    message: `Alle ${inputs.length - 1} Übergänge sind algebraisch äquivalent.`,
  }
}
