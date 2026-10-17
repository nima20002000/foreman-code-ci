import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

it('persists replacement generations independently and retains both closed receipts after archive and restart', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'worker-chat-replacement-'))
  const path = join(directory, 'operations.json')
  let now = Date.now()
  let journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true,
    now: () => now, retentionNow: () => now })
  const f = workerConversationFixture('agent')
  const replacement = { ...f.binding, generation: randomUUID(), owner: { ...f.binding.owner,
    configurationVersionId: randomUUID() } }
  try {
    await journal.conversations.receive(f.binding, f.connection)
    await journal.conversations.reserveCreation(f.binding, 'first', `sha256:${'a'.repeat(64)}`)
    await journal.conversations.bindSession(f.binding, f.session, f.nativeOwner)
    await expect(journal.conversations.receive(replacement, f.connection)).rejects.toThrow()
    await journal.conversations.closeRequested(f.binding)
    const original = await journal.conversations.closeConfirmed(f.binding)
    await journal.conversations.receive(replacement, f.connection)
    await journal.conversations.reserveCreation(replacement, 'replacement', `sha256:${'b'.repeat(64)}`)
    const session = { ...f.session, nativeSessionId: 'replacement-session' }
    await journal.conversations.bindSession(replacement, session, { ...f.nativeOwner, sessionId: session.nativeSessionId })
    await journal.conversations.closeRequested(replacement)
    const replaced = await journal.conversations.closeConfirmed(replacement)
    await expect(journal.conversations.read(f.binding)).resolves.toEqual(original)
    await expect(journal.conversations.read(replacement)).resolves.toEqual(replaced)
    now += 31 * 24 * 60 * 60_000
    await journal.pruneFinishedRuntime()
    await journal.close()
    journal = await RemoteOperationJournal.open(path, { now: () => now, retentionNow: () => now })
    await expect(journal.conversations.read(f.binding)).resolves.toEqual(original)
    await expect(journal.conversations.read(replacement)).resolves.toEqual(replaced)
    await expect(journal.conversations.reserveCreation(replacement, 'duplicate', `sha256:${'c'.repeat(64)}`))
      .rejects.toThrow()
    await expect(journal.conversations.receive({ ...replacement, generation: randomUUID(),
      owner: { ...replacement.owner, conversationId: f.binding.owner.conversationId, agentId: 'another-agent' } }, f.connection))
      .rejects.toThrow()
  } finally {
    await journal.close()
    await rm(directory, { recursive: true, force: true })
  }
})
