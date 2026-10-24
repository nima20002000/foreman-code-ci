import { useEffect } from 'react'
import { useRouter } from '@tanstack/react-router'
import { IdSchema } from '@foreman-code/contracts'
import { useOperatorChatVisibility } from './useOperatorChatVisibility'
import { useOperatorChatStore } from './operatorChatStore'

const parameter = 'operatorConversationId'

/** URL owns selection. The store mirrors it for asynchronous send/recovery consumers.
 * A fragment lets this global window keep its destination on every application route. */
export function OperatorChatNavigation() {
  const router = useRouter()
  const enabled = useOperatorChatVisibility()
  useEffect(() => {
    if (!enabled) return
    let applyingLocation = false
    let previousConversationId = useOperatorChatStore.getState().selectedConversationId
    const selectLocation = () => {
      const fragment = new URLSearchParams(router.state.location.hash)
      const raw = fragment.get(parameter)
      const parsed = raw === null ? undefined : IdSchema.safeParse(raw)
      const id = parsed?.success ? parsed.data : undefined
      const changed = id !== previousConversationId
      previousConversationId = id
      const store = useOperatorChatStore.getState()
      applyingLocation = true
      if (store.selectedConversationId !== id) store.select(id)
      if (changed && id && !store.open) store.setOpen(true)
      applyingLocation = false
    }
    const writeLocation = (id: string | undefined, replace = false) => {
      const fragment = new URLSearchParams(router.latestLocation.hash)
      if (fragment.get(parameter) === (id ?? null)) return
      if (id) fragment.set(parameter, id)
      else fragment.delete(parameter)
      void router.navigate({ to: router.latestLocation.pathname, search: true, hash: fragment.toString(), replace, resetScroll: false })
    }
    const initial = new URLSearchParams(router.state.location.hash)
    if (initial.has(parameter)) selectLocation()
    else {
      previousConversationId = useOperatorChatStore.getState().selectedConversationId
      writeLocation(previousConversationId, true)
    }
    const stopLocation = router.subscribe('onResolved', selectLocation)
    const stopSelection = useOperatorChatStore.subscribe((state, previous) => {
      if (!applyingLocation && state.selectedConversationId !== previous.selectedConversationId) {
        previousConversationId = state.selectedConversationId
        writeLocation(state.selectedConversationId)
      }
    })
    return () => { stopLocation(); stopSelection() }
  }, [enabled, router])
  return null
}
