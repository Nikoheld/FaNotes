import type { Root, RootContent } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

/** The same Markdown dialect as the note preview: CommonMark, GFM and `$ math $`. */
export function parseNoteMarkdown(markdown: string): Root {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
  return processor.runSync(processor.parse(markdown)) as Root
}

/** All image sources in the tree, in order, without duplicates. */
export function collectImageSources(tree: Root): string[] {
  const found = new Set<string>()
  const walk = (node: Root | RootContent) => {
    if (node.type === 'image' && node.url) found.add(node.url)
    if ('children' in node) for (const child of node.children as RootContent[]) walk(child)
  }
  walk(tree)
  return [...found]
}
