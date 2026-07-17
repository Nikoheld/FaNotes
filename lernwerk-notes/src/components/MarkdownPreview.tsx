import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type UrlTransform,
} from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { defaultSchema, type Schema } from 'hast-util-sanitize'
import type { Nodes, Root } from 'hast'

export type MarkdownLinkHandler = (href: string) => void | Promise<void>

export type MarkdownPreviewProps = {
  content: string
  onOpenLink?: MarkdownLinkHandler
  resolveImage?: (src: string) => Promise<string>
  className?: string
  emptyMessage?: ReactNode
}

const markdownSanitizeSchema: Schema = {
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

function textContent(node: Nodes): string {
  if (node.type === 'text') return node.value
  if ('children' in node) return node.children.map(textContent).join('')
  return ''
}

function headingSlug(value: string) {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('de-DE')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-') || 'abschnitt'
  )
}

/** Adds stable, deduplicated heading anchors without enabling raw HTML. */
function rehypeHeadingIds() {
  return (tree: Root) => {
    const occurrences = new Map<string, number>()

    const visit = (node: Nodes) => {
      if (
        node.type === 'element' &&
        /^h[1-6]$/.test(node.tagName) &&
        !node.properties.id
      ) {
        const base = headingSlug(textContent(node))
        const count = occurrences.get(base) ?? 0
        occurrences.set(base, count + 1)
        node.properties.id = count === 0 ? base : `${base}-${count + 1}`
      }
      if ('children' in node) node.children.forEach(visit)
    }

    visit(tree)
  }
}

const secureUrlTransform: UrlTransform = (value) => {
  const normalized = defaultUrlTransform(value.trim())
  if (!normalized || normalized.startsWith('//')) return ''

  const protocol = /^([a-z][a-z\d+.-]*):/i.exec(normalized)?.[1]?.toLowerCase()
  if (protocol && !['http', 'https', 'mailto'].includes(protocol)) return ''
  // rehype-sanitize prefixes generated IDs to prevent DOM clobbering. Keep
  // authored heading links in sync with that safe prefix.
  if (normalized.startsWith('#') && !normalized.startsWith('#user-content-')) {
    return `#user-content-${normalized.slice(1)}`
  }
  return normalized
}

function isExternalLink(href: string) {
  return /^https?:\/\//i.test(href)
}

function expandWikiLinks(content: string) {
  let fence: string | null = null
  return content.split('\n').map((line) => {
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker[0]
      else if (marker[0] === fence) fence = null
      return line
    }
    if (fence) return line
    return line.split(/(`+[^`]*`+)/g).map((segment) => {
      if (segment.startsWith('`')) return segment
      return segment.replace(/\[\[([^\[\]]+?)\]\]/g, (_full, raw: string) => {
        const [rawTarget, rawAlias] = raw.split('|', 2)
        const target = rawTarget.trim()
        const alias = (rawAlias?.trim() || target).replaceAll(']', '\\]')
        const [note, anchor] = target.split('#', 2)
        const markdownTarget = note.toLocaleLowerCase('de').endsWith('.md') ? note : `${note}.md`
        const href = `${markdownTarget}${anchor ? `#${anchor}` : ''}`.replaceAll(')', '%29')
        return `[${alias}](${href})`
      })
    }).join('')
  }).join('\n')
}

function ResolvedImage({ src, alt, resolveImage, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { resolveImage?: (src: string) => Promise<string> }) {
  const [resolved, setResolved] = useState(src)
  useEffect(() => {
    let live = true
    setResolved(src)
    if (src && resolveImage && !/^(?:https?:|data:|blob:)/i.test(src)) {
      void resolveImage(src).then((value) => { if (live) setResolved(value) }).catch(() => undefined)
    }
    return () => { live = false }
  }, [resolveImage, src])
  return <img {...props} alt={alt ?? ''} src={resolved} className="markdown-image" decoding="async" draggable={false} loading="lazy" />
}

function createComponents(onOpenLink?: MarkdownLinkHandler, resolveImage?: (src: string) => Promise<string>): Components {
  return {
    a: ({ node: _node, href = '', children, ...props }) => {
      const safeHref =
        secureUrlTransform(href, 'href', {
          type: 'element',
          tagName: 'a',
          properties: {},
          children: [],
        }) ?? ''

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (!safeHref) {
          event.preventDefault()
          return
        }

        if (safeHref.startsWith('#') && !onOpenLink) return

        // Electron must never navigate its renderer directly. The app decides
        // through its secure preload callback how local and external links open.
        event.preventDefault()
        if (onOpenLink) {
          void Promise.resolve(onOpenLink(safeHref)).catch((error: unknown) =>
            console.error('Link konnte nicht geöffnet werden.', error),
          )
        }
      }

      return (
        <a
          {...props}
          className="markdown-link"
          href={safeHref || undefined}
          onClick={handleClick}
          rel={isExternalLink(safeHref) ? 'noopener noreferrer' : undefined}
        >
          {children}
        </a>
      )
    },
    blockquote: ({ node: _node, ...props }) => (
      <blockquote className="markdown-blockquote" {...props} />
    ),
    code: ({ node: _node, className = '', ...props }) => (
      <code className={`markdown-code ${className}`.trim()} {...props} />
    ),
    img: ({ node: _node, alt = '', src, ...props }) => (
      <ResolvedImage {...props} alt={alt} src={typeof src === 'string' ? src : undefined} resolveImage={resolveImage} />
    ),
    input: ({ node: _node, type, ...props }) => (
      <input
        {...props}
        aria-label={type === 'checkbox' ? 'Aufgabe' : undefined}
        className={type === 'checkbox' ? 'markdown-task-checkbox' : undefined}
        disabled={type === 'checkbox' || props.disabled}
        type={type}
      />
    ),
    pre: ({ node: _node, ...props }) => (
      <pre className="markdown-code-block" tabIndex={0} {...props} />
    ),
    table: ({ node: _node, ...props }) => (
      <div className="markdown-table-scroll" tabIndex={0}>
        <table className="markdown-table" {...props} />
      </div>
    ),
    hr: ({ node: _node, ...props }) => <hr className="markdown-divider" {...props} />,
    details: ({ node: _node, ...props }) => <details className="markdown-details" {...props} />,
    summary: ({ node: _node, ...props }) => <summary className="markdown-summary" {...props} />,
  }
}

export function MarkdownPreview({
  content,
  onOpenLink,
  resolveImage,
  className = '',
  emptyMessage = 'Diese Notiz ist noch leer.',
}: MarkdownPreviewProps) {
  const expandedContent = useMemo(() => expandWikiLinks(content), [content])
  if (!content.trim()) {
    return (
      <div className={`markdown-preview markdown-preview--empty ${className}`.trim()}>
        <div className="markdown-preview__empty">{emptyMessage}</div>
      </div>
    )
  }

  return (
    <article className={`markdown-preview markdown-body ${className}`.trim()}>
      <ReactMarkdown
        components={createComponents(onOpenLink, resolveImage)}
        rehypePlugins={[
          rehypeRaw,
          rehypeHeadingIds,
          [rehypeSanitize, markdownSanitizeSchema],
          [rehypeKatex, { output: 'htmlAndMathml', strict: false, trust: false }],
        ]}
        remarkPlugins={[remarkGfm, remarkMath]}
        urlTransform={secureUrlTransform}
      >
        {expandedContent}
      </ReactMarkdown>
    </article>
  )
}

export default MarkdownPreview
