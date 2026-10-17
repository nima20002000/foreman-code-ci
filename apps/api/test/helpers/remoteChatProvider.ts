import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NativeHarnessSessionManager } from '../../src/modules/harnesses/port.js'
import type { CodexChatFiles } from '../../src/modules/harnesses/codexFiles/runtime.js'
import { CodexAppServerSessionManager } from '../../src/modules/harnesses/codexAppServer.js'
import type { ClaudeSdkClient } from '../../src/modules/harnesses/claudeSdk/port.js'
import { ClaudeBoundedQueue } from '../../src/modules/harnesses/claudeSdk/queue.js'
import { createClaudeSdkRunner } from '../../src/modules/harnesses/claudeSdk/runner.js'
import { allocateClaudeNativeHarness } from '../../src/modules/harnesses/claudeSdk/composition.js'
import { ActivityProductionReplay } from './activityProductionReplay.js'
import { deferred, type Deferred } from './deferred.js'

/** Only provider I/O is recorded. Both native adapters and the remote conversation stack are real. */
export async function remoteChatProvider(harness: 'codex' | 'claude', directory: string, options: {
  codexFiles?: CodexChatFiles
  codexInput?(input: unknown): Promise<void>
  claudeMessage?(sessionId: string, messageId: string): Promise<void>
} = {}) {
  const modes: string[] = []
  const prompts: unknown[] = []
  const calls: string[] = []
  let compactions = 0
  let reply: Deferred<void> | undefined
  let holdCompactionNotifications = false
  const compactionNotifications: Array<() => void> = []
  let createManager: () => NativeHarnessSessionManager
  if (harness === 'codex') {
    const replay = new ActivityProductionReplay(`remote-chat-${randomUUID()}`)
    const infrastructure = replay.infrastructure()
    if (infrastructure.mode !== 'replay') throw new Error('Recorded provider infrastructure required')
    const dependencies = { ...infrastructure.codex,
      transport: (...args: Parameters<typeof infrastructure.codex.transport>) => {
        const transport = infrastructure.codex.transport(...args)
        return { ...transport, request: async (...requestArgs: Parameters<typeof transport.request>) => {
          const [method, params = {}] = requestArgs
          calls.push(method)
          if (method === 'thread/compact/start') {
            compactions++
            const thread = replay.threads.get(String(params.threadId))!
            const turn = { id: `compact-${compactions}`, status: 'completed', error: null,
              startedAt: 1, completedAt: 2, durationMs: 1,
              items: [{ id: `boundary-${compactions}`, type: 'contextCompaction' }] }
            thread.turns.push(turn)
            const channel = replay.channels.get(thread.id)!
            const notify = () => {
              channel.notify('turn/started', { threadId: thread.id, turn: { ...turn, status: 'inProgress' } })
              channel.notify('turn/completed', { threadId: thread.id, turn })
            }
            if (holdCompactionNotifications) compactionNotifications.push(notify)
            else setImmediate(notify)
            return {}
          }
          const result = await transport.request(...requestArgs)
          if (method === 'turn/start') {
            prompts.push(params.input)
            await options.codexInput?.(params.input)
            const mode = params.collaborationMode as { mode?: string } | undefined
            modes.push(mode?.mode ?? 'default')
            const turn = replay.starts.at(-1)!
            setImmediate(async () => {
              const itemId = `answer-${turn.nativeTurnId}`
              replay.append(turn.sessionId, turn.nativeTurnId, 'Remote streamed answer', itemId)
              await reply?.promise
              replay.complete(turn.sessionId, turn.nativeTurnId, 'Remote streamed answer', itemId)
            })
          }
          return result
        } }
      } }
    createManager = () => new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined,
      undefined, 'none', options.codexFiles, dependencies)
  } else {
    const nativeId = randomUUID()
    const messages: unknown[] = []
    const profilePath = join(directory, 'claude-profile')
    const transcriptDirectory = join(profilePath, 'projects', 'recorded')
    await mkdir(transcriptDirectory, { recursive: true })
    const transcriptPath = join(transcriptDirectory, `${nativeId}.jsonl`)
    await writeFile(transcriptPath, '')
    const sdk: ClaudeSdkClient = {
      sdkVersion: '0.3.284', getSessionInfo: async sessionId => ({ sessionId }),
      getSessionMessages: async (_sessionId, options) => {
        const offset = options.offset ?? 0
        return messages.slice(offset, offset + (options.limit ?? 256))
      },
      forkSession: async () => { throw new Error('This chat fixture does not fork') },
      query(input) {
        const frames = new ClaudeBoundedQueue<unknown>(32)
        const consume = (async () => {
          for await (const message of input.prompt) {
            prompts.push(message.message.content)
            messages.push({ ...structuredClone(message), session_id: nativeId })
            await frames.offer({ type: 'system', subtype: 'init', session_id: nativeId,
              claude_code_version: '2.1.284', cwd: directory, slash_commands: ['compact'] })
            if (message.message.content === '/compact') {
              compactions++
              await appendFile(transcriptPath, JSON.stringify({ type: 'system', subtype: 'compact_boundary',
                cwd: directory, sessionId: nativeId, uuid: randomUUID(),
                compactMetadata: { trigger: 'manual', preTokens: 100 }, timestamp: new Date().toISOString() }) + '\n')
              await frames.offer({ type: 'system', subtype: 'compact_boundary', session_id: nativeId,
                uuid: randomUUID(), compact_metadata: { trigger: 'manual', pre_tokens: 100 } })
            } else {
              const messageId = randomUUID()
              await frames.offer({ type: 'stream_event', session_id: nativeId, uuid: randomUUID(),
                user_message_uuid: message.uuid, parent_tool_use_id: null,
                event: { type: 'message_start', message: { id: messageId, role: 'assistant', content: [] } } })
              await frames.offer({ type: 'stream_event', session_id: nativeId, uuid: randomUUID(),
                user_message_uuid: message.uuid, parent_tool_use_id: null,
                event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
              await frames.offer({ type: 'stream_event', session_id: nativeId, uuid: randomUUID(),
                user_message_uuid: message.uuid, parent_tool_use_id: null,
                event: { type: 'content_block_delta', index: 0,
                  delta: { type: 'text_delta', text: 'Remote streamed answer' } } })
              await reply?.promise
              await frames.offer({ type: 'assistant', session_id: nativeId, uuid: randomUUID(),
                user_message_uuid: message.uuid, parent_tool_use_id: null,
                message: { id: messageId, role: 'assistant',
                  content: [{ type: 'text', text: 'Remote streamed answer' }] } })
              await options.claudeMessage?.(nativeId, message.uuid)
            }
            await frames.offer({ type: 'result', session_id: nativeId, uuid: randomUUID(),
              user_message_uuid: message.uuid, subtype: 'success', is_error: false,
              ...(message.message.content === '/compact' ? { local_command: 'compact' } : {}),
              result: 'Remote streamed answer' })
          }
        })()
        void consume.catch(error => frames.close(error))
        return {
          [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
          initializationResult: async () => ({ models: [], account: {} }),
          setPermissionMode: async mode => { modes.push(mode) },
          interrupt: async () => ({}), close: () => frames.close(),
          joinClosed: async () => { await consume },
        }
      },
    }
    createManager = () => allocateClaudeNativeHarness({ harness: 'claude', role: 'agent-chat', appMcpAccess: 'none',
      workingDirectory: directory, ownerAgentId: 'recorded-agent',
      ownerForStart: start => ({ ownerId: start.kind === 'agent-chat' ? start.conversationId : 'recorded-owner',
        attemptId: start.correlationId ?? 'recorded-request', generation: 'recorded-query' }),
      runner: createClaudeSdkRunner({ loadClient: async () => sdk }),
      scope: { deviceId: 'recorded-device', profilePath, configRevision: 'recorded', cwd: directory },
      sdkOptions: { includePartialMessages: true }, qualification: { sdkVersion: '0.3.284', cliVersion: '2.1.284',
        basicTurns: true, resume: true, fork: false, history: true } }).manager
  }
  return { manager: createManager(), createManager, modes, prompts, calls, get compactions() { return compactions },
    holdCompactionNotifications() { holdCompactionNotifications = true },
    releaseCompactionNotifications() {
      holdCompactionNotifications = false
      for (const notify of compactionNotifications.splice(0)) notify()
    },
    holdReply() { reply = deferred() },
    releaseReply() { reply?.resolve(); reply = undefined },
  }
}
