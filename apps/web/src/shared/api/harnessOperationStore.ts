import type { QueryClient } from '@tanstack/react-query'
import type { HarnessConfiguration } from '@foreman-code/contracts'
import { createClientScopedStore } from './clientScopedStore'
import type { PluginOperation } from './codexPluginOperation'
import type { ManagedMcpOperation } from './managedMcpOperation'

/**
 * Retained Codex plugin and managed MCP operations. Their identity belongs to the access session (the epoch), not to a
 * mounted settings panel, so a remounted panel finds the original command. This is local state, not a server read.
 */
export type PluginOperationState = { operation: PluginOperation | null; settled: string[] }
export const emptyPluginOperationState: PluginOperationState = { operation: null, settled: [] }

type Store = { plugin: Record<number, PluginOperationState>; managed: Record<string, ManagedMcpOperation | null> }
const operations = createClientScopedStore<Store>(() => ({ plugin: {}, managed: {} }))
const managedId = (epoch: number, harness: HarnessConfiguration['harness']) => `${epoch}:${harness}`

export const readPluginOperation = (client: QueryClient, epoch: number): PluginOperationState =>
  operations.read(client).plugin[epoch] ?? emptyPluginOperationState
export const usePluginOperation = (client: QueryClient, epoch: number): PluginOperationState =>
  operations.use(client, (state) => state.plugin[epoch] ?? emptyPluginOperationState)
/** Returning the same state skips the write. Entries from earlier epochs are dropped. */
export function updatePluginOperation(client: QueryClient, epoch: number,
  transform: (previous: PluginOperationState) => PluginOperationState): void {
  operations.write(client, (state) => {
    const previous = state.plugin[epoch] ?? emptyPluginOperationState
    const next = transform(previous)
    return next === previous ? state : { ...state, plugin: { [epoch]: next } }
  })
}

export const readManagedOperation = (client: QueryClient, epoch: number, harness: HarnessConfiguration['harness']): ManagedMcpOperation | null =>
  operations.read(client).managed[managedId(epoch, harness)] ?? null
export const useManagedOperation = (client: QueryClient, epoch: number, harness: HarnessConfiguration['harness']): ManagedMcpOperation | null =>
  operations.use(client, (state) => state.managed[managedId(epoch, harness)] ?? null)
export function writeManagedOperation(client: QueryClient, epoch: number, harness: HarnessConfiguration['harness'],
  operation: ManagedMcpOperation | null): void {
  operations.write(client, (state) => {
    const kept = Object.fromEntries(Object.entries(state.managed).filter(([id]) => id.startsWith(`${epoch}:`)))
    return { ...state, managed: { ...kept, [managedId(epoch, harness)]: operation } }
  })
}
