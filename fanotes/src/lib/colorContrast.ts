type Rgb = [number, number, number]

const DARK_INK = '#11131a'
const LIGHT_INK = '#ffffff'

const parseHex = (value: string): Rgb | null => {
  const hex = value.trim().replace(/^#/, '')
  const normalized = hex.length === 3
    ? hex.split('').map((part) => `${part}${part}`).join('')
    : hex.slice(0, 6)
  if (!/^[\da-f]{6}$/i.test(normalized)) return null
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16)) as Rgb
}

const channelLuminance = (value: number) => {
  const channel = value / 255
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

export const relativeLuminance = (color: string) => {
  const rgb = parseHex(color)
  if (!rgb) return 0
  return channelLuminance(rgb[0]) * 0.2126 +
    channelLuminance(rgb[1]) * 0.7152 +
    channelLuminance(rgb[2]) * 0.0722
}

export const contrastRatio = (first: string, second: string) => {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second))
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second))
  return (lighter + 0.05) / (darker + 0.05)
}

const rgbToHex = (rgb: Rgb) => `#${rgb.map((channel) => (
  Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0')
)).join('')}`

const mix = (first: string, second: string, amount: number) => {
  const from = parseHex(first)
  const to = parseHex(second)
  if (!from || !to) return first
  return rgbToHex(from.map((channel, index) => channel + (to[index] - channel) * amount) as Rgb)
}

export const bestContrastText = (backgrounds: string | string[]) => {
  const surfaces = Array.isArray(backgrounds) ? backgrounds : [backgrounds]
  const minimumContrast = (candidate: string) => Math.min(...surfaces.map((surface) => contrastRatio(candidate, surface)))
  return minimumContrast(DARK_INK) >= minimumContrast(LIGHT_INK) ? DARK_INK : LIGHT_INK
}

export const ensureReadableColor = (foreground: string, backgrounds: string | string[], target = 4.5) => {
  const surfaces = Array.isArray(backgrounds) ? backgrounds : [backgrounds]
  const minimumContrast = (candidate: string) => Math.min(...surfaces.map((surface) => contrastRatio(candidate, surface)))
  if (minimumContrast(foreground) >= target) return foreground
  const destination = bestContrastText(surfaces)
  for (let step = 1; step <= 100; step += 1) {
    const candidate = mix(foreground, destination, step / 100)
    if (minimumContrast(candidate) >= target) return candidate
  }
  return destination
}
