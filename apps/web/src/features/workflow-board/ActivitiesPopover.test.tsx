import { useCallback, useRef, useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ActivitiesPopover } from './ActivitiesPopover'

function Harness() {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const find = useCallback(() => trigger.current, [])
  return <div>
    <button ref={trigger} type="button" aria-label="Activities" onClick={() => setOpen(true)}>Activities</button>
    <button type="button">Elsewhere</button>
    <ActivitiesPopover open={open} onClose={() => setOpen(false)} findAnchor={find}>
      <ul aria-label="Rows">
        <li>Builder finished</li><li>Reviewer started</li>
      </ul>
    </ActivitiesPopover>
  </div>
}

const popover = () => screen.queryByRole('region', { name: 'Activities popover' })

describe('Activities popover', () => {
  it('opens next to the button with its activity rows and no sidebar or dialog', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(popover()).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Activities' }))
    expect(popover()).toBeVisible()
    expect(screen.getByText('Builder finished')).toBeVisible()
    expect(screen.getByText('Reviewer started')).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('closes on Escape and returns focus to the button', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const button = screen.getByRole('button', { name: 'Activities' })
    await user.click(button)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(popover()).not.toBeInTheDocument())
    expect(button).toHaveFocus()
  })

  it('closes on an outside click but not on a click inside', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Activities' }))
    await user.click(screen.getByText('Builder finished'))
    expect(popover()).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }))
    await waitFor(() => expect(popover()).not.toBeInTheDocument())
  })

  it('closes with its own button and when the toolbar button is pressed again', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const button = screen.getByRole('button', { name: 'Activities' })
    await user.click(button)
    await user.click(screen.getByRole('button', { name: 'Close Activities' }))
    await waitFor(() => expect(popover()).not.toBeInTheDocument())
    await user.click(button)
    expect(popover()).toBeVisible()
    await user.click(button)
    await waitFor(() => expect(popover()).not.toBeInTheDocument())
  })
})
