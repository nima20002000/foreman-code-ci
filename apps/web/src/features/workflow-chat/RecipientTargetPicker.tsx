import type { AgentIdentity, DeliveryTarget, WorkflowChatPostRequest } from '@foreman-code/contracts'
import type { UseQueryResult } from '@tanstack/react-query'
import { Button, Icon, IconButton, Select } from '../../shared/ui/nocturne'
import { deliveryAction, type DeliveryPresentation } from '../chat-core'
import { sameDeliveryTarget } from './draft'
import { recipientProblem } from './recipientProblem'
import { agentLabel } from './mentions'

export type RecipientTargetOption = {
  target: DeliveryTarget
  label: string
  presentation: DeliveryPresentation
  deliveryTargetState?: 'existing' | 'not_created'
}
export type WorkflowTargetResolver = (agent: AgentIdentity, input: {
  signal: AbortSignal
  recovery?: 'outside_run' | 'historical_follow_up'
  sourceTarget?: DeliveryTarget
}) => Promise<RecipientTargetOption[]>
type Delivery = WorkflowChatPostRequest['deliveries'][number]

export function RecipientTargetPicker({ agent, selection, result, onSelect, onIntent, onRemove }: {
  agent: AgentIdentity
  selection?: Delivery
  result: UseQueryResult<RecipientTargetOption[]>
  onSelect(option: RecipientTargetOption): void
  onIntent(intent: Delivery['intent']): void
  onRemove(): void
}) {
  const options = result.data ?? []
  const selected = selection ? options.findIndex(item => sameDeliveryTarget(item.target, selection.target)) : -1
  const option = options[selected]
  const problem = recipientProblem(selection, result)
  return <fieldset className="workflow-chat-recipient">
    <legend className="n-sr-only">{agentLabel(agent)}</legend>
    <div className="workflow-chat-recipient-row">
      <strong>@{agent.displayName}</strong>
      <Select label={`Target for ${agent.displayName}`} value={selected < 0 ? '' : String(selected)}
        options={[{ value: '', label: result.isPending ? 'Loading…' : 'Choose where to send', disabled: true }, ...options.map((item, index) => ({
          value: String(index), label: `${item.label}${item.deliveryTargetState === 'not_created' ? ' · new chat' : ''}`,
        }))]} disabled={result.isPending}
        onChange={event => { const item = options[Number(event.target.value)]; if (item) onSelect(item) }} />
      {selection ? <Select label={`Delivery for ${agent.displayName}`} value={selection.intent}
        options={[
          { value: 'auto', label: option ? `Auto · ${deliveryAction(option.presentation, 'auto').label}` : 'Auto' },
          { value: 'next_turn', label: 'Queue next' }, { value: 'steer', label: 'Steer now' },
          { value: 'interrupt_and_send', label: 'Interrupt' },
        ]} onChange={event => {
          const intent = event.target.value
          if (intent === 'auto' || intent === 'next_turn' || intent === 'steer' || intent === 'interrupt_and_send') onIntent(intent)
        }} /> : null}
      <IconButton size="sm" variant="ghost" label={`Remove ${agent.displayName}`} onClick={onRemove}><Icon name="close" size={14} /></IconButton>
    </div>
    {problem || result.isError || selection && option && selection.expectedNativeTurnId !== option.presentation.nativeTurnId
      ? <p className="workflow-chat-notice">{problem}
        {result.isError ? <Button size="sm" variant="ghost" onClick={() => void result.refetch()}>Retry</Button> : null}
        {selection && option && selection.expectedNativeTurnId !== option.presentation.nativeTurnId
          ? <Button size="sm" variant="ghost" onClick={() => onSelect(option)}>Refresh target</Button> : null}</p> : null}
  </fieldset>
}
