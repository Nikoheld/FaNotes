// Source of electron/onenote-sanitizer.bundle.cjs (built by
// scripts/build-onenote-sanitizer.mjs). The Electron main process ships no
// node_modules, so the parser and hast-util-sanitize (the sanitiser behind the
// app's rehype-sanitize) are bundled into one committed CommonJS file.
//
// The page is parsed as a fragment in a <div> context, like ammonia does in
// crates/fanotes-host/src/onenote.rs, then cleaned with the allowlist both read
// from electron/onenote-sanitize-policy.json.

import { parse, parseFragment, serialize } from 'parse5'
import { fromParse5 } from 'hast-util-from-parse5'
import { toParse5 } from 'hast-util-to-parse5'
import { sanitize } from 'hast-util-sanitize'
import { find, html as htmlSchema, svg as svgSchema } from 'property-information'

const propertyNames = (attributes) => {
  const names = new Set()
  for (const attribute of attributes) {
    names.add(find(htmlSchema, attribute).property)
    names.add(find(svgSchema, attribute).property)
  }
  return [...names]
}

/**
 * Second pass over the sanitised tree:
 * - inside <svg> only SVG elements and inside <math> only MathML elements stay
 *   (an `<img>` or `<style>` there would change namespace when the saved page is
 *   parsed again, the root of mutation XSS), the rest is removed with its content;
 * - `src` stays only on an `img` with a data:image/ URL.
 */
const enforceNamespaces = (node, space, policy, sets) => {
  if (!Array.isArray(node.children)) return
  node.children = node.children.filter((child) => {
    if (child.type !== 'element') return true
    const allowed = space === 'svg' ? sets.svg : space === 'math' ? sets.math : sets.html
    if (!allowed.has(child.tagName)) return false
    const source = child.properties?.src
    if (source !== undefined && !(space === 'html' && child.tagName === 'img' && typeof source === 'string' && source.toLowerCase().startsWith(policy.imageSource))) {
      delete child.properties.src
    }
    const next = space === 'html' && child.tagName === 'svg' ? 'svg' : space === 'html' && child.tagName === 'math' ? 'math' : space
    enforceNamespaces(child, next, policy, sets)
    return true
  })
}

export function createOneNoteSanitizer(policy) {
  const allowed = propertyNames(policy.attributes)
  const schema = {
    tagNames: [...new Set([...policy.htmlTags, ...policy.svgTags, ...policy.mathTags])],
    strip: policy.dropWithContent,
    attributes: { '*': allowed, img: ['src'] },
    // `src` is checked below; no other URL attribute is on the list.
    protocols: { src: ['data'] },
    required: {},
    ancestors: {},
    clobber: [],
    clobberPrefix: '',
    allowComments: false,
    allowDoctypes: false,
  }
  const sets = { html: new Set(policy.htmlTags), svg: new Set(policy.svgTags), math: new Set(policy.mathTags) }
  const context = parseFragment('<div></div>').childNodes[0]
  return (html) => {
    const fragment = fromParse5(parseFragment(context, String(html)))
    const clean = sanitize(fragment, schema)
    enforceNamespaces(clean, 'html', policy, sets)
    return serialize(toParse5(clean))
  }
}

/** The parse5 document tree of a converted page, for the Markdown and ink converter (onenote-convert.cjs). */
export const parseOneNoteDocument = (html) => parse(String(html))
