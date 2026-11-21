import { uiText } from '../i18n'

/** Basic colours as [German, English, r, g, b]. A swatch is announced by the nearest of these. */
const BASIC_COLORS: ReadonlyArray<readonly [string, string, number, number, number]> = [
  ['Schwarz', 'Black', 17, 24, 39],
  ['Grau', 'Grey', 107, 114, 128],
  ['Weiss', 'White', 255, 255, 255],
  ['Rot', 'Red', 220, 60, 50],
  ['Dunkelrot', 'Dark red', 127, 29, 29],
  ['Orange', 'Orange', 217, 115, 13],
  ['Braun', 'Brown', 154, 52, 18],
  ['Gold', 'Gold', 186, 155, 74],
  ['Gelb', 'Yellow', 234, 179, 8],
  ['Grün', 'Green', 68, 131, 97],
  ['Petrol', 'Teal', 15, 123, 108],
  ['Cyan', 'Cyan', 6, 182, 212],
  ['Blau', 'Blue', 42, 111, 151],
  ['Dunkelblau', 'Dark blue', 30, 58, 138],
  ['Violett', 'Purple', 144, 101, 176],
  ['Rosa', 'Pink', 236, 72, 153],
]

const parseHex = (hex: string): [number, number, number] | null => {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(hex.trim())
  if (!match) return null
  const full = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join('') : match[1]
  return [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16)) as [number, number, number]
}

/** Spoken name of a colour swatch in the UI language ("Blau"/"Blue"); the hex value for anything unparseable. */
export function colorSwatchName(hex: string): string {
  const rgb = parseHex(hex)
  if (!rgb) return hex
  let best = BASIC_COLORS[0]
  let bestDistance = Infinity
  for (const entry of BASIC_COLORS) {
    const distance = (entry[2] - rgb[0]) ** 2 + (entry[3] - rgb[1]) ** 2 + (entry[4] - rgb[2]) ** 2
    if (distance < bestDistance) { best = entry; bestDistance = distance }
  }
  return uiText(best[0], best[1])
}
