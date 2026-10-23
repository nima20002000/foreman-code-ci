import type { QueryClient } from '@tanstack/react-query'
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'

/**
 * Local interaction state that must live as long as one QueryClient (the access session's cache) but is not server
 * state. TanStack Query only owns what the server returns; values like retained command identities and readback
 * proof live here instead. Each QueryClient gets its own store, so separate trees and tests never share state.
 */
export function createClientScopedStore<State>(initial: () => State) {
  const stores = new WeakMap<QueryClient, StoreApi<State>>()
  const forClient = (client: QueryClient): StoreApi<State> => {
    let store = stores.get(client)
    if (!store) { store = createStore<State>(initial); stores.set(client, store) }
    return store
  }
  return {
    forClient,
    /** The current state, or the initial state when this client never stored anything. */
    read: (client: QueryClient): State => stores.get(client)?.getState() ?? initial(),
    write: (client: QueryClient, update: (state: State) => State) => { forClient(client).setState(update(forClient(client).getState()), true) },
    use: <Selected>(client: QueryClient, select: (state: State) => Selected): Selected => useStore(forClient(client), select),
  }
}
