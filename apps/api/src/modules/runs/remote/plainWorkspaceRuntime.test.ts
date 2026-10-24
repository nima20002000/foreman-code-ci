import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/current'
import { PlainNativeExecutionPlacementSchema } from '@foreman-code/contracts/node-placement'
import { WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import { deriveDispatch, freezePlacement } from '../../placement/binding.js'
import { nativePlacementDigest } from '../../placement/executionBinding.js'
import { SourceOperationWorkerService } from '../../sources/operationWorker.js'
import { attestWorkspaceRoot, qualifyApprovedRootAllowlist } from '../../sources/rootAttestation.js'
import { directory, runningInstalledFixture } from './__tests__/installedWorkflowHost.js'
import { attestInstalledWorkflowRuntimeLeaf } from './installedWorkflowHost.js'
import { assertOriginalPhysicalDirectories } from './workflowPhysicalReadout.js'
import { assertRuntimeLeafBinding } from './runtimeLeaf.js'

it('uses the actual plain project as CWD without a source operation and detects folder replacement', async () => {
  const root = await directory()
  const project = join(root, 'project'), runtime = join(root, 'runtime')
  await mkdir(project, { mode: 0o700 })
  await mkdir(runtime, { mode: 0o700 })
  const binding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const hostRef = { kind: 'device' as const, mainId: binding.mainId, deviceId: binding.deviceId }
  const approvedRoots = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef,
    applicationInstallationId: binding.workerInstallationId, configurationRevision: '1', managedRuntimeRoot: runtime,
    bases: [{ baseId: randomUUID(), canonicalPath: project, accessModes: ['read-write'] }] })
  const configuration = makeCurrentWorkflowFixture(randomUUID(), 'single').configurations[0]!
  const selection = { workspaceId: configuration.workspaceId, hostRef, allowedBaseId: approvedRoots.bases[0]!.baseId,
    configurationRevision: '1', relativePath: '', accessMode: 'read-write' as const,
    expectedLocationRevision: 1, expectedRootPolicyRevision: 0 }
  const proof = await attestWorkspaceRoot(approvedRoots, selection)
  const registration = { workerInstallationId: binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
  const { requestDigest: _requestDigest, ...attestation } = proof
  const policy = WorkspaceRootPolicySchema.parse({ ...attestation, rootPolicyId: randomUUID(), rootPolicyRevision: '1',
    locationRevision: '1', workspaceId: configuration.workspaceId, ownerPrincipalId: 'owner', registration })
  const placement = freezePlacement({ schemaVersion: 1, mainId: binding.mainId, mainInstallationId: binding.mainId,
    runId: 'run', nodeId: 'node', hostRef, registration,
    destination: { canonicalProjectRoot: project, canonicalCwd: project, managedRuntimeRoot: runtime,
      directoryIdentityHash: policy.directoryIdentityHash, rootPolicyId: policy.rootPolicyId, rootPolicyRevision: '1',
      locationRevision: '1', attestationId: policy.attestationId, attestationHash: policy.attestationDigest },
    source: { kind: 'plain', filesystem: policy.filesystem, accessMode: 'read-write' },
    payload: { kind: 'agent', agentId: configuration.agentId, agentConfigurationVersionId: configuration.id,
      driverId: 'codex', driverRevision: '1', instanceId: 'profile', instanceRevision: '1', harnessInstallationId: 'codex',
      installationFingerprint: 'fingerprint', runtimeContractVersion: 1, protocolRevision: 'codex-native-adapter-v1', credentialScopeRefs: [] } })
  const intent = deriveDispatch(placement, { executionId: 'execution', attemptId: 'attempt', operationId: 'operation',
    occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, inputDigest: `sha256:${'a'.repeat(64)}`,
    owner: { grantId: 'owner', epoch: '1' } })
  const fields = { version: 1 as const, kind: 'plain' as const, acceptedBindingHash: placement.bindingHash,
    runId: intent.runId, nodeId: intent.nodeId, executionId: intent.executionId, attemptId: intent.attemptId,
    operationId: intent.operationId, policy, workingTree: { canonicalProjectRoot: project, canonicalCwd: project,
      directoryIdentityHash: policy.directoryIdentityHash, filesystem: policy.filesystem,
      accessMode: 'exclusive-write' as const, privateGit: null } }
  const nativePlacement = PlainNativeExecutionPlacementSchema.parse({ ...fields, bindingHash: nativePlacementDigest(fields) })
  const sources = new SourceOperationWorkerService({ mainNow: () => Date.now(), authenticate: async () => undefined,
    approvedRoots: async () => approvedRoots, currentOwner: async () => { throw new Error('Plain folders have no source owner') } })
  const sourceOperation = vi.spyOn(sources, 'handle')
  const request = { executionId: intent.executionId, runId: intent.runId, workspaceId: configuration.workspaceId,
    workflowNodeId: intent.nodeId, configuration, workingDirectory: project, runtimeDirectory: join(runtime, 'workflow-runs', 'execution', 'attempt'), input: {} }
  const input = { sources, approvedRoots, nativePlacement, placement, intent, request,
    context: { binding, signal: new AbortController().signal } }
  const leaf = await attestInstalledWorkflowRuntimeLeaf(input)
  expect(leaf).toMatchObject({ materializationId: null, materializationDigest: null, bindingHash: nativePlacement.bindingHash })
  assertRuntimeLeafBinding(leaf, request.runtimeDirectory, intent, placement, nativePlacement)
  expect(await attestInstalledWorkflowRuntimeLeaf(input)).toEqual(leaf)
  await assertOriginalPhysicalDirectories({ source: { kind: 'plain', policy, workingTree: fields.workingTree },
    runtimeLeaf: leaf, placement, approvedRoots, signal: input.context.signal,
    assertCurrent: () => undefined, authorize: async () => undefined })
  expect(sourceOperation).not.toHaveBeenCalled()
  expect(await readdir(project)).toEqual([])
  await rename(project, join(root, 'old-project'))
  await mkdir(project, { mode: 0o700 })
  await expect(attestInstalledWorkflowRuntimeLeaf(input)).rejects.toMatchObject({ code: 'ROOT_BASE_CHANGED' })
})

it('launches and reads the original Worker session in the plain folder', async () => {
  const f = await runningInstalledFixture('generation', { plain: true })
  try {
    expect(f.request.workingDirectory).toBe(f.placement.destination.canonicalProjectRoot)
    expect(f.executionPlacement).toHaveProperty('kind', 'plain')
    f.finish('succeeded')
    await f.settled
    const history = await f.call('history')
    const receipt = (history.payload as { status: { receipt: { sequence: number } } }).status.receipt
    const { remoteWorkflowSourceDigest } = await import('./workflowPhysicalReadout.js')
    const physical = await f.call('physical-readout', { receiptSequence: receipt.sequence,
      sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history: f.history }) })
    expect(physical.payload).toMatchObject({ source: { kind: 'plain',
      workingTree: { canonicalCwd: f.placement.destination.canonicalProjectRoot } },
      runtimeLeaf: { materializationId: null, materializationDigest: null },
      receipt: { terminal: { kind: 'completed' } } })
    expect(f.create).toHaveBeenCalledOnce()
  } finally { f.finish('canceled'); await f.host.close() }
})
