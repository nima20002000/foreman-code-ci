import type { ChatDeliveryIntent } from '@foreman-code/contracts'
import { deliveryAction, type DeliveryPresentation } from './deliveryAction'
import { ArrowUp, Square, X } from 'lucide-react'
import { IconButton, Select, Tooltip } from '../../../shared/ui/nocturne'

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
  // Icon controls that sit inside the composer box; why sending is blocked shows in the composer itself.
  return <div className="chat-delivery-actions" role="group" aria-label="Message delivery">
    {/* Keep a chosen mode visible after settlement so it can be reset without losing the draft. */}
    {presentation.state === 'active' || intent !== 'auto' ? <Select label="Delivery action" value={intent} options={options} disabled={pending}
      onChange={event => {
        const selected = options.find(option => option.value === event.target.value)
        if (selected) onIntentChange(selected.value)
      }} /> : null}
    {onCancelQueued && queueCount > 0 ? <Tooltip content={controlsReason ?? `Cancel queued messages (${queueCount})`}>
      <IconButton label={`Cancel queued messages (${queueCount})`} variant="ghost" disabled={pending || !!controlsReason}
        onClick={onCancelQueued}><X size={14} aria-hidden="true" /></IconButton></Tooltip> : null}
    {onStop ? <Tooltip content={stopReason ?? controlsReason ?? 'Stop active turn'}>
      <IconButton label="Stop active turn" variant="ghost" disabled={pending || !!stopReason || !!controlsReason}
        onClick={onStop}><Square size={13} fill="currentColor" aria-hidden="true" /></IconButton></Tooltip> : null}
    <Tooltip content={disabledReason ?? (intent === 'interrupt_and_send' ? 'Stops this turn, then sends your message' : action.label)}>
      <IconButton type="button" variant="primary" className="agent-chat-send" label={action.label === 'Send' ? 'Send message' : action.label}
        loading={pending} disabled={pending || empty || !!disabledReason} onClick={onSubmit}><ArrowUp size={17} aria-hidden="true" /></IconButton>
    </Tooltip>
  </div>
}
