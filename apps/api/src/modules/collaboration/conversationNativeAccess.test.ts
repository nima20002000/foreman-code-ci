import pg from 'pg'
import { expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { ConversationCredentials } from '../access/conversationCredentialIssuer.js'
import type { ConversationFeatureContext } from '../conversations/conversationFeatureSubject.js'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import { ConversationNativeAccess } from './conversationNativeAccess.js'

it.each([false, true])('keeps a no-Group-access session after an unrelated save, with rebind support: %s', async supported => {
  const fixture = makeCurrentWorkflowFixture('conversation-access', 'single')
  const configuration = AgentConfigurationVersionSchema.parse({ ...fixture.configurations[0], graphqlTools: [] })
  const node = fixture.version.definition.nodes[0]!
  if (node.kind === 'job') throw new Error('Expected an Agent')
  const context: ConversationFeatureContext = {
    subject: { kind: 'conversation', conversationId: 'conversation', agent: {
      workspaceId: configuration.workspaceId, workflowId: fixture.version.workflowId,
      workflowNodeId: node.id, agentId: configuration.agentId, configurationVersionId: configuration.id,
      productRole: 'coder', displayName: 'Agent',
    } },
    configuration, node: { ...node, graphqlTools: [] }, workflowVersionId: fixture.version.id,
    workingDirectory: '/workspace/project',
  }
  const pool = new pg.Pool()
  const credentials = new ConversationCredentials(pool)
  const issue = vi.spyOn(credentials, 'issue')
  const rebind = vi.fn(async () => {})
  const manager = (supported ? { rebindApplicationAccess: rebind } : {}) as NativeHarnessSessionManager
  const access = new ConversationNativeAccess(credentials)
  try {
    expect(await access.bind(manager, context)).toBe(manager)
    await expect(access.rebind({ manager, context: { ...context, workflowVersionId: 'another-saved-version' },
      session: { harness: 'codex', nativeSessionId: 'resident-session', providerVersion: 'fixture' },
      correlationId: 'next-message', signal: new AbortController().signal })).resolves.toBeUndefined()
    expect(issue).not.toHaveBeenCalled()
    expect(rebind).not.toHaveBeenCalled()
  } finally { issue.mockRestore(); await pool.end() }
})
