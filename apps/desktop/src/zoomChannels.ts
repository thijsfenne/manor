/**
 * Main tells the renderer the shell zoom so the titlebar inset can stay in
 * window points. The sandboxed preload writes the same literal out; a
 * disagreement is icons that drift under the traffic lights the moment Cmd+-
 * is pressed.
 */
export const ZOOM_CHANNEL = 'manor:zoom'

/**
 * True while the window is in native macOS fullscreen, where the traffic lights
 * are gone and the titlebar inset would be a hole. Same preload-literal rule.
 */
export const FULLSCREEN_CHANNEL = 'manor:fullscreen'
