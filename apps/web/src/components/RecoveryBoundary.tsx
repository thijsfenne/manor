import { Component, Suspense, lazy, type FunctionComponent, type ReactNode } from 'react'
import { Modal } from './Modal'
import { Button } from './ui/Button'

interface BoundaryProps {
  /** A new value clears a caught failure, so moving on is also a way out of it. */
  resetKey?: unknown
  fallback: (retry: () => void) => ReactNode
  children: ReactNode
}

interface BoundaryState {
  failed: boolean
  resetKey: unknown
}

/**
 * Catches a render exception or a rejected lazy chunk below it. Event handlers and
 * async work still report their own failures; this only keeps a broken subtree from
 * taking the tree above it down.
 */
export class RecoveryBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false, resetKey: this.props.resetKey }

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { failed: false, resetKey: props.resetKey }
  }

  private retry = () => this.setState({ failed: false })

  override render() {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children
  }
}

/**
 * `React.lazy` remembers a rejected import forever, so a retry would rethrow the same
 * failure. This swaps in a fresh loader after a rejection: the next render imports again.
 */
export function retryableLazy<P extends object>(load: () => Promise<FunctionComponent<P>>): FunctionComponent<P> {
  // The loaded component takes its props under one concrete key, which keeps the
  // lazy wrapper's ref-aware prop type from swallowing the generic `P`.
  const fresh = () =>
    lazy(() =>
      load().then(
        (Loaded) => ({ default: ({ inner }: { inner: P }) => <Loaded {...inner} /> }),
        (error: unknown) => {
          current = fresh()
          throw error
        },
      ),
    )
  let current = fresh()
  return function RetryableLazy(props: P) {
    const Current = current
    return <Current inner={props} />
  }
}

/** The whole window's last resort, around the app itself. */
export function ShellBoundary({ children }: { children: ReactNode }) {
  return (
    <RecoveryBoundary
      fallback={() => (
        <main className="grid h-full place-items-center p-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="m-0 text-dim">Manor ran into a problem.</p>
            <Button onClick={() => window.location.reload()}>Reload</Button>
          </div>
        </main>
      )}
    >
      {children}
    </RecoveryBoundary>
  )
}

/**
 * One stage view, loading or failed in place. The sidebar and rails stay usable, and
 * picking another view clears the failure through `resetKey`.
 */
export function ViewBoundary({ resetKey, loading, children }: { resetKey: unknown; loading: ReactNode; children: ReactNode }) {
  return (
    <RecoveryBoundary
      resetKey={resetKey}
      fallback={(retry) => (
        <div className="flex min-h-0 min-w-0 flex-col items-center justify-center gap-3 bg-bg px-5 text-center">
          <p className="m-0 text-dim">This view did not load.</p>
          <Button onClick={retry}>Try again</Button>
        </div>
      )}
    >
      <Suspense fallback={loading}>{children}</Suspense>
    </RecoveryBoundary>
  )
}

/**
 * A lazily loaded dialog. Nothing shows while its chunk arrives; a failure keeps the
 * dialog's own shell, so closing works the way it always does.
 */
export function DialogBoundary({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <RecoveryBoundary
      fallback={(retry) => (
        <Modal title="This did not open" onClose={onClose}>
          <div className="flex justify-end">
            <Button variant="primary" onClick={retry}>Try again</Button>
          </div>
        </Modal>
      )}
    >
      <Suspense fallback={null}>{children}</Suspense>
    </RecoveryBoundary>
  )
}
