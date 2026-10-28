import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from './Button'
import { EmptyState } from './EmptyState'

export interface ErrorBoundaryProps {
  children: ReactNode
  /** 'screen' (default): "Reload screen" remounts the children. 'app': the whole window, "Reload app" reloads the page. */
  scope?: 'screen' | 'app'
  /** Called once an error is caught, for a parent that can do better than the error screen (the first-run reveal). */
  onError?: (error: Error) => void
}

interface State {
  error: Error | null
  /** Bumped by "Reload screen" so the children remount from scratch. */
  attempt: number
}

/** Catches render errors below it and shows an EmptyState instead of a blank window. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Render error caught by ErrorBoundary:', error, info.componentStack)
    this.props.onError?.(error)
  }

  override render(): ReactNode {
    const { error, attempt } = this.state
    const app = this.props.scope === 'app'
    if (error) {
      return (
        <EmptyState
          icon={<AlertTriangle />}
          title={app ? 'Claudock hit an error' : 'This screen hit an error'}
          description={error.message || String(error)}
          action={
            <Button
              variant="primary"
              onClick={() => (app ? window.location.reload() : this.setState((s) => ({ error: null, attempt: s.attempt + 1 })))}
            >
              {app ? 'Reload app' : 'Reload screen'}
            </Button>
          }
        />
      )
    }
    return <Fragment key={attempt}>{this.props.children}</Fragment>
  }
}
