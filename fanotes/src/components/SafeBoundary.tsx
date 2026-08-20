import { Component, type ErrorInfo, type ReactNode } from 'react'

type SafeBoundaryProps = {
  name: string
  children: ReactNode
  fallbackTitle?: string
}

type SafeBoundaryState = {
  error: Error | null
}

/**
 * Isolates a pane so a render crash cannot take the whole desktop window with it.
 */
export class SafeBoundary extends Component<SafeBoundaryProps, SafeBoundaryState> {
  state: SafeBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): SafeBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`FaNotes: ${this.props.name} ist abgestürzt.`, error, info.componentStack)
  }

  render() {
    const error = this.state.error
    if (!error) return this.props.children
    return (
      <div className="safe-boundary" role="alert">
        <strong>{this.props.fallbackTitle ?? 'Dieser Bereich ist abgestürzt'}</strong>
        <span>{error.message || 'Unbekannter Fehler'}</span>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Erneut versuchen
        </button>
      </div>
    )
  }
}
