import { lazy, Suspense, useCallback, useState, type ComponentType } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import type { UnicornSceneProps, UnicornStudioScene } from 'unicornstudio-react'
import type { Theme } from '../useTheme'

/** Manor's Unicorn Studio scenes, one per theme, authored at 1440×900 for the new-session stage. */
const STAGE_SCENE_IDS: Record<Theme, string> = {
  dark: 'VPzq1xVuLROilDwI2VUV',
  light: 'gdVZtemiYFIOeMylUYJp',
}

// The SDK is close to a megabyte, so it loads with the first stage rather than with the app.
// A failed load leaves the plain background: decoration never takes the stage down with it.
const UnicornScene = lazy(
  (): Promise<{ default: ComponentType<UnicornSceneProps> }> =>
    import('unicornstudio-react').catch(() => ({ default: () => null })),
)

/**
 * The animated layer behind the new-session stage's heading and composer. Fills its
 * positioned parent, ignores the pointer, and carries the scene drawn for the theme on
 * screen. A theme switch starts the other scene fresh, so it fades in like the first.
 *
 * The scene itself is window-sized and pinned to the stage's bottom-right corner, which
 * neither the sidebar nor focus mode moves. Folding those away only uncovers more of it:
 * a resize makes the SDK rebuild its render targets, which reads as the scene restarting.
 */
export function StageBackdrop({ theme }: { theme: Theme }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden bg-bg">
      <StageScene key={theme} projectId={STAGE_SCENE_IDS[theme]} />
    </div>
  )
}

/**
 * Fades in from the plain background. `onLoad` fires when the scene is built, before the
 * GPU has settled its first frames, so the fade waits two frames and then runs slow and
 * even: an ease-out spends its first steps on frames that are still being dropped.
 */
function StageScene({ projectId }: { projectId: string }) {
  const reduce = useReducedMotion() ?? false
  const [ready, setReady] = useState(false)
  const reveal = () => requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)))
  // The SDK's paused prop misses scenes that finish loading after its effect.
  const setScene = useCallback((scene: UnicornStudioScene | null) => {
    if (scene !== null) scene.paused = reduce
  }, [reduce])
  return (
    <motion.div
      className="absolute right-0 bottom-0 h-screen w-screen"
      initial={false}
      animate={{ opacity: ready ? 1 : 0 }}
      transition={reduce ? { duration: 0 } : { duration: 1.2, ease: 'easeInOut' }}
    >
      <Suspense fallback={null}>
        <UnicornScene
          projectId={projectId}
          width="100%"
          height="100%"
          lazyLoad={false}
          sceneRef={setScene}
          showPlaceholderWhileLoading={false}
          showPlaceholderOnError={false}
          onLoad={reveal}
        />
      </Suspense>
    </motion.div>
  )
}
