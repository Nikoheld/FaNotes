import { getUiLanguage } from '../../i18n'
import type { ParagraphStyle } from '../model/types'

/** German or English for the writing mode's own interface (follows the app language). */
export const L = (de: string, en: string) => (getUiLanguage() === 'en' ? en : de)
export const uiEnglish = () => getUiLanguage() === 'en'
export const styleName = (style: ParagraphStyle) => (getUiLanguage() === 'en' ? style.name.en : style.name.de)
const formatters = new Map<string, Intl.NumberFormat>()
/** Cached formatter: toLocaleString builds a new one per call, which is slow in long lists. */
export const formatNumber = (value: number) => {
  const locale = getUiLanguage() === 'en' ? 'en-US' : 'de-CH'
  let formatter = formatters.get(locale)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale)
    formatters.set(locale, formatter)
  }
  return formatter.format(value)
}
