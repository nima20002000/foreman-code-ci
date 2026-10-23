import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { Button } from '../../../shared/ui/nocturne'
import { useDismissableSurface } from '../../../shared/ui/useDismissableSurface'
import { runActionsClient, type RunActionSelection } from './client'
import { actionKey, useDisclosure } from './state'
import { SelectedRunStop } from './SelectedRunStop'
import './actions.css'

/** A small popover under its toolbar button, so opening it never reflows the toolbar. */
export function SelectedRunControls({ scope, visible }: {
  scope: RunActionSelection & Partial<Pick<RepeatGraphScopeV3, 'workflowVersionId'>>
  visible: boolean
}) {
  const [open, setOpen] = useDisclosure()
  const trigger = useRef<HTMLButtonElement>(null), surface = useRef<HTMLDivElement>(null)
  useDismissableSurface({ open: open && visible, onDismiss: () => setOpen(false), surfaceRef: surface, triggerRef: trigger })
  // Same query as the Stop control; a finished run with nothing left to clean up has nothing to stop.
  const status = useQuery({ queryKey: actionKey(scope, 'status', scope.workflowVersionId ?? null),
    queryFn: ({ signal }) => runActionsClient.status(scope, { signal }), staleTime: 1000, gcTime: 0,
    refetchInterval: query => query.state.data?.executionState === 'completed' && !query.state.data.cleanupPending ? false : 5000 })
  const finished = status.data?.executionState === 'completed' && !status.data.cleanupPending
  if (finished) return null
  return <section className="selected-run-controls" aria-label="Selected Run controls" hidden={!visible} inert={!visible}>
    <Button ref={trigger} size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
      Run controls · Stop
    </Button>
    {open && visible ? <div ref={surface} className="selected-run-controls-popover"><SelectedRunStop scope={scope} /></div> : null}
  </section>
}
