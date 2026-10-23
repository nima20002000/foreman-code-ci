import { useState } from 'react'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { useRunBoardReady } from './useRunBoardReady'

/** Which Board is on screen. Leaving the draft for a Run keeps the draft shown until the Run can be drawn, so Start
 * never flashes an empty or loading Board; moving between Runs shows the new Run's own loading state at once. */
export function useRunBoardShown(selection: SelectedRunState): 'draft' | 'run' {
  const current = selection.active && !selection.invalid && selection.identity.runId === null
  const ready = useRunBoardReady(selection)
  const [shown, setShown] = useState<'draft' | 'run'>(current ? 'draft' : 'run')
  const next = current ? 'draft' : ready ? 'run' : shown
  if (next !== shown) setShown(next)
  return next
}
