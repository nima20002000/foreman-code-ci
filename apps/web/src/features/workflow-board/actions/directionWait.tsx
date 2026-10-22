import type { RunDirectionWait } from '@foreman-code/contracts/wave25'
import { Button, Icon } from '../../../shared/ui/nocturne'
import { InfoHint } from '../../../shared/ui/InfoHint'
import './actions.css'

export function DirectionWaitNotice({ direction, onAnswer }: { direction: RunDirectionWait; onAnswer(): void }) {
  const more = direction.findingsCount - direction.findings.length
  const findings = [...direction.findings, ...more > 0 ? [`and ${more} more`] : []].join(' · ') || direction.summary
  return <div className="direction-wait-notice" role="status">
    <Icon name="warning" size={16} />
    <div className="direction-wait-text">
      <strong>{direction.agentName} is waiting for your direction
        <InfoHint label="Waiting for direction">The Run continues when you reply. To end it here without a reply, use Run controls · Stop.</InfoHint></strong>
      {findings ? <span className="direction-wait-finding" title={findings}>{findings}</span> : null}
    </div>
    <Button size="sm" variant="primary" onClick={onAnswer}>Reply to {direction.agentName}</Button>
  </div>
}
