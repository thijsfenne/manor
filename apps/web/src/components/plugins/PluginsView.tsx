import type { ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { EASE_OUT, INSTANT } from '../../motion'
import { SegmentedControl, type SegmentOption } from '../ui/SegmentedControl'

export type PluginSection = 'connectors' | 'skills' | 'suggestions'

const SECTIONS: readonly SegmentOption<PluginSection>[] = [
  { value: 'connectors', label: 'Connectors', tabId: 'plugins-tab-connectors', panelId: 'plugins-connectors' },
  { value: 'skills', label: 'Skills', tabId: 'plugins-tab-skills', panelId: 'plugins-skills' },
  { value: 'suggestions', label: 'Suggestions', tabId: 'plugins-tab-suggestions', panelId: 'plugins-suggestions' },
]

interface PluginsViewProps {
  section: PluginSection
  children: ReactNode
}

interface PluginsTabsProps {
  section: PluginSection
  onOpenConnectors: () => void
  onOpenSkills: () => void
  onOpenSuggestions: () => void
}

/** The Plugins header switch; navigation stays beside the place it changes. */
export function PluginsTabs({ section, onOpenConnectors, onOpenSkills, onOpenSuggestions }: PluginsTabsProps) {
  const selectSection = (next: PluginSection) => {
    if (next === section) return
    if (next === 'connectors') onOpenConnectors()
    else if (next === 'skills') onOpenSkills()
    else onOpenSuggestions()
  }

  // 2px down, so the segment labels sit on the same optical line as the Plugins
  // title beside them: the selected pill's own height rides higher than the text.
  return (
    <span className="mt-0.5 inline-flex">
      <SegmentedControl label="Plugin section" options={SECTIONS} value={section} onChange={selectSection} />
    </span>
  )
}

/** One capability room; each segment keeps ownership of its existing registry view. */
export function PluginsView({ section, children }: PluginsViewProps) {
  const reduceMotion = useReducedMotion()

  return (
    <div className="grid min-h-0 grid-rows-[minmax(0,1fr)]">
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={section}
          id={`plugins-${section}`}
          role="tabpanel"
          aria-labelledby={`plugins-tab-${section}`}
          className="min-h-0 overflow-hidden"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduceMotion ? undefined : { opacity: 0 }}
          transition={reduceMotion ? INSTANT : { duration: 0.12, ease: EASE_OUT }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
