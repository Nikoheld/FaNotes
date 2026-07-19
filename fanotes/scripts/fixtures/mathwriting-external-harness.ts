import { BASE_CATALOG } from '../../../src/data/catalog'
import {
  buildRecognitionModel,
  recognizeMathDocument,
  recognizedLatex,
} from '../../../src/lib/recognition'
import { createStandardRecognitionSamples } from '../../../src/lib/standardRecognition'
import type { Stroke } from '../../../src/types'

export type MathWritingAuditEntry = {
  id: string
  expected: string
  strokes: Stroke[]
}

type MathWritingAuditRow = {
  id: string
  expected: string
  predicted: string
  expectedLength: number
  predictedLength: number
  edits: number
  exact: boolean
}

const normalizedLatex = (value: string) => value
  .normalize('NFC')
  .replace(/\\(?:left|right)\s*/gu, '')
  .replace(/\\tfrac\b/gu, '\\frac')
  .replace(/\\operatorname\{log\}/gu, 'log')
  .replace(/\s+/gu, '')

const editDistance = (left: string, right: string) => {
  const source = Array.from(left)
  const target = Array.from(right)
  let previous = Array.from({ length: target.length + 1 }, (_entry, index) => index)
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    const current = [sourceIndex + 1]
    for (let targetIndex = 0; targetIndex < target.length; targetIndex += 1) {
      current.push(Math.min(
        current[targetIndex] + 1,
        previous[targetIndex + 1] + 1,
        previous[targetIndex] + Number(source[sourceIndex] !== target[targetIndex]),
      ))
    }
    previous = current
  }
  return previous[target.length]
}

export async function runMathWritingExternalAudit(entries: MathWritingAuditEntry[]) {
  const model = await buildRecognitionModel(await createStandardRecognitionSamples(BASE_CATALOG))
  const rows: MathWritingAuditRow[] = []
  for (const entry of entries) {
    const expected = normalizedLatex(entry.expected)
    const predicted = normalizedLatex(recognizedLatex(
      recognizeMathDocument(entry.strokes, model, BASE_CATALOG, [], 'de'),
    ))
    rows.push({
      id: entry.id,
      expected,
      predicted,
      expectedLength: Array.from(expected).length,
      predictedLength: Array.from(predicted).length,
      edits: editDistance(expected, predicted),
      exact: expected === predicted,
    })
    // Keep the browser responsive and make the watchdog meaningful even for
    // unusually large formulae in a future full-dataset audit.
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
  }
  const characters = rows.reduce((sum, row) => sum + row.expectedLength, 0)
  const edits = rows.reduce((sum, row) => sum + row.edits, 0)
  return {
    samples: rows.length,
    exact: rows.filter((row) => row.exact).length,
    exactRate: rows.length ? rows.filter((row) => row.exact).length / rows.length : 0,
    characters,
    edits,
    characterErrorRate: characters ? edits / characters : 0,
    rows,
  }
}
