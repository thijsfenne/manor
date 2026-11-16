import { createContext, useContext } from 'react'

export type HouseDrawer = { open: boolean; setOpen: (open: boolean) => void }

/** The house menu, which wraps the tab bar in `(tabs)/_layout.tsx`. */
export const HouseDrawerContext = createContext<HouseDrawer | null>(null)

export function useHouseDrawer(): HouseDrawer {
  const drawer = useContext(HouseDrawerContext)
  if (drawer === null) throw new Error('useHouseDrawer must be used inside the tabs layout')
  return drawer
}
