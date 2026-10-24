import { useEffect, useMemo, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiError } from '../../../shared/api/client'
import { readLocalHumanAccess, settingsExperienceKeys, useLocalHumanAccessQuery } from '../../../shared/api/settingsExperience'
import { assertSession, sessionGeneration } from '../../../shared/api/sessionBoundary'
import {
  canUseBoardAction, boardStartPins, changedAgentIds, readBoardStartPreflight, sameBoardStartPins,
  currentBoardStartRequest, useBoardStartPreflight, boardStartClient, type BoardStartInput,
  acknowledgeBoardStart, readBoardStart, rejectBoardStart, reserveBoardStart, useBoardStartOutbox,
  scopeForBoardRun, recoverBoardStart,
} from '../../workflow-board'
import { boardRunListKey, type useWorkflowBoard, nextDraftDirty, type NextDraftEdit } from '../../board-core'
import { useGraphDraftStore } from '../store'
import type { DraftEditorCore } from './useDraftEditorCore'
import type { useDraftEditorSave } from './useDraftEditorSave'
import type { useGraphEditIntent } from './useGraphEditIntent'

/** Start permission, saved-version preflight and the durable Start outbox. */
export function useDraftStartState({ draftKey, edit, board }: {
  draftKey: string
  edit: NextDraftEdit
  board: ReturnType<typeof useWorkflowBoard>
}) {
  const graph = edit.graph, context = edit.context
  const preflight = useBoardStartPreflight(context.draft, { enabled: board?.authoringActive !== false || !!board?.runActionHost })
  const access = useLocalHumanAccessQuery()
  const principal = !access.isError ? access.data?.principal : undefined
  const canStart = !!principal && Date.parse(principal.expiresAt) > Date.now()
    && canUseBoardAction(principal.grants, 'runs:start', { workspaceId: graph.workspaceId, workflowId: graph.id })
  const startOutbox = useBoardStartOutbox(draftKey)
  const storageFailed = !!startOutbox.error
  const pendingStart = startOutbox.request
  const facts = preflight.data
  const changedAgents = useMemo(() => facts ? changedAgentIds(facts) : [], [facts])
  useEffect(() => {
    // Show and pin the Agents' current settings; their changes are already saved on the Agent.
    if (!facts || !changedAgents.length) return
    useGraphDraftStore.getState().updateNextDraft(draftKey, (current) => {
      const fresh = facts.agents.filter(({ agent }) => changedAgents.includes(agent.id) && !current.agentEdits?.[agent.id]
        && current.context.agents.find((item) => item.agent.id === agent.id)?.agent.configurationVersionId !== agent.configurationVersionId)
      if (!fresh.length) return current
      const ids = new Set(fresh.map(({ agent }) => agent.id))
      return { ...current, context: { ...current.context, agents: [...current.context.agents.filter(({ agent }) => !ids.has(agent.id)), ...fresh] } }
    })
  }, [draftKey, facts, changedAgents])
  return { preflight, canStart, startOutbox, storageFailed, pendingStart, changedAgents }
}
export type DraftStartState = ReturnType<typeof useDraftStartState>

/** Save-then-start (or reconcile the earlier Start) for the exact saved version. */
export function useDraftStartMutation({ draftKey, edit, editIntent, core, startState, stopAndSave }: {
  draftKey: string
  edit: NextDraftEdit
  editIntent: ReturnType<typeof useGraphEditIntent>
  core: DraftEditorCore
  startState: DraftStartState
  stopAndSave: ReturnType<typeof useDraftEditorSave>['stopAndSave']
}) {
  const graph = edit.graph
  const { alive, latestBoard, runAfterSave, setLocalError, setMessage, report } = core
  const { canStart, preflight } = startState
  const queryClient = useQueryClient()
  const startLock = useRef(false)
  const saveContinuation = useRef<{
    intentId: string; instanceId: string; generation: number; selectionToken: unknown
  } | undefined>(undefined)
  const startMutation = useMutation({ retry: false, mutationFn: async (options?: { saveFirst?: boolean; allowStop?: boolean; savedVersionId?: string }) => {
    if (startLock.current) return
    const generation = sessionGeneration()
    const selectionToken = latestBoard.current?.getSelectionToken?.()
    let sent: BoardStartInput | undefined
    startLock.current = true; setLocalError(undefined)
    try {
      // Reconcile the original persisted command before considering current pins
      // or capabilities. A lost acknowledgement never becomes a second Start.
      if (!canStart) throw new Error('Start permission is unavailable for this exact workflow. No command was sent.')
      const existing = readBoardStart(draftKey)
      if (!existing && !useGraphDraftStore.getState().nextDrafts[draftKey]?.graph.nodes.length) {
        throw new Error('Add an agent before saving and running.')
      }
      let savedVersionId = options?.savedVersionId
      let saved = !!savedVersionId
      if (!existing && options?.saveFirst) {
        runAfterSave.current = true
        const result = await stopAndSave(options.allowStop)
        assertSession(generation)
        saved = result.intent?.state === 'saved'
        if (!alive.current) return
        if (!saved) {
          if (result.intent && result.intent.state !== 'discarded') {
            saveContinuation.current = { intentId: result.intent.id, generation,
              instanceId: edit.instanceId, selectionToken }
          }
          return
        }
        savedVersionId = result.intent?.result?.currentVersionId
        if (!savedVersionId) throw new Error('The saved workflow version is unavailable. Reconcile the save before Start.')
        saveContinuation.current = undefined
        runAfterSave.current = false
      }
      const current = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (!current) throw new Error('The draft is no longer mounted.')
      if (savedVersionId && current.context.draft.baseWorkflowVersionId !== savedVersionId) {
        throw new Error('The saved workflow changed before Save and run could continue.')
      }
      let candidate = existing
      if (!candidate) {
        if (current.busy || current.pending || current.startCanceled || (!saved && editIntent.locked) || nextDraftDirty(current)
          || current.startRejectedVersionId === current.context.draft.baseWorkflowVersionId
          || (!saved && (preflight.isError || !preflight.data))) throw new Error('Save, reload or reconcile before creating a new Start.')
        const displayedPins = saved ? undefined : boardStartPins(current.context.draft, preflight.data!)
        const [fresh, access] = await Promise.all([
          readBoardStartPreflight(current.context.draft),
          queryClient.fetchQuery({ queryKey: settingsExperienceKeys.access(), staleTime: 0,
            queryFn: ({ signal }) => readLocalHumanAccess({ signal }) }),
        ])
        assertSession(generation)
        const principal = access.principal
        if (!principal || Date.parse(principal.expiresAt) <= Date.now()
          || !canUseBoardAction(principal.grants, 'runs:start', { workspaceId: graph.workspaceId, workflowId: graph.id })) {
          throw new Error('Start permission is unavailable for this workflow. No command was sent.')
        }
        if (!alive.current || latestBoard.current?.getSelectionToken?.() !== selectionToken) {
          throw new Error('Selection changed before Start. The saved workflow is kept.')
        }
        if ((displayedPins && !sameBoardStartPins(displayedPins, boardStartPins(current.context.draft, fresh)))
          || useGraphDraftStore.getState().nextDrafts[draftKey] !== current) {
          throw new Error('The displayed Start pins or local form changed. Reload before starting a new Run.')
        }
        candidate = currentBoardStartRequest(current.context.draft, fresh, crypto.randomUUID())
      }
      sent = await reserveBoardStart(draftKey, candidate)
      const result = await boardStartClient.start(sent)
      assertSession(generation)
      const acknowledgement = await acknowledgeBoardStart(draftKey, sent)
      void queryClient.invalidateQueries({ queryKey: boardRunListKey(graph.workspaceId, graph.id) })
      if (!alive.current || useGraphDraftStore.getState().nextDrafts[draftKey]?.instanceId !== current.instanceId) return
      if (acknowledgement !== 'superseded' && latestBoard.current?.getSelectionToken?.() === selectionToken) {
        // One Board: the new Run shows on these nodes; the Board stays where it is.
        const board = latestBoard.current
        if (board?.showRunOnBoard) board.showRunOnBoard(result.run.id)
        else board?.selectRun(scopeForBoardRun(result.run))
      }
      setMessage('Start acknowledged for the exact saved version. Run status is read separately.')
    } catch (error) {
      // A definite rejection is shown as one plain message, never as an uncertain earlier Start.
      let shown = error
      try {
        assertSession(generation)
        if (sent && await rejectBoardStart(draftKey, sent, error)) {
          const code = (error as ApiError).code
          if (code === 'WORKFLOW_VERSION_UNSUPPORTED' || code === 'EXECUTION_SEMANTICS_UNSUPPORTED') {
            const rejectedVersion = sent.workflowVersionId
            useGraphDraftStore.getState().updateNextDraft(draftKey, (current) => ({ ...current, startRejectedVersionId: rejectedVersion }))
            shown = new Error('This saved version can no longer start. Reload the saved draft before starting another Run.')
          } else if (code === 'WORKFLOW_CONFIGURATION_STALE') {
            shown = new Error('Agent settings changed since this workflow was saved. Save and run to use them.')
            void preflight.refetch()
          } else shown = new Error((error as ApiError).message)
        }
        report(shown)
      } catch (releaseError) { report(releaseError) }
      // Navigation guards must not treat failed/uncertain Start as a successful save.
      throw shown
    } finally { startLock.current = false }
  } })
  const recovery = useMutation({ retry: false, mutationFn: async () => {
    if (startLock.current) return
    const selectionToken = latestBoard.current?.getSelectionToken?.()
    startLock.current = true
    try {
      if (!canStart) throw new Error('Start permission is unavailable for this workflow.')
      const request = readBoardStart(draftKey)
      if (!request) return
      const instanceId = useGraphDraftStore.getState().nextDrafts[draftKey]?.instanceId
      const { result, acknowledgement } = await recoverBoardStart(draftKey, request)
      void queryClient.invalidateQueries({ queryKey: boardRunListKey(graph.workspaceId, graph.id) })
      if (!alive.current || acknowledgement === 'superseded'
        || useGraphDraftStore.getState().nextDrafts[draftKey]?.instanceId !== instanceId) return
      if (result.status === 'accepted') {
        if (latestBoard.current?.getSelectionToken?.() === selectionToken) {
          const board = latestBoard.current
          if (board?.showRunOnBoard) board.showRunOnBoard(result.run.id)
          else board?.selectRun(scopeForBoardRun(result.run))
        }
        setMessage('The earlier Run was accepted.')
      } else {
        useGraphDraftStore.getState().updateNextDraft(draftKey, current => ({ ...current, startCanceled: true }))
        setMessage('The earlier Start was canceled. Reload the saved draft, then review and start again.')
      }
    } finally { startLock.current = false }
  } })
  const starting = startMutation.isPending || recovery.isPending
  const { mutateAsync } = startMutation
  useEffect(() => {
    const continuation = saveContinuation.current
    const intent = editIntent.query.data?.intent
    if (!continuation || starting || !intent) return
    if (!runAfterSave.current || intent.id !== continuation.intentId || intent.state === 'discarded') {
      saveContinuation.current = undefined
      runAfterSave.current = false
      return
    }
    if (intent.state !== 'saved' || !intent.result) return
    saveContinuation.current = undefined
    runAfterSave.current = false
    try {
      assertSession(continuation.generation)
      const current = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (!alive.current || current?.instanceId !== continuation.instanceId
        || latestBoard.current?.getSelectionToken?.() !== continuation.selectionToken) return
      void mutateAsync({ savedVersionId: intent.result.currentVersionId }).catch(report)
    } catch (error) { report(error) }
  }, [editIntent.query.data, mutateAsync, starting, draftKey, alive, latestBoard, runAfterSave, report])
  const start = () => startMutation.mutateAsync()
  const recoverStart = () => recovery.mutateAsync()
  return { startMutation, starting, start, recoverStart }
}
