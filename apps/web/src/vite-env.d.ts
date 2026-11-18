/// <reference types="vite/client" />

// Declared explicitly so the override reads as `string | undefined` instead of
// falling through to vite's `any` index signature.
interface ImportMetaEnv {
  readonly VITE_MANOR_WS?: string
  readonly VITE_MANOR_AUTH?: 'off' | 'on'
}
