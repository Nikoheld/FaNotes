import { repairFrenchLine } from './frenchLexicon'
import { repairGermanLine } from './germanRecognition'
import { correctionFor, type RecognitionModelBundle } from './sync/recognitionModelBundle'

export type LineLanguage = 'de' | 'en' | 'fr'

/** The shipped line model is German or English. French uses the Latin model plus a lexicon. */
export const modelLanguageFor = (language: LineLanguage): 'de' | 'en' => (
  language === 'de' ? 'de' : 'en'
)

export const polishRecognizedText = (
  text: string,
  language: LineLanguage,
  bundle: RecognitionModelBundle | null = null,
) => {
  const corrected = language === 'de'
    ? repairGermanLine(text)
    : language === 'fr'
      ? repairFrenchLine(text)
      : text
  if (!bundle) return corrected
  return corrected.replace(/[A-Za-zÀ-ÿÄÖÜäöüß]+/gu, (token) => correctionFor(bundle, token) ?? token)
}
