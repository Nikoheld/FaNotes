/** A compact French school lexicon. Spellcheck and line repair use it locally. */

const WORDS = `
le la les un une des de du et ou mais donc car ni que qui quoi dont ou
je tu il elle on nous vous ils elles me te se lui leur y en mon ton son
ma ta sa mes tes ses notre votre leur nos vos leurs ce cet cette ces
est suis es sommes etes sont ete etait ai as a avons avez ont
pas ne plus jamais rien personne
dans sur sous avec sans pour par chez entre vers pendant avant apres
etre avoir faire aller dire voir savoir pouvoir vouloir devoir prendre
mettre donner trouver parler aimer arriver rester passer penser
bonjour merci oui non tres bien mal petit grand nouveau nouveau
ecole eleve professeur devoir examen lecon cahier stylo livre texte
phrase mot lettre grammaire vocabulaire conjugaison exercice
francais anglais allemand mathematiques histoire geographie
physique chimie biologie informatique
aujourd aujourd'hui demain hier matin soir semaine mois annee
lundi mardi mercredi jeudi vendredi samedi dimanche
janvier fevrier mars avril mai juin juillet aout septembre octobre novembre decembre
un deux trois quatre cinq six sept huit neuf dix vingt trente cent
rouge bleu vert jaune noir blanc
maison famille ami amie mere pere frere soeur enfant
eau pain fromage lait cafe the
lire ecrire ecouter parler comprendre repondre traduire
question reponse exemple phrase correct incorrect
`.trim()

const fold = (word: string) => word
  .normalize('NFC')
  .toLocaleLowerCase('fr-FR')
  .replace(/[àâä]/gu, 'a')
  .replace(/[éèêë]/gu, 'e')
  .replace(/[îï]/gu, 'i')
  .replace(/[ôö]/gu, 'o')
  .replace(/[ùûü]/gu, 'u')
  .replace(/ç/gu, 'c')
  .replace(/œ/gu, 'oe')
  .replace(/^['’\-]+|['’\-]+$/gu, '')

const lexicon = new Set(WORDS.split(/\s+/u).map(fold).filter((word) => word.length >= 2))

export const FRENCH_STOPWORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou', 'mais', 'dans', 'sur', 'avec',
  'pour', 'par', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'est', 'sont', 'pas', 'que', 'qui',
  'une', 'au', 'aux', 'ce', 'cette', 'ces', 'mon', 'ton', 'son',
])

export const isFrenchWord = (word: string) => lexicon.has(fold(word))

const variants = (word: string) => {
  const folded = fold(word)
  const results = new Set<string>()
  const swaps: Array<[string, string]> = [
    ['e', 'é'], ['e', 'è'], ['e', 'ê'], ['a', 'à'], ['a', 'â'], ['u', 'ù'], ['u', 'û'], ['c', 'ç'], ['o', 'ô'],
  ]
  for (const [from, to] of swaps) {
    const index = folded.indexOf(from)
    if (index >= 0) results.add(`${folded.slice(0, index)}${to}${folded.slice(index + 1)}`)
  }
  return [...results]
}

/** Prefer a lexicon word, then a single accent repair, otherwise leave the token. */
export const repairFrenchToken = (token: string): string | null => {
  if (isFrenchWord(token)) return null
  const folded = fold(token)
  if (lexicon.has(folded) && folded !== token.toLocaleLowerCase('fr-FR')) return null
  for (const candidate of variants(token)) {
    if (lexicon.has(fold(candidate))) return candidate
  }
  if (lexicon.has(folded)) return folded
  return null
}

export const repairFrenchLine = (text: string) => text.replace(/[A-Za-zÀ-ÿ]+/gu, (token) => repairFrenchToken(token) ?? token)
