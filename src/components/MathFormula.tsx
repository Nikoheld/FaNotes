import { useMemo } from 'react'
import katex from 'katex'

type Props = {
  latex: string
  fallback: string
}

const MathFormula = ({ latex, fallback }: Props) => {
  const html = useMemo(() => {
    try {
      return katex.renderToString(latex, {
        displayMode: true,
        throwOnError: false,
        strict: 'warn',
        trust: false,
        output: 'htmlAndMathml',
      })
    } catch {
      return ''
    }
  }, [latex])

  if (!html) return <span className="math-formula-fallback">{fallback}</span>

  return (
    <div
      className="math-formula"
      aria-label={fallback || latex}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export default MathFormula
