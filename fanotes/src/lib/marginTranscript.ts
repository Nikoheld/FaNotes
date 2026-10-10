import { correctionFor, type RecognitionModelBundle } from './sync/recognitionModelBundle'
import { parseTranscriptLine } from './searchInkAnchor'

export type MarginLine = {
  y: number | null
  text: string
}

/** Lines of the invisible transcript, in page order, for the margin. */
export const marginLinesFromTranscript = (transcript: string): MarginLine[] => (
  transcript.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const parsed = parseTranscriptLine(line)
    return { y: parsed.y, text: parsed.text }
  }).filter((line) => line.text).slice(0, 80)
)

export const replaceTranscriptWord = (transcript: string, from: string, to: string) => {
  const pattern = new RegExp(`(^|\\s)${from.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?=\\s|$)`, 'u')
  return transcript.replace(pattern, `$1${to}`)
}

export const applyMarginCorrection = (
  transcript: string,
  bundle: RecognitionModelBundle | null,
  word: string,
) => {
  const learned = correctionFor(bundle, word)
  return learned ? { transcript: replaceTranscriptWord(transcript, word, learned), replacement: learned } : null
}
