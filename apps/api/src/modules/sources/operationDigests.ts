/** Worker-safe counterpart of the existing Main command canonical digest. */
import { canonicalJsonLocaleOrderLegacy } from '@foreman-code/contracts/canonical-json'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { MaterializationAttempt } from './ports.js'
import { sha256Hex } from '../../shared/hash.js'
export function sourceOperationSelectionHash(root: SourceRootRecord, attempt: MaterializationAttempt, operationId: string): string {
  return sha256Hex(canonicalJsonLocaleOrderLegacy({ version: 1, source: root.source, root: { selection: root.selection,
    binding: root.binding, registration: root.registration, attestationId: root.attestationId, attestationDigest: root.attestationDigest },
  executionId: attempt.executionId, attemptId: attempt.attemptId, operationId, keyRevision: attempt.keyRevision, authorizationRevision: attempt.authorizationRevision }))
}
