import { createContext, useContext } from 'react'

/** A floating panel's header row; a chat shown inside it puts its status and context meter there. */
export const PanelHeaderSlotContext = createContext<HTMLElement | null>(null)
export const usePanelHeaderSlot = () => useContext(PanelHeaderSlotContext)
