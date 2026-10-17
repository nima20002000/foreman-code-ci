import { expect, it } from 'vitest'
import { identityAlive } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { historicalChatPlacement } from './helpers/historicalChatPlacement.js'
import { workerSettingsChat } from './helpers/agentChatWorkerSettings.js'

it('starts a replacement Worker session with conversation history when the profile changes', async () => {
  await historicalChatPlacement(async fixture => {
    const chat = await workerSettingsChat(fixture)
    const session = chat.completed.conversation!.nativeSession
    const original = fixture.registry.snapshot().launches.find(launch => launch.owner === `conversation:${chat.id}`
      && launch.lifecycle === 'active' && launch.provider)!
    expect(original).toBeDefined()
    const saved = await chat.save({ model: 'other-model' }, { replaceProfile: true })
    const sent = await chat.send('Continue in the replacement profile.')
    expect(sent.state.conversation).toMatchObject({ id: chat.id,
      agentConfigurationVersionId: saved.result.value.agent.configurationVersionId })
    expect(sent.state.conversation!.nativeSession!.nativeSessionId).not.toBe(session!.nativeSessionId)
    expect(sent.state.messages.filter(message => message.role === 'user').map(message => message.content))
      .toEqual([chat.message.content, sent.message.content])
    expect(fixture.registry.closedRegistration(original.owner, original.launchId))
      .toMatchObject({ lifecycle: 'closed', closureEvidence: expect.any(String) })
    expect(identityAlive(original.provider!)).toBe(false)
    await fixture.restartMain({ mode: 'graceful' })
    const followUp = await chat.send('Continue after Main restarts.')
    expect(followUp.state.conversation!.nativeSession).toEqual(sent.state.conversation!.nativeSession)
    expect(await fixture.details(chat.started.run.id)).toEqual(chat.before)
  }, { includeNodeRuntimePayload: false })
}, 240_000)
