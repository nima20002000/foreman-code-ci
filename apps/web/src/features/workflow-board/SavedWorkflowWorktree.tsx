import { useQuery } from '@tanstack/react-query'
import type { WorkflowWorktreeSettings } from '@foreman-code/contracts/worktree-settings'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { assertSession, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { readWorktreeDetails } from '../../shared/api/worktreeChoices'

export function SavedWorkflowWorktree({ workspaceId, value, compact = false }: {
  workspaceId: string; value?: WorkflowWorktreeSettings
  /** One caption line, like the draft Board's "Worktree:" link. */
  compact?: boolean
}) {
  const generation = useHarnessSessionEpoch()
  const query = useQuery({ queryKey: ['workbench', 'saved-worktree', generation, workspaceId, value?.rootBinding],
    enabled: Boolean(value) && !sessionIsSwitching(),
    queryFn: async ({ signal }) => {
      if (!value) throw new Error('No saved default worktree is configured.')
      const result = await readWorktreeDetails(workspaceId, value.rootBinding, signal)
      assertSession(generation)
      return result
    },
  })
  if (sessionIsSwitching()) return null
  const details = !query.isError ? query.data : undefined
  if (compact) {
    const label = !value ? 'workspace default' : details?.label ?? (query.isPending ? 'Loading…' : 'saved source')
    return <p className="saved-workflow-worktree is-compact"
      title={value?.branchPrefix ? `Agent branches start with ${value.branchPrefix}` : undefined}>
      Worktree: <span>{label}</span>{details?.unavailableReason || query.isError ? <em> · unavailable</em> : null}</p>
  }
  return <section className="saved-workflow-worktree" aria-label="Saved default worktree">
    <strong>Default worktree</strong>
    {!value ? <p>Existing workspace placement saved with this version.</p> : <>
      <p>{details?.label ?? 'Configured source retained'}</p>
      <dl><dt>Agent branch prefix</dt><dd>{value.branchPrefix ?? 'Generated automatically'}</dd></dl>
      {query.isPending && <p role="status">Reading saved worktree details…</p>}
      {(query.isError || details?.unavailableReason) && <p role="status">{details?.unavailableReason
        ?? 'Saved worktree details are unavailable. The original source selection is retained.'}</p>}
    </>}
  </section>
}
