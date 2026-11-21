import type { markdown } from '@codemirror/lang-markdown'

type Extensions = NonNullable<NonNullable<Parameters<typeof markdown>[0]>['extensions']>

const MAX_LENGTH = 300

/**
 * `[[Note]]` and `[[Note|label]]` as one atomic inline node. Without this, Lezer reads `[[x]]`
 * as nested reference links, and its link bookkeeping walks every earlier part of the paragraph for
 * each link: a very long paragraph with many wiki links parses in quadratic time (QA-003).
 */
export const wikiLinkExtension: Extensions = {
  defineNodes: [{ name: 'WikiLink' }],
  parseInline: [{
    name: 'WikiLink',
    before: 'Link',
    parse(cx, next, pos) {
      if (next !== 91 || cx.char(pos + 1) !== 91) return -1
      const text = cx.slice(pos + 2, Math.min(cx.end, pos + 2 + MAX_LENGTH))
      const close = text.indexOf(']]')
      if (close <= 0) return -1
      const body = text.slice(0, close)
      if (/[[\]\n]/u.test(body)) return -1
      return cx.addElement(cx.elt('WikiLink', pos, pos + 2 + close + 2))
    },
  }],
}
