import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { EngineChatReadback } from '@foreman-code/contracts'
import { ChatDeliveryActions } from './ChatDeliveryActions'
import { deliveryAction } from '../../chat-core'

const capabilities: EngineChatReadback['capabilities'] = {
  steer: 'native_expected_turn', queue: true, interruptAndSend: true,
}

describe('Chat delivery controls', () => {
  it('selects interruption without sending and submits only from the primary action', () => {
    const submit = vi.fn(), change = vi.fn()
    const props = { presentation: { state: 'active' as const, capabilities, nativeTurnId: 'turn-a' },
      intent: 'auto' as const, onIntentChange: change, onSubmit: submit }
    const view = render(<ChatDeliveryActions {...props} />)
    fireEvent.change(screen.getByLabelText('Delivery action'), { target: { value: 'interrupt_and_send' } })
    expect(change).toHaveBeenCalledWith('interrupt_and_send')
    expect(submit).not.toHaveBeenCalled()
    view.rerender(<ChatDeliveryActions {...props} intent="interrupt_and_send" />)
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt and send' }))
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('keeps a selected steering mode recoverable after its active turn finishes', () => {
    const change = vi.fn()
    const props = { intent: 'steer' as const, onIntentChange: change, onSubmit: vi.fn() }
    const view = render(<ChatDeliveryActions {...props} presentation={{ state: 'active', capabilities, nativeTurnId: 'turn-a' }} />)
    view.rerender(<ChatDeliveryActions {...props} presentation={{ state: 'idle', capabilities }} />)
    fireEvent.change(screen.getByLabelText('Delivery action'), { target: { value: 'auto' } })
    expect(change).toHaveBeenCalledWith('auto')
    view.rerender(<ChatDeliveryActions {...props} intent="auto" presentation={{ state: 'idle', capabilities }} />)
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
  })

  it('uses qualified steering for auto but queues files or a mode change', () => {
    const selected = { state: 'active' as const, capabilities, nativeTurnId: 'turn-a' }
    expect(deliveryAction(selected, 'auto').label).toBe('Steer now')
    expect(deliveryAction({ ...selected, hasAttachments: true }, 'auto').label).toBe('Queue next')
    expect(deliveryAction({ ...selected, changesMode: true }, 'auto').label).toBe('Queue next')
    expect(deliveryAction({ ...selected, capabilities: { ...capabilities, steer: 'unavailable' } }, 'auto').label).toBe('Queue next')
  })

  it('keeps stop and cancel queue distinct from sending', () => {
    const stop = vi.fn(), cancel = vi.fn(), submit = vi.fn()
    render(<ChatDeliveryActions presentation={{ state: 'active', capabilities, nativeTurnId: 'turn-a' }}
      intent="auto" onIntentChange={vi.fn()} onSubmit={submit} onStop={stop} onCancelQueued={cancel} queueCount={2} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued messages (2)' }))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('disables ordinary delivery on an idle target without that capability', () => {
    const submit = vi.fn()
    render(<ChatDeliveryActions presentation={{ state: 'idle', capabilities: { ...capabilities, queue: false } }}
      intent="auto" onIntentChange={vi.fn()} onSubmit={submit} />)
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Send message' }).parentElement!)
    expect(screen.getByRole('tooltip')).toHaveTextContent('This agent can\'t take a new message here.')
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('Follow up in Agent chat')
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(submit).not.toHaveBeenCalled()
  })

  it('visibly disables Stop and queued cancellation while offline', () => {
    const stop = vi.fn(), cancel = vi.fn()
    render(<ChatDeliveryActions presentation={{ state: 'active', capabilities, nativeTurnId: 'turn-a' }}
      intent="auto" onIntentChange={vi.fn()} onSubmit={vi.fn()} onStop={stop} onCancelQueued={cancel} queueCount={2}
      controlsReason="You are offline. Controls are unavailable." reason="You are offline. Your draft is kept." />)
    expect(screen.getByRole('button', { name: 'Stop active turn' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel queued messages (2)' })).toBeDisabled()
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Stop active turn' }).parentElement!)
    expect(screen.getByRole('tooltip')).toHaveTextContent('You are offline. Controls are unavailable.')
    fireEvent.click(screen.getByRole('button', { name: 'Stop active turn' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued messages (2)' }))
    expect(stop).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
  })
})
