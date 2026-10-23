import type { ReactNode } from 'react'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { RunBoard } from './RunBoard'
import { useRunBoardShown } from './useRunBoardShown'
import './runBoard.css'

/** Keep the editor owner, DOM and buffered draft mounted at the SAME React key.
 * Pass the complete current-board UI (including Start/Save), not just its canvas.
 * The host must retain its existing guards for body-portalled authoring dialogs.
 * A host that also needs to know which Board is on screen passes its own `useRunBoardShown` result.
 */
export function RunBoardSlot({ selection, shown, children }: {
  selection: SelectedRunState; shown?: 'draft' | 'run'; children: ReactNode
}) {
  const current = selection.active && !selection.invalid && selection.identity.runId === null
  const own = useRunBoardShown(selection)
  const draftShown = (shown ?? own) === 'draft'
  return <div className="run-board-slot">
    <div className="run-board-current" hidden={!draftShown} inert={!current}>{children}</div>
    {!current ? <RunBoard selection={selection} hidden={draftShown} /> : null}
  </div>
}
