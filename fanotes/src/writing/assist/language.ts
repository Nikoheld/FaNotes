// German or English for a paragraph: function words, umlauts and typical
// letter pairs. Used when a paragraph has no language set and the project
// language is to be checked against what is actually written.

const GERMAN = new Set(['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'sie', 'er', 'es', 'wir', 'ein', 'eine', 'den', 'dem', 'mit', 'auf', 'für', 'von', 'zu', 'im', 'auch', 'sich', 'war', 'hat', 'aber', 'noch', 'nur', 'wie', 'wenn', 'dass', 'als', 'so', 'schon', 'doch', 'mir', 'mich', 'dir', 'ihr', 'sein', 'seine', 'bei', 'nach', 'aus', 'was', 'kann', 'wird', 'habe', 'hatte', 'oder', 'jetzt', 'hier', 'dann'])
const ENGLISH = new Set(['the', 'and', 'is', 'not', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'a', 'an', 'of', 'to', 'in', 'that', 'with', 'for', 'on', 'was', 'were', 'have', 'had', 'but', 'his', 'her', 'their', 'there', 'what', 'when', 'would', 'could', 'this', 'from', 'be', 'been', 'are', 'my', 'me', 'your', 'at', 'by', 'or', 'so', 'just', 'do', 'did', 'said', 'if', 'then', 'into', 'out', 'up'])

export type DetectedLanguage = 'de' | 'en' | null

export const detectLanguage = (text: string): DetectedLanguage => {
  const words = text.toLocaleLowerCase('de-DE').match(/[\p{L}']+/gu) ?? []
  if (words.length < 3) return null
  let german = 0
  let english = 0
  for (const word of words) {
    if (GERMAN.has(word)) german += 1
    if (ENGLISH.has(word)) english += 1
    if (/[äöüß]/u.test(word)) german += 1.5
    if (/(?:sch|tz|ung$|keit$|heit$|lich$)/u.test(word)) german += 0.3
    if (/(?:th|wh|ing$|tion$|ly$)/u.test(word)) english += 0.3
  }
  if (german === english) return null
  const total = german + english
  if (total < 1.5) return null
  return german > english ? 'de' : 'en'
}
