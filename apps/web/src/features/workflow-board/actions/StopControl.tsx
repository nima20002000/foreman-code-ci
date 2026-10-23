import { InfoHint } from '../../../shared/ui/InfoHint'
import { useRef } from 'react'
import { Button } from '../../../shared/ui/nocturne'
import { useMutation } from '@tanstack/react-query'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { reserveBoardStop, sendBoardStop, recordBoardStopReceipt, settleBoardStop, useBoardStopOutbox } from '../stopOutbox'
import { runActionsClient } from './client'
import { useActionLifetime } from './state'
import type { ActionRun } from './policy'

export function StopReceipt({ scope }: { scope: RepeatGraphScopeV3 }) {
  const { journal } = useBoardStopOutbox(scope)
  const receipt = journal?.receipt
  return receipt ? <p role="status">Stop receipt: {receipt.status}{receipt.replayed ? ' (sent again)' : ''}.{' '}
    {receipt.status === 'not_owner' ? 'Another app instance runs this, so the stop isn’t confirmed.'
      : receipt.processStopped ? 'The agent process stopped.' : 'Waiting for the agent process to stop.'}
    {' '}Cleanup isn’t confirmed yet.</p> : null
}

export function StopControl({ scope, run, permitted, available, refresh }: {
  scope: RepeatGraphScopeV3; run: ActionRun; permitted: boolean; available: boolean; refresh(): void
}) {
  const outbox = useBoardStopOutbox(scope), life = useActionLifetime(), heading = useRef<HTMLHeadingElement>(null)
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
  const settlement = useMutation({ retry: false, gcTime: 0, mutationFn: async () => {
    const journal = outbox.journal
    if (!journal?.receipt || journal.receipt.status === 'not_owner') throw new Error('Send the stop first, then check cleanup.')
    const fresh = await runActionsClient.status(scope, { signal: life.signal })
    life.assertCurrent()
    if (fresh.executionState !== 'completed' || fresh.cleanupPending) throw new Error('Cleanup is still running. Check again in a moment.')
    await settleBoardStop(scope, journal.request)
    return 'Cleanup confirmed. This run has fully stopped.'
  }, onError: refresh, onSuccess: () => heading.current?.focus() })
  const reason = !permitted ? 'You can’t stop this run.'
    : !available ? 'Stop isn’t available right now.'
      : outbox.error ?? (run.executionState === 'completed' && !run.cleanupPending && !outbox.journal ? 'Nothing to stop.' : undefined)
  const receipt = outbox.journal?.receipt ?? stop.data
  return <section aria-label="Stop and cleanup">
    <h4 ref={heading} tabIndex={-1}>Stop and cleanup<InfoHint label="Stop">Stops this run’s agents. Board edits are not saved or discarded.</InfoHint></h4>
    <p role="status">{run.cleanupPending ? 'Cleanup pending. Some work may still be shutting down.'
      : run.executionState === 'completed' ? 'This run has finished.'
        : run.directionWait ? `${run.directionWait.agentName} is waiting for your direction. Stop ends the Run here without it.`
          : 'This run is still running.'}</p>
    <div className="n-actions">
      <Button size="sm" variant="danger" disabled={!!reason || stop.isPending || settlement.isPending} title={reason}
        onClick={() => stop.mutate()}>{stop.isPending ? 'Stopping…' : outbox.journal ? 'Reconcile Stop' : 'Stop this Run'}</Button>
      {outbox.journal?.receipt && outbox.journal.receipt.status !== 'not_owner' ? <Button size="sm"
        disabled={run.executionState !== 'completed' || run.cleanupPending || settlement.isPending || stop.isPending}
        onClick={() => settlement.mutate()}>Verify cleanup settlement</Button> : null}
    </div>
    {reason ? <p className="n-field-hint">{reason}</p> : null}
    {stop.isError ? <p role="alert">Stop is not confirmed: {stop.error.message} Try again to resend the same stop.</p> : null}
    {receipt ? <StopReceipt scope={scope} /> : null}
    {settlement.isError ? <p role="alert">{settlement.error.message}</p> : null}
    {settlement.data ? <p role="status">{settlement.data}</p> : null}
  </section>
}
