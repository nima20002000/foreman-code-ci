import type { ChatDeliveryIntent, EngineChatReadback } from '@foreman-code/contracts'
import { Button, Select } from '../../../shared/ui/nocturne'

export type DeliveryPresentation = Pick<EngineChatReadback, 'state' | 'capabilities'> & {
  nativeTurnId?: string
  hasAttachments?: boolean
  changesMode?: boolean
  unavailableReason?: string
}

export function deliveryAction(presentation: DeliveryPresentation, intent: ChatDeliveryIntent) {
  const { state, capabilities, hasAttachments, changesMode, unavailableReason } = presentation
  const active = state === 'active'
  const queue = active || state === 'queued' || state === 'starting'
  const steerReason = !active ? 'No active turn is selected.'
    : capabilities.steer !== 'native_expected_turn' ? 'Live steering is unavailable for this target.'
      : !presentation.nativeTurnId ? 'Waiting for the active turn identity.'
        : hasAttachments ? 'Files need a new turn.'
          : changesMode ? 'Changing mode needs a new turn.' : undefined
  const applied = intent === 'auto' ? active && !steerReason ? 'steer' : 'next_turn' : intent
  const reason = unavailableReason ?? (state === 'settling' ? 'Wait for this turn to stop.'
    : applied === 'steer' ? steerReason
      : applied === 'interrupt_and_send' && (!active || !capabilities.interruptAndSend)
        ? 'Interrupt and send is unavailable for this target.'
        : applied === 'next_turn' && !capabilities.queue ? 'Ordinary delivery is unavailable for this target.' : undefined)
  const label = applied === 'steer' ? 'Steer now'
    : applied === 'interrupt_and_send' ? 'Interrupt and send' : queue ? 'Queue next' : 'Send'
  return { applied, label, reason }
}

/** Selecting an intent never submits. The primary button and composer Enter share one action. */
export function ChatDeliveryActions({ presentation, intent, onIntentChange, onSubmit, pending, empty, reason,
  onStop, stopReason, onCancelQueued, queueCount = 0, controlsReason }: {
  presentation: DeliveryPresentation
  intent: ChatDeliveryIntent
  onIntentChange(intent: ChatDeliveryIntent): void
  onSubmit(): void
  pending?: boolean
  empty?: boolean
  reason?: string
  onStop?: () => void
  stopReason?: string
  onCancelQueued?: () => void
  queueCount?: number
  controlsReason?: string
}) {
  const action = deliveryAction(presentation, intent)
  const disabledReason = reason ?? action.reason
  const options: Array<{ value: ChatDeliveryIntent; label: string }> = [
    { value: 'auto', label: 'Automatic' }, { value: 'next_turn', label: 'Queue next' },
    { value: 'steer', label: 'Steer now' }, { value: 'interrupt_and_send', label: 'Interrupt and send' },
  ]
  return <div className="chat-delivery-actions">
    <div className="n-actions" role="group" aria-label="Message delivery">
      <Select label="Delivery action" value={intent} options={options} disabled={pending}
        onChange={event => {
          const selected = options.find(option => option.value === event.target.value)
          if (selected) onIntentChange(selected.value)
        }} />
      <Button type="button" variant="primary" aria-label={action.label === 'Send' ? 'Send message' : undefined} loading={pending} disabled={pending || empty || !!disabledReason}
        onClick={onSubmit}>{action.label}</Button>
      {onStop ? <Button type="button" disabled={pending || !!stopReason || !!controlsReason} onClick={onStop}>Stop active turn</Button> : null}
      {onCancelQueued && queueCount > 0 ? <Button type="button" disabled={pending || !!controlsReason}
        onClick={onCancelQueued}>Cancel queued messages ({queueCount})</Button> : null}
    </div>
    {disabledReason ? <p role="status">{disabledReason}</p> : null}
    {intent === 'interrupt_and_send' ? <p>Stops this turn, then sends your message. Work already done stays.</p> : null}
    {stopReason ? <p>{stopReason}</p> : null}
    {controlsReason && controlsReason !== disabledReason ? <p role="status">{controlsReason}</p> : null}
  </div>
}
