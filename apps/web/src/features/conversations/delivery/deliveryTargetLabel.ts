import type { DeliveryTarget } from '@foreman-code/contracts'

/** Where a message went, in words a person reads. IDs stay out of the label. */
export function deliveryTargetLabel(target: DeliveryTarget): string {
  if (target.kind === 'operator_conversation') return 'Operator'
  if (target.kind === 'agent_conversation') return 'Agent chat'
  if (target.kind === 'workflow_coordinator') return 'Run · waiting for child reports'
  return `Run · attempt ${target.execution.attempt}`
}
