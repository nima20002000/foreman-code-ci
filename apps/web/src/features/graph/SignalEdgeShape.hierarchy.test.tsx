// @vitest-environment jsdom
import { ReactFlowProvider } from '@xyflow/react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SignalEdgeShape } from './SignalEdgeShape'

afterEach(cleanup)
const curve = { path: 'M 0,0 Q 100,100 200,0', mid: { x: 100, y: 50, angle: 0 } }
it('draws every agent connection as one plain line without a reporting label or info icon', () => {
  const view = render(<ReactFlowProvider><svg><SignalEdgeShape id="parent-route" curve={curve} kind="execution" /></svg></ReactFlowProvider>)
  expect(screen.queryByText('Orchestrates')).not.toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(view.container.querySelector('.n-signal-edge')).toHaveAttribute('data-kind', 'execution')
  view.rerender(<ReactFlowProvider><svg><SignalEdgeShape id="approval-route" curve={curve} kind="approval" /></svg></ReactFlowProvider>)
  expect(view.container.querySelector('.n-signal-edge')).toHaveAttribute('data-kind', 'approval')
})
