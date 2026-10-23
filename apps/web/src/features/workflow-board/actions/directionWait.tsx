import type { RunDirectionWait } from '@foreman-code/contracts/current'
import { Button, Icon } from '../../../shared/ui/nocturne'
import { InfoHint } from '../../../shared/ui/InfoHint'
import './actions.css'

export function DirectionWaitNotice({ direction, onAnswer, onAccept }: { direction: RunDirectionWait; onAnswer(): void; onAccept(): void }) {
  const more = direction.findingsCount - direction.findings.length
  const findings = [...direction.findings, ...more > 0 ? [`and ${more} more`] : []].join(' · ') || direction.summary
  return <div className="direction-wait-notice" role="status">
    <Icon name="warning" size={16} />
    <div className="direction-wait-text">
      <strong>{direction.agentName} is waiting for your direction
        <InfoHint label="Waiting for direction">{`The Run continues when you reply. Finish & accept findings writes a reply that tells ${direction.agentName} to finish with these findings as they are; send it from Group chat. To end the Run without a reply, use the Stop button.`}</InfoHint></strong>
      {findings ? <span className="direction-wait-finding" title={findings}>{findings}</span> : null}
    </div>
    <Button size="sm" variant="primary" onClick={onAnswer}>Reply to {direction.agentName}</Button>
    <Button size="sm" variant="ghost" onClick={onAccept}>Finish & accept findings</Button>
  </div>
}
