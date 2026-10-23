import { useMutation } from '@tanstack/react-query'
import type { RepeatGraphScopeCurrent } from '@foreman-code/contracts/current'
import { reserveBoardStop, sendBoardStop, recordBoardStopReceipt, useBoardStopOutbox } from '../stopOutbox'
import { runActionsClient } from './client'
import { useActionLifetime } from './state'

/** The Board's one Stop command: reserve the stop journal, send it, record its receipt. A retry resends the same stop. */
export function useRunStop(scope: RepeatGraphScopeCurrent, refresh: () => void) {
  const outbox = useBoardStopOutbox(scope), life = useActionLifetime()
  const stop = useMutation({ retry: false, gcTime: 0, mutationFn: async () => {
    life.assertCurrent()
    const options = { signal: life.signal }
    await runActionsClient.authorize('runs:stop', scope, options)
    const [fresh, capabilities] = await Promise.all([runActionsClient.status(scope, options), runActionsClient.capabilities(options)])
    if (!capabilities.stopAvailable) throw new Error('Stop isn’t available here. Nothing was sent.')
    if (fresh.executionState === 'completed' && !fresh.cleanupPending && !outbox.journal) {
      throw new Error('This run has already finished. Nothing to stop.')
    }
    life.assertCurrent()
    const journal = await reserveBoardStop(scope)
    life.assertCurrent()
    const receipt = await sendBoardStop(journal)
    life.assertCurrent()
    await recordBoardStopReceipt(journal, receipt)
    refresh()
    return receipt
  }, onError: refresh })
  return { stop, outbox, life }
}
