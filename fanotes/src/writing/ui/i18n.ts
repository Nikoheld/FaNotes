import { getUiLanguage } from '../../i18n'
import type { ParagraphStyle } from '../model/types'

/** German or English for the writing mode's own interface (follows the app language). */
export const L = (de: string, en: string) => (getUiLanguage() === 'en' ? en : de)
export const uiEnglish = () => getUiLanguage() === 'en'
export const styleName = (style: ParagraphStyle) => (getUiLanguage() === 'en' ? style.name.en : style.name.de)
export const formatNumber = (value: number) => value.toLocaleString(getUiLanguage() === 'en' ? 'en-US' : 'de-CH')
