import { create } from 'zustand'
import { useMutation } from '@tanstack/react-query'
import { Button } from '../shared/ui/nocturne'
import { sessionGeneration } from '../shared/api/sessionBoundary'
import type { BrowserSession, BrowserUiPort } from '../features/agent-browser/types'
import { browserUiClient, browserProfilesClient } from './browserClients'

interface Cleanup {
  id: string; generation: number; message: string; retry(): Promise<void>
}
// These are retained command identities and launch selections, never a mirror of browser query state.
export const useBrowserRecovery = create<{
  pending: Cleanup[]; setup: BrowserSession | null
  retain(value: Cleanup): void; remove(id: string): void; openSetup(session: BrowserSession | null): void
}>(set => ({ pending: [], setup: null,
  retain: value => set(state => ({ pending: [...state.pending.filter(item => item.id !== value.id), value] })),
  remove: id => set(state => ({ pending: state.pending.filter(item => item.id !== id) })),
  openSetup: setup => set({ setup }),
}))
const held = new Map<string, { session: BrowserSession; viewerId: string; epoch: number; commandId: string; generation: number }>()
async function retained(id: string, message: string, work: () => Promise<void>, generation = sessionGeneration()) {
  try { await work(); useBrowserRecovery.getState().remove(id) }
  catch (error) {
    useBrowserRecovery.getState().retain({ id, generation, message, retry: () => retained(id, message, work, generation) })
    throw error
  }
}
export const browserSessionClient: BrowserUiPort = { ...browserUiClient,
  async acquire(...args) {
    const control = await browserUiClient.acquire(...args)
    if (control.controllingViewerId === args[1]) held.set(args[0].id, { session: args[0], viewerId: args[1], epoch: control.epoch,
      commandId: crypto.randomUUID(), generation: sessionGeneration() })
    return control
  },
  async release(...args) {
    let result!: Awaited<ReturnType<BrowserUiPort['release']>>
    await retained(args[3], 'Browser control has not been returned yet.', async () => {
      result = await browserUiClient.release(...args)
      if (result.controllingViewerId === args[1]) throw new Error('Browser control is still held.')
      held.delete(args[0].id)
    })
    return result
  },
  async closeSession(...args) {
    let result!: Awaited<ReturnType<BrowserUiPort['closeSession']>>
    await retained(args[1], 'Browser cleanup is still pending.', async () => {
      result = await browserUiClient.closeSession(...args)
      if (result === 'pending') throw new Error('Browser cleanup is still pending.')
      held.delete(args[0].id)
    })
    return result
  },
}
export const browserProfileClient = { ...browserProfilesClient, closeSetup: browserSessionClient.closeSession }
export async function returnBrowserControl() {
  const current = [...held.values()].filter(item => item.generation === sessionGeneration())
  const results = await Promise.allSettled(current.map(item => browserSessionClient.release(item.session, item.viewerId, item.epoch, item.commandId)))
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length) throw new AggregateError(failures, 'Browser control return needs attention.')
}
export function retainSetupCleanup(session: BrowserSession, message: string) {
  const commandId = crypto.randomUUID(), generation = sessionGeneration()
  useBrowserRecovery.getState().retain({ id: commandId, generation, message,
    retry: async () => { await browserSessionClient.closeSession(session, commandId) } })
}
export function BrowserRecovery() {
  const pending = useBrowserRecovery(state => state.pending)
  const mutation = useMutation({ mutationFn: (item: Cleanup) => item.retry(), retry: false })
  return <>{pending.filter(item => item.generation === sessionGeneration()).map(item => <div role="alert" key={item.id}>
    <p>{item.message}</p><Button disabled={mutation.isPending} onClick={() => mutation.mutate(item)}>Retry browser cleanup</Button>
  </div>)}{mutation.error ? <p role="alert">{mutation.error.message}</p> : null}</>
}
