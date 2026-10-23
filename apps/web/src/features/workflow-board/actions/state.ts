import { useEffect, useRef, useState } from 'react'
import { sessionGeneration, assertSession } from '../../../shared/api/sessionBoundary'
import type { RunActionSelection } from './client'

/** Per-mount presentation only: no Run, approval, permission or command receipts.
 * The parent is keyed by session and URL-selected Run. Query owns all requests. */
export function useDisclosure() {
  const [open, setOpen] = useState(false)
  return [open, setOpen as (open: boolean) => void] as const
}
export function useActionLifetime() {
  const generation = sessionGeneration()
  const current = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    current.current = controller
    return () => controller.abort()
  }, [generation])
  return {
    get signal() { return current.current?.signal },
    assertCurrent: () => {
      assertSession(generation)
      if (!current.current) throw new Error('Run controls are not mounted.')
      current.current.signal.throwIfAborted()
    },
  }
}
export const actionKey = (selection: RunActionSelection, ...suffix: readonly unknown[]) =>
  ['workbench', 'pinned-v3-run-details', sessionGeneration(), selection.workspaceId, selection.workflowId,
    selection.runId, 'actions', ...suffix] as const
