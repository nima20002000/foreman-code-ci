import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import type { NativeLaunchObservation } from '../harnesses/recovery/processRegistry.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { closeRecoveredWorkerSession, workerConversationProcessDigest } from './workerNativeOwner.js'

const closing: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close() })

async function previewRecord() {
  const directory = await privateFixtureDirectory('worker-journal-compatibility-')
  closing.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'operations.json')
  const f = workerConversationFixture('agent')
  const owner = f.binding.owner
  if (owner.kind !== 'agent') throw new Error('An Agent replacement fixture is required')
  const binding = { ...f.binding, owner, sessionGeneration: 'preview-configuration' }
  const launch: NativeLaunchObservation = { owner: `conversation:${binding.owner.conversationId}`,
    launchId: randomUUID(), bootId: f.connection.bootId, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty',
    guardian: { pid: 11111, startTicks: '10' }, provider: { pid: 11112, startTicks: '11' } }
  const nativeOwner = { sessionId: f.session.nativeSessionId,
    processIdentityDigest: workerConversationProcessDigest(binding, launch) }
  const inputHash = commandInputHash('Run once')
  const receipt: WorkerConversationReceipt = { binding, connection: f.connection, session: f.session, nativeOwner,
    revision: 4, closing: false, closed: false, turns: [{ correlationId: 'original-input', inputHash,
      status: 'completed', nativeTurnId: 'native-turn', result: { outcome: 'succeeded' } }],
    compactions: [], desiredPreferences: null, appliedPreferences: null }
  return { path, binding, launch, receipt, inputHash }
}

async function open(path: string, conversations: WorkerConversationReceipt[] = []) {
  await writeFile(path, JSON.stringify({ schemaVersion: 1, conversations, receipts: [], reconciliations: [] }))
  const journal = await RemoteOperationJournal.open(path)
  closing.push(() => journal.close())
  return journal
}

it('reopens preview replacement receipts without changing native ownership or allowing input replay', async () => {
  const f = await previewRecord()
  const journal = await open(f.path, [f.receipt])
  const restored = await journal.conversations.read(f.binding)
  expect(restored).toEqual(f.receipt)
  expect(await journal.conversations.reserveTurn(f.binding, 'original-input', f.inputHash))
    .toMatchObject({ dispatch: false, record: { nativeOwner: f.receipt.nativeOwner } })
  await expect(journal.conversations.receive({ ...f.binding, sessionGeneration: 'next-configuration' },
    f.receipt.connection)).rejects.toThrow('previous native session')
  const closeOwner = vi.fn(async () => true)
  await closeRecoveredWorkerSession(restored!, { snapshot: () => ({ revision: 'recorded', launches: [f.launch] }),
    closeOwner }, AbortSignal.timeout(1_000))
  expect(closeOwner).toHaveBeenCalledExactlyOnceWith(f.launch.owner, expect.any(AbortSignal))
  await journal.close()
  const reopened = await RemoteOperationJournal.open(f.path)
  closing.push(() => reopened.close())
  expect(await reopened.conversations.read(f.binding)).toMatchObject({ binding: f.binding, nativeOwner: f.receipt.nativeOwner })
})

it('reads preview generation-keyed archives and keeps their replay and Agent ownership fences', async () => {
  const f = await previewRecord()
  const receipt = { ...f.receipt, closed: true, closing: true, closedAt: '2026-10-01T00:00:00.000Z' }
  const directory = `${f.path}.conversations`
  await mkdir(directory)
  const key = commandInputHash([f.binding.owner.conversationId, f.binding.sessionGeneration])
  const archive = join(directory, `${commandInputHash(key)}.json`)
  await writeFile(archive, JSON.stringify({ receipt, digest: commandInputHash(receipt) }))
  const journal = await open(f.path)
  expect(await journal.conversations.read(f.binding)).toEqual(receipt)
  await expect(journal.conversations.reserveTurn(f.binding, 'original-input', f.inputHash))
    .rejects.toThrow('closing or closed')
  await expect(journal.conversations.receive({ ...f.binding, sessionGeneration: 'foreign-configuration',
    owner: { ...f.binding.owner, agentId: 'foreign-agent' } }, receipt.connection)).rejects.toThrow('previous native session')
  const next = { ...f.binding, sessionGeneration: 'next-configuration' }
  expect(await journal.conversations.receive(next, receipt.connection)).toMatchObject({ binding: next, closed: false })
  await journal.close()
  await writeFile(archive, JSON.stringify({ receipt: { ...receipt, nativeOwner: {
    ...receipt.nativeOwner, processIdentityDigest: 'c'.repeat(64) } }, digest: commandInputHash(receipt) }))
  const reopened = await RemoteOperationJournal.open(f.path)
  closing.push(() => reopened.close())
  await expect(reopened.conversations.read(f.binding)).rejects.toThrow('archive changed')
})
