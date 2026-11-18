/**
 * Handwriting recognition host for the Android tablet app.
 *
 * The tablet runs this page in a headless WebView so conversions use the desktop's own
 * recognition code: the GlyphenWerk glyph recognizer (`src/lib/recognition`), the FaNotes ink
 * recognizer (`inkRecognition`, line grouping, rendering and the language-model decoder in
 * `fanotes-recog` WASM), the mode selection, the math solver (nerdamer) and the step checker.
 * Only the ONNX line model runs natively, in ONNX Runtime for Android, reached through
 * `FaNotesRecognitionHost.infer` the way the desktop reaches its `fanotes-ocr` sidecar.
 *
 * The flows below follow `DrawingBoard.tsx` (`recognize`, `updateHiddenTranscript`,
 * `openMathSolverAtPoint`, `analyzeMathCorrectionSelection`, `verifyMathCorrectionLines`)
 * without the optional desktop-only engines (Qwen3-VL on the Intel NPU, the PosFormer formula
 * model). Nothing leaves the device: the page has no network access besides its own assets.
 */
import type { Stroke } from '../../../src/types'
import type { AutomaticRecognitionResult, RecognitionToken } from '../../../src/lib/recognition'
import { assessNeuralTextModeCandidate, hasDecisiveMathLayout } from '../lib/recognitionModeSelection'
import { polishRecognizedText } from '../lib/recognitionPolish'
import { groupMathInkLines } from '../lib/mathInkSelection'
import type { MathCheckResult } from '../lib/mathChecker'
import type { MathSolverAction } from '../lib/mathSolver'
import { loadBrowserSpellingResources, loadBrowserSpellingWordCandidates } from '../lib/spellingResources'
import { base64ToFloat32, float32ToBase64 } from './codec'

type Mode = 'math' | 'text'
type Preference = Mode | 'auto'
type Language = 'de' | 'en'

type Native = {
  /** Synchronous: returns `{ ok, value: { logits, dims } }` or `{ ok: false, error }`. */
  infer(imageBase64: string, width: number, height: number, threads: number, model: string): string
  /** The request body of call [id], read once (a page of ink can be megabytes). */
  payload(id: number): string
  result(id: number, json: string): void
  ready(): void
}

type Page = {
  strokes: Stroke[]
  width: number
  height: number
  language: Language
  /** Whether the ink model is installed; without it only the glyph recognizer runs. */
  neural: boolean
}

const native = (window as unknown as { FaNotesRecognitionHost?: Native }).FaNotesRecognitionHost ?? null

const unwrap = <T>(raw: string): T => {
  const envelope = JSON.parse(raw) as { ok: boolean; value?: T; error?: string }
  if (!envelope.ok) throw new Error(envelope.error || 'Die Stifterkennung ist fehlgeschlagen.')
  return envelope.value as T
}

const neuralEnabled = { current: false }

const installHost = () => {
  const api = (window as unknown as { fanotes?: Record<string, unknown> }).fanotes ?? {}
  ;(window as unknown as { fanotes: Record<string, unknown> }).fanotes = {
    ...api,
    // `web` makes inkRecognition fetch its manifest and language models from `./ocr/`, which
    // the app serves from the downloaded model folder.
    platform: 'web',
    loadSpellingResources: loadBrowserSpellingResources,
    loadSpellingWordCandidates: loadBrowserSpellingWordCandidates,
    recognizeInkLine: async (request: { input: Float32Array; width: number; height: number; threads?: number; model?: string }) => {
      if (!native || !neuralEnabled.current) throw new Error('Das Handschriftmodell ist auf diesem Gerät nicht installiert.')
      const value = unwrap<{ logits: string; dims: number[] }>(native.infer(
        float32ToBase64(request.input),
        request.width,
        request.height,
        Math.max(1, Math.min(4, request.threads ?? 2)),
        request.model === 'personal' ? 'personal' : 'base',
      ))
      return { logits: base64ToFloat32(value.logits), dims: value.dims, engine: 'fanotes-ink' as const }
    },
    inkPersonalModelState: async () => ({ installed: false }),
  }
}

installHost()

const engine = () => import('../../../src/lib/recognition')
const resources = () => import('../lib/handwritingDb').then((module) => module.loadRecognitionResources())
const ink = () => import('../lib/inkRecognition')

const averageConfidence = (tokens: RecognitionToken[]) => {
  const usable = tokens.filter((token) => !token.isLayout)
  return usable.length ? Math.round(usable.reduce((sum, token) => sum + token.confidence, 0) / usable.length) : 0
}

const loadAll = async () => {
  const [loaded, recognition] = await Promise.all([resources(), engine()])
  if (!loaded.model.length) throw new Error('Das lokale Standardmodell konnte nicht geladen werden.')
  return { loaded, recognition }
}

const recognizeNeural = async (page: Page, strokes: Stroke[]) => {
  if (!page.neural) return null
  const { recognizeInk } = await ink()
  return recognizeInk(strokes, page.language, page.width, page.height)
}

/** `recognize` in `DrawingBoard.tsx`: the conversion of a selection or a page. */
const recognize = async (page: Page & { mode: Preference; lastMode: Mode }) => {
  const { loaded, recognition } = await loadAll()
  const strokes = page.strokes
  let resolvedMode: Mode
  let recognized: RecognitionToken[]
  let value: string
  let automatic: AutomaticRecognitionResult | null = null
  if (page.mode === 'auto') {
    automatic = recognition.recognizeAutomaticExpression(strokes, loaded.model, loaded.labels, loaded.layoutExamples, page.language, page.lastMode)
    resolvedMode = automatic.mode as Mode
    recognized = automatic.tokens
    value = automatic.value
  } else {
    resolvedMode = page.mode
    recognized = page.mode === 'math'
      ? recognition.recognizeMathDocument(strokes, loaded.model, loaded.labels, loaded.layoutExamples, page.language)
      : recognition.recognizeExpression(strokes, loaded.model, loaded.labels, page.mode, loaded.layoutExamples, page.language)
    value = page.mode === 'math'
      ? recognition.recognizedLatex(recognized, loaded.layoutExamples)
      : recognition.recognizedSentence(recognized)
  }
  let confidence = automatic?.confidence ?? averageConfidence(recognized)
  let reason = automatic?.reason ?? ''
  let engineName: 'glyphenwerk' | 'fanotes-ink' = 'glyphenwerk'
  let neuralError = ''
  if (page.mode !== 'math' && page.neural) {
    try {
      const result = await recognizeNeural(page, strokes)
      if (result) {
        const compact = result.text.replace(/\s/gu, '')
        const assessment = assessNeuralTextModeCandidate(result.text, page.language, result, automatic)
        const usableExplicitText = page.mode === 'text' && (compact.length >= 1 || assessment.letters >= 1)
        if (result.text && (usableExplicitText || automatic?.mode === 'text' || assessment.shouldUseText)) {
          resolvedMode = 'text'
          value = result.text
          confidence = result.confidence
          engineName = 'fanotes-ink'
          reason = result.personalized
            ? 'lokale Stifterkennung mit persönlicher Anpassung'
            : 'lokale Stifterkennung (Zeilenmodell mit Sprachmodell)'
        }
      }
    } catch (error) {
      // The classic glyph result stays, as on the desktop.
      neuralError = error instanceof Error ? error.message : String(error)
    }
  }
  return { mode: resolvedMode, value, confidence, reason, engine: engineName, neuralError }
}

const BACKGROUND_RECOGNITION_CHUNK = 24

/** `backgroundRecognitionChunks` in `DrawingBoard.tsx`: rows of at most 24 strokes, top to bottom. */
const backgroundChunks = (strokes: Stroke[]) => {
  const ordered = strokes
    .map((stroke) => {
      let left = 1
      let centerY = 0
      let top = 1
      stroke.points.forEach((point) => {
        left = Math.min(left, point.x)
        top = Math.min(top, point.y)
        centerY += point.y
      })
      return { stroke, left, top, centerY: centerY / Math.max(1, stroke.points.length) }
    })
    .sort((first, second) => first.centerY - second.centerY || first.left - second.left)
  const chunks: Array<{ strokes: Stroke[]; top: number }> = []
  for (let index = 0; index < ordered.length; index += BACKGROUND_RECOGNITION_CHUNK) {
    const slice = ordered.slice(index, index + BACKGROUND_RECOGNITION_CHUNK)
    chunks.push({ strokes: slice.map((entry) => entry.stroke), top: Math.min(...slice.map((entry) => entry.top)) })
  }
  return chunks
}

/**
 * `updateHiddenTranscript` in `DrawingBoard.tsx` for the strokes the app passes. Each chunk keeps
 * its top as the page anchor (`searchInkAnchor.ts`), so a search hit scrolls to the line.
 */
const transcribe = async (page: Page & { mode: Preference; lastMode: Mode; lineLanguage?: 'de' | 'en' | 'fr' }) => {
  const { loaded, recognition } = await loadAll()
  const activeMode: Mode = page.mode === 'auto' ? page.lastMode : page.mode
  const lines: Array<{ y: number; text: string; kind: Mode }> = []
  // No timer yield between chunks (unlike the desktop renderer): nothing else runs on this page,
  // and a headless WebView may throttle timers like a background tab.
  for (const chunk of backgroundChunks(page.strokes)) {
    const automatic = page.mode === 'auto'
      ? recognition.recognizeAutomaticExpression(chunk.strokes, loaded.model, loaded.labels, loaded.layoutExamples, page.language, page.lastMode)
      : null
    const backgroundMode = (automatic?.mode as Mode | undefined) ?? activeMode
    const ambiguous = Boolean(automatic && automatic.mathScore - automatic.textScore < 2.2)
    const decisiveMath = Boolean(automatic && hasDecisiveMathLayout(automatic.mathValue))
    const couldBeText = Boolean(automatic && page.mode === 'auto' && !decisiveMath)
    if (backgroundMode === 'text' || ambiguous || couldBeText) {
      const textTokens = automatic?.mode === 'text'
        ? automatic.tokens
        : recognition.recognizeExpression(chunk.strokes, loaded.model, loaded.labels, 'text', loaded.layoutExamples, page.language)
      const personalEvidence = textTokens.some((token) => (
        (token.personalSupport ?? 0) > 0 || token.alternatives.some((alternative) => (alternative.personalSupport ?? 0) > 0)
      ))
      let neuralValue = ''
      try {
        const result = await recognizeNeural(page, chunk.strokes)
        if (result) {
          const assessment = assessNeuralTextModeCandidate(result.text, page.language, result, automatic)
          const minimum = backgroundMode === 'text' ? personalEvidence ? 0 : 32 : 54
          if (
            result.confidence >= minimum
            && assessment.letters >= (backgroundMode === 'text' ? 1 : 3)
            && assessment.wordLike
            && !assessment.explicitFormulaSyntax
            && (backgroundMode === 'text' || assessment.shouldUseText)
          ) neuralValue = result.text.trim()
        }
      } catch {
        // The classic local recognizer remains the offline fallback.
      }
      const language = page.lineLanguage ?? page.language
      if (neuralValue) {
        lines.push({ y: chunk.top, text: polishRecognizedText(neuralValue, language), kind: 'text' })
      } else if (automatic?.mode === 'math') {
        const mathValue = automatic.value.trim()
        if (mathValue) lines.push({ y: chunk.top, text: mathValue, kind: 'math' })
      } else {
        const textValue = (automatic?.mode === 'text' ? automatic.value : recognition.recognizedSentence(textTokens)).trim()
        if (textValue) lines.push({ y: chunk.top, text: polishRecognizedText(textValue, language), kind: 'text' })
      }
    } else {
      const mathTokens = automatic?.mode === 'math'
        ? automatic.tokens
        : recognition.recognizeExpression(chunk.strokes, loaded.model, loaded.labels, 'math', loaded.layoutExamples, page.language)
      const mathValue = (automatic?.mode === 'math' ? automatic.value : recognition.recognizedLatex(mathTokens, loaded.layoutExamples)).trim()
      if (mathValue) lines.push({ y: chunk.top, text: mathValue, kind: 'math' })
    }
  }
  return { lines }
}

/** `openMathSolverAtPoint` without the point search: the app passes the selected strokes. */
const readMath = async (page: Page) => {
  const { loaded, recognition } = await loadAll()
  const recognized = recognition.recognizeExpression(page.strokes, loaded.model, loaded.labels, 'math', loaded.layoutExamples, page.language)
  return {
    input: recognition.recognizedText(recognized, loaded.layoutExamples).trim(),
    latex: recognition.recognizedLatex(recognized, loaded.layoutExamples).trim(),
    confidence: averageConfidence(recognized),
  }
}

const WORKER_FAILED = /konnte nicht gestartet werden/u

/** The desktop runs both in a Worker with a timeout; if a WebView cannot start one, run in the page. */
const solve = async (request: { input: string; action: MathSolverAction; variable?: string }) => {
  const { solveMathExpressionSafely } = await import('../lib/mathSolverClient')
  try {
    return await solveMathExpressionSafely(request.input, request.action, request.variable || undefined)
  } catch (error) {
    if (!(error instanceof Error && WORKER_FAILED.test(error.message))) throw error
    const { solveMathExpression } = await import('../lib/mathSolver')
    return solveMathExpression(request.input, request.action, request.variable || undefined)
  }
}

const checkMath = async (inputs: string[]) => {
  const { checkMathStepsSafely } = await import('../lib/mathCheckerClient')
  try {
    return await checkMathStepsSafely(inputs)
  } catch (error) {
    if (!(error instanceof Error && WORKER_FAILED.test(error.message))) throw error
    const { checkMathSteps } = await import('../lib/mathChecker')
    return checkMathSteps(inputs)
  }
}

type CorrectionLine = {
  input: string
  latex: string
  confidence: number
  recognitionRisk: boolean
  confirmed: boolean
  rect: { x: number; y: number; width: number; height: number }
}

/** `verifyMathCorrectionLines`: an unconfirmed risky line stops the automatic verdict. */
const verifyLines = async (lines: CorrectionLine[]): Promise<MathCheckResult> => {
  const checked = await checkMath(lines.map((line) => line.input))
  const unconfirmed = lines.findIndex((line) => !line.confirmed && line.recognitionRisk)
  if (unconfirmed < 0) return checked
  return {
    status: 'uncertain',
    errorLineIndex: unconfirmed,
    lines: checked.lines.map((line, index) => index === unconfirmed
      ? { ...line, status: 'uncertain', message: 'Die Handschrifterkennung dieser Zeile ist für eine automatische Fehleraussage zu unsicher.' }
      : index > unconfirmed ? { ...line, status: 'unchecked', message: 'Noch nicht geprüft' } : line),
    message: `Bestätige oder korrigiere zuerst Schritt ${unconfirmed + 1}; mindestens ein Zeichen ist mehrdeutig (${lines[unconfirmed].confidence} % mittlere Sicherheit).`,
  }
}

/** `analyzeMathCorrectionSelection`: one recognized line per written step, then the check. */
const checkSteps = async (page: Page) => {
  const groups = groupMathInkLines(page.strokes, { width: page.width, height: page.height })
  if (groups.length < 2) throw new Error('Im gewählten Bereich wurden nicht mindestens zwei getrennte Rechenzeilen gefunden.')
  if (groups.length > 20) throw new Error('Wähle höchstens 20 Rechenschritte auf einmal aus.')
  const { loaded, recognition } = await loadAll()
  const lines: CorrectionLine[] = groups.map((group) => {
    const recognized = recognition.recognizeExpression(group.strokes, loaded.model, loaded.labels, 'math', loaded.layoutExamples, page.language)
    const usable = recognized.filter((token) => !token.isLayout)
    const confidence = averageConfidence(recognized)
    const ambiguous = usable.some((token) => {
      const ranked = [...token.alternatives].sort((left, right) => right.confidence - left.confidence)
      return token.confidence < 42 || (ranked.length > 1 && ranked[0].char !== ranked[1].char && ranked[0].confidence - ranked[1].confidence < 5)
    })
    return {
      input: recognition.recognizedText(recognized, loaded.layoutExamples).trim(),
      latex: recognition.recognizedLatex(recognized, loaded.layoutExamples).trim(),
      confidence,
      recognitionRisk: confidence < 62 || ambiguous,
      confirmed: false,
      rect: group.rect,
    }
  })
  return { lines, result: await verifyLines(lines) }
}

const methods: Record<string, (payload: never) => Promise<unknown>> = {
  recognize,
  transcribe,
  readMath,
  solve,
  checkSteps,
  verifyLines: (payload: { lines: CorrectionLine[] }) => verifyLines(payload.lines),
  warm: async () => {
    await loadAll()
    return true
  },
}

const reply = (id: number, body: unknown) => {
  const json = JSON.stringify(body)
  if (native) native.result(id, json)
  else window.dispatchEvent(new CustomEvent('fanotes-recognition-result', { detail: { id, json } }))
}

/**
 * Entry for `evaluateJavascript`: the body comes from `FaNotesRecognitionHost.payload` unless given,
 * the answer goes back through `FaNotesRecognitionHost.result`.
 */
const call = (id: number, method: string, payloadJson?: string) => {
  const run = methods[method]
  if (!run) {
    reply(id, { ok: false, error: `Unbekannte Anfrage: ${method}` })
    return
  }
  void (async () => {
    try {
      const body = payloadJson ?? native?.payload(id) ?? '{}'
      const payload = JSON.parse(body || '{}') as { neural?: boolean }
      neuralEnabled.current = Boolean(payload.neural)
      reply(id, { ok: true, value: await run(payload as never) })
    } catch (error) {
      reply(id, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
}

;(window as unknown as { FaNotesRecognition: unknown }).FaNotesRecognition = { call }
native?.ready()
