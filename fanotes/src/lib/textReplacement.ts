/**
 * The smallest single-span change that turns `current` into `next`: the shared
 * prefix and suffix stay untouched. Replacing a whole document instead moves
 * every position, and a cursor behind the edited span is then clamped rather
 * than mapped.
 */
export const minimalReplacement = (current: string, next: string): { from: number; to: number; insert: string } => {
  const limit = Math.min(current.length, next.length)
  let prefix = 0
  while (prefix < limit && current.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1
  // Never split a surrogate pair: back off if the prefix ends inside one.
  if (prefix > 0 && prefix < limit && isLowSurrogate(current.charCodeAt(prefix))) prefix -= 1
  let suffix = 0
  const suffixLimit = limit - prefix
  while (
    suffix < suffixLimit
    && current.charCodeAt(current.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) suffix += 1
  if (suffix > 0 && suffix < suffixLimit && isHighSurrogate(current.charCodeAt(current.length - suffix))) suffix -= 1
  return { from: prefix, to: current.length - suffix, insert: next.slice(prefix, next.length - suffix) }
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff
