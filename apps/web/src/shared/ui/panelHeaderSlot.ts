import { createContext, useContext } from 'react'

/** A floating panel's header row; a chat shown inside it puts its name there. */
export const PanelHeaderSlotContext = createContext<HTMLElement | null>(null)
export const usePanelHeaderSlot = () => useContext(PanelHeaderSlotContext)
/** A floating panel's footer row, below the chat's composer; a chat puts its context meter there. */
export const PanelFooterSlotContext = createContext<HTMLElement | null>(null)
export const usePanelFooterSlot = () => useContext(PanelFooterSlotContext)
