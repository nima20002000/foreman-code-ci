import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RunDirectionWait } from '@foreman-code/contracts/current'
import type { WorkflowExecutionChatTarget } from '@foreman-code/contracts'
import { appendExecutionChatDraft, executionChatDraftKey, getConversationDraft, useConversationDraftStore } from '../../conversations'
import { DirectionWaitNotice } from './directionWait'
import { acceptFindingsDirection } from './directionWaitModel'

const direction: RunDirectionWait = { workflowNodeId: 'node-master', agentId: 'agent-master', agentName: 'Master',
  executionId: 'execution-held', findings: ['Paris worker returned no facts'], findingsCount: 1,
  since: '2026-10-23T02:11:31.000Z' }

describe('direction wait notice', () => {
  it('offers Finish & accept findings beside Reply', async () => {
    const onAnswer = vi.fn(), onAccept = vi.fn()
    render(<DirectionWaitNotice direction={direction} onAnswer={onAnswer} onAccept={onAccept} />)
    await userEvent.click(screen.getByRole('button', { name: 'Finish & accept findings' }))
    expect(onAccept).toHaveBeenCalledOnce()
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('points at the Board\'s Stop button to end the Run without a reply', async () => {
    render(<DirectionWaitNotice direction={direction} onAnswer={vi.fn()} onAccept={vi.fn()} />)
    await userEvent.hover(screen.getByRole('button', { name: 'About Waiting for direction' }))
    const hint = await screen.findByText(/To end the Run without a reply/)
    expect(hint).toHaveTextContent('use the Stop button')
    expect(hint).not.toHaveTextContent('Run controls')
  })

  it('writes the accept reply into the exact Agent execution draft and keeps what was typed', () => {
    const target: WorkflowExecutionChatTarget = { kind: 'workflow_execution', agent: {
      workspaceId: 'workspace-direction', workflowId: 'workflow-direction',
      workflowNodeId: direction.workflowNodeId, agentId: direction.agentId,
    }, execution: { runId: 'run-direction', workflowVersionId: 'version-direction',
      executionId: direction.executionId, attempt: 1 } }
    const key = executionChatDraftKey(target)
    useConversationDraftStore.getState().setDraft(key, 'Keep this question')
    appendExecutionChatDraft(target, acceptFindingsDirection)
    appendExecutionChatDraft(target, acceptFindingsDirection)
    expect(getConversationDraft(key)).toBe(`Keep this question ${acceptFindingsDirection}`)
    expect(getConversationDraft(executionChatDraftKey({ ...target,
      execution: { ...target.execution, executionId: 'another-execution' } }))).toBe('')
  })
})
