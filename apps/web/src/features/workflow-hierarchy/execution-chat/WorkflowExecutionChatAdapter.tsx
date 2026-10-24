import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { WorkflowExecutionChatSelectionSchema, WorkflowExecutionChatTargetSchema,
  type WorkflowExecutionChatResolution, type WorkflowExecutionChatSelection,
  type WorkflowExecutionChatTarget } from '@foreman-code/contracts'
import { ApiError } from '../../../shared/api/client'
import { useBlockingReadError } from '../../../shared/api/readFailure'
import { sessionGeneration } from '../../../shared/api/sessionBoundary'
import { executionChatReadKey, executionChatScopeKey, executionChatSelectionKey, resolveExecutionChat,
  workflowExecutionChatClient, type WorkflowExecutionChatClient } from './client'
import type { WorkflowExecutionChatSlotSelection, WorkflowExecutionChatViews } from './types'
import { useBoardAuthoring } from '../../board-core'
import { runReadErrorLabel, useRunSummaries } from '../../runs-selector'

type Resolved=Extract<WorkflowExecutionChatResolution,{kind:'selected'}>
function isPinned(selection:WorkflowExecutionChatSelection,resolved:Resolved) {
  const target=resolved.target
  return selection.workflowVersionId===resolved.workflowVersionId&&(target.kind==='workflow_execution'
    ? selection.runId===target.execution.runId&&selection.executionId===target.execution.executionId&&!selection.waitingActivationId
    : selection.runId===target.runId&&selection.waitingActivationId===target.waitingActivationId&&!selection.executionId)
}
function boundClient(cache:QueryClient,resolved:Resolved):WorkflowExecutionChatClient {
  const target=resolved.target, scope=target.agent
  const check=(actual:unknown)=>{
    if(canonicalJson(WorkflowExecutionChatTargetSchema.parse(actual))!==canonicalJson(target)) {
      throw new ApiError({code:'TARGET_CHANGED',message:'Select the other execution explicitly before sending to it.'})
    }
  }
  const refresh=()=>Promise.all([
    cache.invalidateQueries({queryKey:executionChatScopeKey(scope),refetchType:'active'}),
    cache.invalidateQueries({queryKey:['workflow-hierarchy',sessionGeneration(),scope.workspaceId,scope.workflowId],refetchType:'active'}),
  ])
  return {
    read:async(input,options)=>{
      check(input.target)
      const result=await workflowExecutionChatClient.read(input,options)
      if(result.messages.some(message=>message.provenance.kind==='consultation'
        &&message.provenance.binding.workflowVersionId!==resolved.workflowVersionId)) {
        throw new ApiError({code:'INVALID_RESPONSE',message:'The native history belongs to another saved workflow version.'})
      }
      return result
    },
    deliver:async(input,options)=>{check(input.target);try{return await workflowExecutionChatClient.deliver(input,options)}finally{await refresh()}},
    stop:async(input,options)=>{check(input.target);try{return await workflowExecutionChatClient.stop(input,options)}finally{await refresh()}},
    cancel:async(input,options)=>{check(input.target);try{return await workflowExecutionChatClient.cancel(input,options)}finally{await refresh()}},
  }
}

/** This adapter mounts only as the selected Agent Chat body. Hidden rails never
 * resolve targets, fetch history or create a native/conversation owner. */
export function WorkflowExecutionChatAdapter({selection:raw,views}:{
  selection:WorkflowExecutionChatSlotSelection;views:WorkflowExecutionChatViews
}) {
  const cache=useQueryClient()
  const board=useBoardAuthoring()
  const {nodeId,onSelectTarget,onSelectRun,...pins}=raw
  // A draft node's Agent lets the server open its draft chat before the workflow is saved.
  const agentId=pins.runId?undefined:board?.draftNodeAgentId?.(nodeId)
  const selection=WorkflowExecutionChatSelectionSchema.parse({...pins,workflowNodeId:nodeId,...(agentId?{agentId}:{})})
  const currentScope=canonicalJson(selection)
  const [separateScope,setSeparateScope]=useState<string>()
  const [destinationScope,setDestinationScope]=useState<string>()
  const separate=!selection.runId&&!!agentId&&separateScope===currentScope
  const query=useInfiniteQuery({queryKey:executionChatSelectionKey(selection),
    initialPageParam:undefined as string|undefined,
    queryFn:({signal,pageParam})=>resolveExecutionChat({...selection,...(pageParam?{cursor:pageParam}:{})},{signal}),
    getNextPageParam:(page,_pages,_param,params)=>'nextCursor' in page&&page.nextCursor&&!params.includes(page.nextCursor)
      ?page.nextCursor:undefined,
    retry:false,staleTime:Infinity,refetchOnMount:'always',refetchOnWindowFocus:false,refetchOnReconnect:false,maxPages:10,
  })
  const blocked=useBlockingReadError(query)
  const first=blocked?undefined:query.data?.pages[0], resolved=first?.kind==='selected'?first:undefined
  const pinned=!!resolved&&isPinned(selection,resolved)
  useEffect(()=>{
    if(selection.runId&&resolved&&!pinned) onSelectTarget(resolved.target,resolved.workflowVersionId)
  },[selection.runId,resolved,pinned,onSelectTarget])
  const client=useMemo(()=>resolved?boundClient(cache,resolved):undefined,[cache,resolved])
  // A draft-only Agent (never saved) has no configuration to chat with yet: save only that Agent, never the
  // workflow graph, so chat opens even while an unrelated part of the workflow can't be saved.
  const saveChatAgent=board?.saveChatAgent
  const draftOnly=!selection.runId&&first?.kind==='unavailable'&&first.reason!=='NO_EXECUTION'
  const [saving,setSaving]=useState<'saving'|'done'|{error:string}>()
  const attempted=useRef(false)
  const saveAgent=useCallback(()=>{
    if(!saveChatAgent) return
    setSaving('saving')
    void saveChatAgent(nodeId).then(()=>{ setSaving('done'); void query.refetch() },
      (error:unknown)=>setSaving({error:error instanceof Error?error.message:'The Agent could not be saved.'}))
  },[saveChatAgent,nodeId,query])
  useEffect(()=>{
    if(!draftOnly||!saveChatAgent||attempted.current) return
    attempted.current=true
    saveAgent()
  },[draftOnly,saveChatAgent,saveAgent])
  // Settings changed on the Board (e.g. browser turned on) reach an open draft chat without saving the workflow:
  // opening the chat saves only this Agent's pending edits, and its next turn uses them.
  const outsideRun=!selection.runId&&(first?.kind==='outside_run'||separate)
  const synced=useRef(false)
  useEffect(()=>{
    if(!outsideRun||!saveChatAgent||synced.current) return
    synced.current=true
    void saveChatAgent(nodeId).catch((error:unknown)=>console.error('Saving the Agent settings for chat failed',error))
  },[outsideRun,saveChatAgent,nodeId])
  const failure=query.error??blocked
  const error=failure instanceof Error?failure.message:'Chat could not refresh. Your selection has been kept.'
  const retry=<button type="button" onClick={()=>void query.refetch()} disabled={query.isFetching && !query.isRefetching}>Retry</button>
  const chooseExecution=selection.runId&&selection.workflowVersionId&&(selection.executionId||selection.waitingActivationId)?<button type="button"
    onClick={()=>onSelectRun({runId:selection.runId!,workflowVersionId:selection.workflowVersionId!})}>Choose another execution</button>:null
  const chooseDestination=<button type="button" onClick={()=>setDestinationScope(currentScope)}>Choose chat destination</button>
  if(destinationScope===currentScope) return <ChatDestinationPicker selection={selection}
    onSelectRun={run=>{setDestinationScope(undefined);onSelectRun(run)}} onCancel={()=>setDestinationScope(undefined)}/>
  if(!first) return failure?<div role="alert">{error} {retry} {chooseExecution} {chooseDestination}</div>:<p role="status">Loading selected Agent chat…</p>
  const status=query.isError?<div role="alert">{error} {retry}</div>:null
  const separateAction=!selection.runId&&agentId?<button type="button"
    onClick={()=>setSeparateScope(currentScope)}>Separate chat</button>:null
  if(separate&&agentId) {
    const View=views.OutsideRunChat
    return <>{status}<p className="workflow-panel-hint">Separate chat · Current Agent <button type="button"
      onClick={()=>setSeparateScope(undefined)}>Choose chat destination</button></p><View selection={selection}
      resolved={{kind:'outside_run',reason:'SEPARATE_CHAT',agent:{workspaceId:selection.workspaceId,workflowId:selection.workflowId,
        workflowNodeId:nodeId,agentId}}} onSelectTarget={onSelectTarget} onSelectRun={onSelectRun}/></>
  }
  if(resolved&&!selection.runId) return <section aria-label="Select Agent chat target">
    {status}<p>Choose where to chat with this Agent.</p><button type="button"
      onClick={()=>onSelectTarget(resolved.target,resolved.workflowVersionId)}>Open Run {resolved.target.kind==='workflow_execution'
        ?resolved.target.execution.runId:resolved.target.runId}</button> {separateAction}
  </section>
  if(resolved) {
    if(!pinned||!client) return <p role="status">Opening the selected Run target…</p>
    const View=views.ExecutionChat
    return <>{status}<p className="workflow-panel-hint" data-testid="agent-chat-scope">{resolved.target.kind==='workflow_execution'
      ?`Run · attempt ${resolved.target.execution.attempt}`:'Run · coordinator'} {chooseExecution}</p><View key={canonicalJson(resolved.target)} selection={selection} resolved={resolved}
      client={client} queryKey={executionChatReadKey(resolved.target)} onSelectTarget={onSelectTarget} onSelectRun={onSelectRun}/></>
  }
  if(first.kind==='outside_run') {
    const View=views.OutsideRunChat
    return <>{status}<View selection={selection} resolved={first} onSelectTarget={onSelectTarget} onSelectRun={onSelectRun}/></>
  }
  if(draftOnly&&saveChatAgent&&(saving==='saving'||saving===undefined)) return <p role="status">Draft chat · saving this Agent so you can chat with it…</p>
  if(draftOnly&&saveChatAgent&&typeof saving==='object') return <>{status}<p role="alert">This Agent couldn’t be saved for chat: {saving.error}</p>
    <button type="button" onClick={saveAgent}>Try again</button>{chooseDestination}</>
  if(first.kind==='unavailable') return <>{status}<p role="status">{first.reason==='NO_EXECUTION'
    ?'This saved node has no available execution. Choose a Run to read its history.'
    :first.reason==='NODE_UNAVAILABLE'?'This Agent is not present in the selected saved workflow.':'The selected saved workflow is unavailable.'}</p>{chooseExecution} {chooseDestination} {separateAction}</>
  return <section aria-label="Select Agent chat target">
    {status}<p>{first.kind==='run_selection_required'?'Choose a Run for this Agent.':'Choose the exact execution to open.'}</p>
    {separateAction}
    <ul>{query.data?.pages.flatMap(page=>page.kind==='run_selection_required'?page.items.map(item=>
      <li key={item.runId}><button type="button" onClick={()=>onSelectRun(item)}>Run {item.runId}</button></li>)
      :page.kind==='selection_required'?page.items.map(item=>
        <li key={canonicalJson(item.target)}><button type="button" onClick={()=>onSelectTarget(item.target,item.workflowVersionId)}>
          {choiceLabel(item.target)}
        </button></li>):[])}</ul>
    {query.hasNextPage?<button type="button" disabled={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage()}>
      {query.isFetchingNextPage?'Loading…':'Load more targets'}</button>:null}
  </section>
}
function choiceLabel(target:WorkflowExecutionChatTarget) {
  return target.kind==='workflow_execution'?`Execution ${target.execution.executionId} · Attempt ${target.execution.attempt}`
    :`Coordinator waiting at ${target.waitingActivationId}`
}

function ChatDestinationPicker({selection,onSelectRun,onCancel}:{selection:WorkflowExecutionChatSelection;
  onSelectRun:WorkflowExecutionChatSlotSelection['onSelectRun'];onCancel():void}) {
  const runs=useRunSummaries(selection)
  return <section aria-label="Select Agent chat destination">
    <p>Choose Current Agent or a Run to read its history.</p>
    <button type="button" onClick={()=>onSelectRun(undefined)}>Current Agent</button>
    <ul>{runs.items.map(run=><li key={run.runId}>
      <button type="button" onClick={()=>onSelectRun({runId:run.runId})}>Run {run.runId}</button> · {run.status}
    </li>)}</ul>
    {runs.isPending?<p role="status">Loading Runs…</p>:null}
    {runs.isSuccess&&!runs.items.length?<p role="status">No Runs available.</p>:null}
    {runs.isError?<p role="alert">{runReadErrorLabel(runs.error,'list')} <button type="button" disabled={runs.isFetching}
      onClick={()=>void runs.refetch()}>Retry Runs</button></p>:null}
    {runs.hasNextPage?<button type="button" disabled={runs.isFetchingNextPage} onClick={()=>void runs.fetchNextPage()}>
      {runs.isFetchingNextPage?'Loading…':'Load more Runs'}</button>:null}
    <button type="button" onClick={onCancel}>Back to selected chat</button>
  </section>
}
