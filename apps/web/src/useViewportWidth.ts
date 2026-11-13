import { useEffect, useState } from 'react'

/** The live CSS viewport width, used only for layout decisions CSS cannot derive from stored panel widths. */
export function useViewportWidth() {
  const [width, setWidth] = useState(() => window.innerWidth)

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return width
}
