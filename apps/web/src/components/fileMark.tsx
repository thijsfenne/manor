import { useEffect, useSyncExternalStore, type ComponentPropsWithoutRef } from 'react'

export const baseName = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path

type LoadedMarks = typeof import('./fileMarkLoaded')
type MarkState = { module: LoadedMarks | null; error: unknown }
let state: MarkState = { module: null, error: null }
let pending: Promise<void> | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const snapshot = () => state

function loadMarks() {
  pending ??= import('./fileMarkLoaded').then(
    (module) => { state = { module, error: null }; listeners.forEach((listener) => listener()) },
    (error: unknown) => { state = { module: null, error }; listeners.forEach((listener) => listener()) },
  )
}

interface FileMarkProps extends Omit<ComponentPropsWithoutRef<'svg'>, 'children' | 'height' | 'width'> {
  path: string
  size?: number
}

/** The sprite loads only when a file mark first appears in the interface. */
export function FileMarkSprite() {
  const { module } = useSyncExternalStore(subscribe, snapshot, snapshot)
  return module ? <module.FileMarkSprite /> : null
}

export function FileMark({ path, size = 14, ...props }: FileMarkProps) {
  const { module, error } = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(loadMarks, [])
  if (error) throw error
  return module
    ? <module.FileMark path={path} size={size} {...props} />
    : <span aria-hidden className="inline-block flex-none" style={{ width: size, height: size }} />
}
