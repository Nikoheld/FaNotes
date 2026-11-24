import { defaultSchema, type Schema } from 'hast-util-sanitize'

/** What the note preview and the exports let through when a note holds raw HTML. */
export const markdownSanitizeSchema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'id'],
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ['className', 'language-math', 'math-inline', 'math-display'],
    ],
    details: [...(defaultSchema.attributes?.details ?? []), 'open'],
  },
}
