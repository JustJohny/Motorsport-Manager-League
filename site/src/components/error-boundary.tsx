import { Component, type ReactNode } from "react"

/** Shows a render error instead of unmounting the whole app to a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="mx-auto max-w-xl p-8 text-foreground">
        <h1 className="text-lg font-semibold">Something went wrong on this page</h1>
        <pre className="mt-3 whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{this.state.error.message}</pre>
        <button className="mt-4 text-sm underline" onClick={() => location.reload()}>Reload</button>
      </div>
    )
  }
}
