// The `hyphen` package ships no types; the writing mode uses the synchronous hyphenator only.
declare module 'hyphen/de' {
  export const hyphenateSync: (text: string, options?: { hyphenChar?: string; minWordLength?: number }) => string
}
declare module 'hyphen/en-us' {
  export const hyphenateSync: (text: string, options?: { hyphenChar?: string; minWordLength?: number }) => string
}
declare module 'hyphen/en-gb' {
  export const hyphenateSync: (text: string, options?: { hyphenChar?: string; minWordLength?: number }) => string
}
