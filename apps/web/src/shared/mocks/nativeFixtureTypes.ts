import type { WorkflowDefinitionCurrent } from '@foreman-code/contracts/current'
import type { GraphNode } from '../../features/board-core'
/** Agent-only fixture assertion; a Job must never acquire fabricated Agent fields. */
export function nativeNode<T>(node:T):Exclude<T,{kind:'job'}|{data:{kind:'job'}}> {
  if(node && typeof node==='object' && (('kind' in node && node.kind==='job') || ('data' in node && node.data && typeof node.data==='object' && 'kind' in node.data && node.data.kind==='job')))throw new Error('Agent-only fixture unexpectedly contains a Job')
  return node as Exclude<T,{kind:'job'}|{data:{kind:'job'}}>
}
export function nativeDefinition<T extends WorkflowDefinitionCurrent>(definition:T) {
  return {...definition,nodes:definition.nodes.map(nativeNode)}
}
export function nativeGraphNode(node:GraphNode) {
  if(node.type!=='agent')throw new Error('Agent-only graph fixture unexpectedly contains a Job')
  return node
}
