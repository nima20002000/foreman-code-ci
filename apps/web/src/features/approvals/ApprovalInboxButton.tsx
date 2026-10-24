import { Inbox } from 'lucide-react'
import { Button } from '../../shared/ui/nocturne'
import { useInteractionsQuery } from '../../shared/api/query'
import { useApprovalInboxStore } from './approvalInboxStore'

export function ApprovalInboxButton({ workspaceId, workflowId }: { workspaceId: string; workflowId: string }) {
  const approvals = useInteractionsQuery({ workspaceId, workflowId, status: 'pending', limit: 100 })
  const pending = approvals.data?.items.filter(item => item.approval.handler === 'user').length
  return <Button variant="secondary" className="n-icon-button workflow-approval-inbox"
    aria-label={`Open human approval inbox${pending ? `, ${pending} pending` : ''}`} title="Approval inbox"
    onClick={event => useApprovalInboxStore.getState().openInbox({ workspaceId, workflowId }, event.currentTarget.getBoundingClientRect())}>
    <Inbox aria-hidden="true" size={16} />
    {pending ? <span className="workflow-approval-inbox-badge" aria-hidden="true">{pending}</span> : null}
  </Button>
}
