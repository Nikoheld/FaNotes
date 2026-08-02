/**
 * Small multilingual supplement for common European given names that are
 * absent from the English SUBTLEX title-case corpus. Values are lowercase so
 * they can be shared by German and English recognition without duplicating
 * case variants.
 */
export const SUPPLEMENTAL_CANONICAL_PROPER_NAMES = new Set(`
alessio amina anouk ayla benedikt chiara elin elio elisa elodie enya fabio fabiola
flavio giulia ilaria jannis jaro joline jona jonas julia kaan lian lio livia loris
malin mara marlon matteo milo nael nando nela niko nino noelia noa samira selin
solea tabea tamina yara yuna
`.trim().split(/\s+/u))
