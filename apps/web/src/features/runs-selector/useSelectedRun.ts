import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { defaultParseSearch, defaultStringifySearch, useRouter } from '@tanstack/react-router'
import { createRunSelectionSource } from './selectionGeneration'
import { readRunSelection, searchForSelectedRun, clearSelectedSubagentHash } from './search'
import type { RunsSelectorScope } from './types'

/** URL-owned navigation. A displayed Run may supply the draft Board’s inspection identity without selecting history. */
export function useSelectedRun({ workspaceId, workflowId }: RunsSelectorScope, displayedRunId?: string) {
  const router = useRouter()
  const source = useMemo(() => createRunSelectionSource(
    () => {
      const selection = readRunSelection({ workspaceId, workflowId }, {
        pathname: router.history.location.pathname,
        search: (router.options.parseSearch ?? defaultParseSearch)(router.history.location.search),
      })
      return displayedRunId && selection.identity.runId === null
        ? { ...selection, identity: { ...selection.identity, runId: displayedRunId } } : selection
    },
    (notify) => router.history.subscribe(notify),
  ), [router, workspaceId, workflowId, displayedRunId])
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const { generation } = snapshot
  const capture = useCallback(() => generation, [generation])
  const selectRun = useCallback((runId: string | null) => {
    // An old open menu/callback must not navigate back into a departed workspace.
    if (!source.getSnapshot().active) return Promise.resolve()
    const history = router.history.location
    const previous = (router.options.parseSearch ?? defaultParseSearch)(history.search)
    const search = searchForSelectedRun(previous, { workspaceId, workflowId }, runId)
    // Use the router (including blockers), never window.history.pushState.
    // href avoids tying this standalone lane to the app's registered search type
    // before the documented route mount has extended that type.
    const query = (router.options.stringifySearch ?? defaultStringifySearch)(search)
    const hash = source.getSnapshot().identity.runId === runId
      ? history.hash : clearSelectedSubagentHash(history.hash)
    return router.navigate({ href: `/workspaces/${encodeURIComponent(workspaceId)}${query}${hash}`,
      resetScroll: false, replace: false })
  }, [router, source, workspaceId, workflowId])
  return useMemo(() => ({ ...snapshot, capture, isCurrent: source.isCurrent, selectRun }),
    [snapshot, capture, source, selectRun])
}
export type SelectedRunState = ReturnType<typeof useSelectedRun>
