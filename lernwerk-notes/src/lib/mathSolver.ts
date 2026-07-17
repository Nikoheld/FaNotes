import nerdamer from 'nerdamer/all.min'
import { MATH_SOLVER_MAX_VARIABLES, normalizeMathInput } from './mathSolverInput'

export { normalizeMathInput } from './mathSolverInput'

export type MathSolverAction = 'simplify' | 'solve' | 'expand' | 'factor' | 'calculate'

export type MathSolutionStep = {
  expression: string
  display: string
  latex: string
  kind: 'intermediate' | 'result'
}

export type MathSolverResult = {
  action: MathSolverAction
  input: string
  normalizedInput: string
  inputLatex: string
  variables: string[]
  variable?: string
  steps: MathSolutionStep[]
}

const MAX_SOLUTIONS = 8
const CONSTANTS = new Set(['e', 'i', 'pi'])

const expressionVariables = (expression: string) => {
  const variables = nerdamer(expression).variables()
    .filter((variable) => !CONSTANTS.has(variable))
    .filter((variable) => /^[A-Za-z][A-Za-z0-9_]{0,15}$/u.test(variable))
  if (variables.length > MATH_SOLVER_MAX_VARIABLES) throw new Error('Der Ausdruck enthält zu viele verschiedene Variablen.')
  return [...new Set(variables)].sort((left, right) => left === 'x' ? -1 : right === 'x' ? 1 : left.localeCompare(right))
}

const equationParts = (expression: string) => {
  const index = expression.indexOf('=')
  return index < 0
    ? null
    : { left: expression.slice(0, index), right: expression.slice(index + 1) }
}

const balancedVectorItems = (value: string) => {
  const content = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  const items: string[] = []
  let start = 0
  let depth = 0
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      items.push(content.slice(start, index))
      start = index + 1
    }
  }
  items.push(content.slice(start))
  return items.map((item) => item.trim())
}

const mathDisplay = (value: string) => value
  .replace(/\*/gu, '·')
  .replace(/sqrt\(([^()]*)\)/gu, '√($1)')
  .replace(/\+-/gu, '−')
  .replace(/-/gu, '−')

const latexFor = (expression: string) => {
  const parts = equationParts(expression)
  if (parts) return `${nerdamer(parts.left).toTeX()}=${nerdamer(parts.right).toTeX()}`
  return nerdamer(expression).toTeX()
}

const stepFor = (expression: string, kind: MathSolutionStep['kind']): MathSolutionStep => ({
  expression,
  display: mathDisplay(expression),
  latex: latexFor(expression),
  kind,
})

const transformBothSides = (
  expression: string,
  transform: (value: string) => nerdamer.Expression,
) => {
  const parts = equationParts(expression)
  if (!parts) return transform(expression).text('fractions')
  return `${transform(parts.left).text('fractions')}=${transform(parts.right).text('fractions')}`
}

const solveEquation = (expression: string, requestedVariable?: string) => {
  const variables = expressionVariables(expression)
  const variable = requestedVariable || variables[0]
  if (!variable || !variables.includes(variable)) throw new Error('Wähle eine Variable aus, nach der die Gleichung gelöst werden soll.')
  const parts = equationParts(expression)
  const equation = parts ? expression : `${expression}=0`
  const equationSides = equationParts(equation)!
  const zeroExpression = nerdamer(`expand((${equationSides.left})-(${equationSides.right}))`).text('fractions')
  const rawSolutions = nerdamer.solveEquations(equation, variable)
  const solutionTexts = rawSolutions
    .map((solution) => typeof solution === 'string' ? solution : solution.text('fractions'))
    .filter(Boolean)
    .filter((solution, index, all) => all.indexOf(solution) === index)
    .slice(0, MAX_SOLUTIONS)
  if (!solutionTexts.length) throw new Error(`Für „${variable}“ wurde keine darstellbare Lösung gefunden.`)

  const steps: MathSolutionStep[] = []
  const degreeText = nerdamer(`deg(${zeroExpression},${variable})`).text('fractions')
  const degree = Number(degreeText)
  if (degree === 1) {
    const coefficients = balancedVectorItems(nerdamer(`coeffs(${zeroExpression},${variable})`).text('fractions'))
    const constant = coefficients[0] || '0'
    const coefficient = coefficients[1] || '1'
    const right = nerdamer(`-(${constant})`).text('fractions')
    const left = coefficient === '1' ? variable : coefficient === '-1' ? `-${variable}` : `${coefficient}*${variable}`
    const intermediate = `${left}=${right}`
    const final = `${variable}=${solutionTexts[0]}`
    if (nerdamer(left).text('fractions') !== variable || nerdamer(right).text('fractions') !== solutionTexts[0]) {
      steps.push(stepFor(intermediate, 'intermediate'))
    }
    steps.push(stepFor(final, 'result'))
  } else {
    if (parts && nerdamer(zeroExpression).text('fractions') !== '0') {
      steps.push(stepFor(`${zeroExpression}=0`, 'intermediate'))
    }
    solutionTexts.forEach((solution) => steps.push(stepFor(`${variable}=${solution}`, 'result')))
  }
  return { variables, variable, steps }
}

export const inspectMathExpression = (input: string) => {
  const normalizedInput = normalizeMathInput(input)
  // Parsing here is deliberate: syntactically valid but unsupported expressions must fail before the action menu opens.
  nerdamer(normalizedInput)
  return {
    normalizedInput,
    variables: expressionVariables(normalizedInput),
    latex: latexFor(normalizedInput),
    isEquation: normalizedInput.includes('='),
  }
}

export const solveMathExpression = (
  input: string,
  action: MathSolverAction,
  requestedVariable?: string,
): MathSolverResult => {
  const inspected = inspectMathExpression(input)
  let steps: MathSolutionStep[]
  let variable: string | undefined

  if (action === 'solve') {
    const solved = solveEquation(inspected.normalizedInput, requestedVariable)
    steps = solved.steps
    variable = solved.variable
  } else if (action === 'calculate') {
    if (inspected.variables.length) throw new Error('„Ausrechnen“ ist nur für Terme ohne unbekannte Variablen verfügbar.')
    if (inspected.isEquation) throw new Error('Nutze für eine Gleichung die Aktion „Gleichung lösen“.')
    const value = nerdamer(inspected.normalizedInput).evaluate().text('fractions')
    steps = [stepFor(value, 'result')]
  } else {
    const transform = action === 'expand'
      ? (value: string) => nerdamer(value).expand()
      : action === 'factor'
        ? (value: string) => nerdamer.factor(value)
        : (value: string) => nerdamer(`simplify(${value})`)
    const transformed = transformBothSides(inspected.normalizedInput, transform)
    steps = [stepFor(transformed, 'result')]
  }

  return {
    action,
    input,
    normalizedInput: inspected.normalizedInput,
    inputLatex: inspected.latex,
    variables: inspected.variables,
    variable,
    steps,
  }
}
