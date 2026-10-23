import { useRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationComposer } from './ConversationComposer'
import { AgentChatComposer } from './agentChat/AgentChatComposer'
import { OperatorComposer } from '../operator-chat/OperatorComposer'
import { useConversationDraftStore } from '../chat-core'

afterEach(() => { cleanup(); useConversationDraftStore.getState().clearAllDrafts() })

for (const kind of ['conversation', 'agent', 'operator'] as const) describe(`${kind} composer draft interactions`, () => {
  function Composer({ id, send, attachments = false }: { id: string; send: ReturnType<typeof vi.fn>; attachments?: boolean }) {
    const input = useRef<HTMLTextAreaElement>(null)
    if (kind === 'conversation') return <ConversationComposer conversationId={id} onSubmit={send} hasAttachments={attachments} />
    if (kind === 'operator') return <OperatorComposer conversationId={id} onSubmit={send} onNewChat={vi.fn()} hasAttachments={attachments} />
    return <AgentChatComposer name="Coder" draftKey={id} inputRef={input} disabled={false} pending={false}
      controlPending={false} canStop={false} onStop={vi.fn()} onSubmit={send} hasAttachments={attachments} />
  }

  it('keeps separate drafts when the selected conversation changes and never clears an unacknowledged send', () => {
    const send = vi.fn()
    const view = render(<Composer id="first" send={send} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'First draft' } })
    view.rerender(<Composer id="second" send={send} />)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Second draft' } })
    view.rerender(<Composer id="first" send={send} />)
    const input = screen.getByRole('textbox', { name: 'Message' })
    expect(input).toHaveValue('First draft')
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(send).toHaveBeenCalledExactlyOnceWith('First draft', ...(kind === 'agent' ? [undefined] : []))
    expect(input).toHaveValue('First draft')
    view.rerender(<Composer id="second" send={send} />)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Second draft')
  })

  it('completes Plan without sending on Tab and sends the completed task with its mode', () => {
    const send = vi.fn()
    render(<Composer id="chat" send={send} />)
    const input = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: '/p' } })
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input).toHaveValue('/plan')
    expect(send).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '/plan Inspect files' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(send).toHaveBeenCalledExactlyOnceWith('/plan Inspect files', 'plan')
  })

  it('allows attachment-only submission while keeping whitespace handling specific to each composer', () => {
    const send = vi.fn()
    render(<Composer id="chat" send={send} attachments />)
    const input = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(send).toHaveBeenCalledExactlyOnceWith(kind === 'agent' ? '  ' : '', ...(kind === 'agent' ? [undefined] : []))
  })
})
