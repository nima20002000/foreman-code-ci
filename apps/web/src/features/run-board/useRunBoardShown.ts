import { useEffect, useState } from 'react'
import type { SelectedRunState } from '../runs-selector'
import { useRunBoardReady } from './useRunBoardReady'

/** How long the draft may stay up while a started Run is read; a slower read shows the Run board's own loading. */
const DRAFT_HOLD_MS = 600

/** Which Board is on screen. Leaving the draft for a Run keeps the draft shown until the Run can be drawn (or for
 * at most DRAFT_HOLD_MS), so Start never flashes an empty or loading Board yet a slow, offline or hanging read never
 * strands the person on an inert draft. Moving between Runs shows the new Run's own loading state at once. */
export function useRunBoardShown(selection: SelectedRunState): 'draft' | 'run' {
  const current = selection.active && !selection.invalid && selection.identity.runId === null
  const ready = useRunBoardReady(selection)
  const visit = selection.generation.id
  const [shown, setShown] = useState<'draft' | 'run'>(current ? 'draft' : 'run')
  const [held, setHeld] = useState<typeof visit>()
  useEffect(() => {
    if (current || ready) return
    const timer = setTimeout(() => setHeld(visit), DRAFT_HOLD_MS)
    return () => clearTimeout(timer)
  }, [current, ready, visit])
  const next = current ? 'draft' : ready || held === visit ? 'run' : shown
  if (next !== shown) setShown(next)
  return next
}
