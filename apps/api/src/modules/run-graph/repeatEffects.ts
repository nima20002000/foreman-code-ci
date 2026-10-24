import {
  GraphDigestSchema, GraphIdSchema, RepeatGraphEffectCurrentSchema, RepeatGraphScopeCurrentSchema,
  type RepeatGraphScopeCurrent, type RepeatGraphEffectCurrent,
} from '@foreman-code/contracts/current'
import type { RepeatEffect } from '../runs/repeatPostgres.js'
import { repeatId } from '../runs/repeatResolution.js'
import type { RepeatCanonicalReceipt } from './repeatReceipts.js'

/** Storage categories are the EXISTING effect_kind CHECK values, not new SQL
 * kinds. operation + subjectId are explicit public v3 meaning. Qualified keys
 * prevent occurrence input, execution input and completion from aliasing. */
export function canonicalRepeatEffect(scope: RepeatGraphScopeCurrent, value: RepeatEffect): RepeatGraphEffectCurrent {
  RepeatGraphScopeCurrentSchema.parse(scope)
  GraphIdSchema.parse(value.entityId)
  GraphDigestSchema.parse(value.digest)
  const kinds = { 'occurrence.create': 'input.bind', 'input.bind': 'input.bind', 'terminal.accept': 'result.accept',
    'node.inactive': 'route.resolve', 'run.complete': 'route.resolve' } as const
  return RepeatGraphEffectCurrentSchema.parse({ operation: value.kind, subjectId: value.entityId, digest: value.digest,
    identity: { kind: kinds[value.kind], entityId: repeatId('repeat-effect', scope.runId, scope.workflowVersionId, value.kind, value.entityId) } })
}
export function canonicalRepeatEffectReceipt(scope: RepeatGraphScopeCurrent, value: RepeatEffect,
  semanticDigest?: string): RepeatCanonicalReceipt {
  const effect = canonicalRepeatEffect(scope, value)
  const kinds = { 'occurrence.create': 'input_binding', 'input.bind': 'input_binding', 'terminal.accept': 'node_resolution',
    'node.inactive': 'node_resolution', 'run.complete': 'run' } as const
  return { scope, evidence: { sourceKind: kinds[value.kind],
    sourceId: repeatId('repeat-source', scope.runId, scope.workflowVersionId, value.kind, value.entityId), sourceRevision: '1' },
  sourceDigest: value.digest, effect: { kind: effect.identity.kind, entityId: effect.identity.entityId, digest: effect.digest },
  ...(semanticDigest === undefined ? {} : { semanticDigest }) }
}
