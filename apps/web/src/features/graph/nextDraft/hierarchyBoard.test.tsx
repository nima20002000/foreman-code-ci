import { cleanup, render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GraphPresentationProvider } from '../GraphPresentation'
import { useGraphDraftStore } from '../store'
import { fixture } from './core.cases'
import { DraftCanvas } from './DraftCanvas'
import { nextDraftKey } from './state'

const key = nextDraftKey('workspace', 'workflow')
// The owner's saved positions: the entry at the origin and its three children stacked in one column.
const context = fixture(['coder', 'coder', 'coder', 'coder'])
const stacked = [{ x: 0, y: 0 }, { x: 320, y: 180 }, { x: 320, y: 360 }, { x: 320, y: 540 }]
context.draft.graph.nodes.forEach((node, index) => { node.position = stacked[index]! })

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('DOMMatrixReadOnly', class { m11 = 1; m22 = 1; m41 = 0; m42 = 0 })
  useGraphDraftStore.getState().installNextDraft(key, structuredClone(context))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useGraphDraftStore.getState().clearAllDrafts() })

const placed = (id: string) => {
  const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!
  const [, x, y] = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(node.style.transform)!
  return { x: Number(x), y: Number(y) }
}

it('draws a coordinator and its children as a hierarchy, not a column', async () => {
  render(<GraphPresentationProvider><ReactFlowProvider><DraftCanvas draftKey={key} graph={context.draft.graph}
    agents={context.agents.map((item) => item.agent)} kind="execution" change={vi.fn()} geometry={vi.fn()}
    pending={vi.fn()} report={vi.fn()} /></ReactFlowProvider></GraphPresentationProvider>)
  await screen.findByRole('button', { name: /^Node 3, / })
  const entry = placed('node-0'), children = ['node-1', 'node-2', 'node-3'].map(placed)
  expect(new Set(children.map((point) => point.y)).size).toBe(1)
  expect(new Set(children.map((point) => point.x)).size).toBe(3)
  expect(children[0]!.y).toBeGreaterThan(entry.y)
})
