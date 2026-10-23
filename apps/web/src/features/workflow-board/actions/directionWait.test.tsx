import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RunDirectionWait } from '@foreman-code/contracts/wave25'
import { readWorkflowDraft, workflowDraftKey } from '../../workflow-chat/draft'
import { DirectionWaitNotice } from './directionWait'
import { acceptFindingsDirection, mentionInGroupChat } from './directionWaitModel'

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

  it('writes the accept reply to the Master into the group chat draft and keeps what was typed', () => {
    const scope = { workspaceId: 'workspace-direction', workflowId: 'workflow-direction' }
    mentionInGroupChat(scope, direction)
    const key = workflowDraftKey(scope)
    expect(readWorkflowDraft(key).body).toBe('@Master ')
    mentionInGroupChat(scope, direction, acceptFindingsDirection)
    mentionInGroupChat(scope, direction, acceptFindingsDirection)
    const draft = readWorkflowDraft(key)
    expect(draft.body).toBe(`@Master ${acceptFindingsDirection}`)
    expect(draft.mentions).toEqual([{ workflowNodeId: 'node-master', start: 0, end: 7 }])
  })
})
