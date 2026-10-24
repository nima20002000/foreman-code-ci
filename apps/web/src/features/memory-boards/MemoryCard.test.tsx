import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCard } from './MemoryCard'
import { memoryTestCard } from './testing'

afterEach(cleanup)

describe('MemoryCard', () => {
  it('shows what the Agent wrote on its card without opening it', () => {
    render(<MemoryCard card={memoryTestCard({ title: 'Worker', body: '1. Spear (film)\n2. Donald Neilson' })} nodes={[]} onOpen={() => {}} />)
    expect(screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === '1. Spear (film)\n2. Donald Neilson')).toBeVisible()
  })
  it('opens from its title', () => {
    const onOpen = vi.fn()
    render(<MemoryCard card={memoryTestCard({ title: 'Worker' })} nodes={[]} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: 'Worker' }))
    expect(onOpen).toHaveBeenCalledOnce()
  })
})
