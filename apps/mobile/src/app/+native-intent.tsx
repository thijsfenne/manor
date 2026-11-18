/**
 * The system opens the app with `manor://pair#…` when the camera scans a pairing code.
 * That is not a screen: the connection provider reads the link and the Connect screen
 * asks to confirm it. A cold launch starts on the home route; an app already open stays
 * on the screen it shows.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  if (!/^(manor:\/\/)?\/?pair([?#]|$)/i.test(path)) return path
  return initial ? '/' : null
}
