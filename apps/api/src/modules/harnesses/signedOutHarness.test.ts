import { describe, expect, it } from 'vitest'
import { HarnessExecutionError } from './errors.js'
import { onlySignInRequired, qualificationError } from './qualificationErrors.js'
import { chatModelOptions } from './sessionControlDefaults.js'
import type { HarnessConfiguration } from '@foreman-code/contracts'

const codex = { harness: 'codex', model: 'gpt' } as HarnessConfiguration

describe('a signed-out harness', () => {
  it('is an ordinary answer, not a retryable server failure', () => {
    const error = qualificationError(new HarnessExecutionError('CODEX_APP_SERVER_AUTH_UNQUALIFIED', 'Authentication is required.'))
    expect(error.status).toBe(409)
    expect(error.message).toBe('Sign in to this harness on the server, then refresh.')
  })

  it('still reads chat session controls, without a model catalog', async () => {
    const signedOut = qualificationError(new HarnessExecutionError('CODEX_APP_SERVER_AUTH_UNQUALIFIED', 'Authentication is required.'))
    await expect(chatModelOptions(codex, async () => { throw signedOut })).resolves.toEqual([])
  })

  it('makes an automatic check batch that only waits for sign-in distinguishable from real failures', () => {
    const signedOut = qualificationError(new HarnessExecutionError('CODEX_APP_SERVER_AUTH_UNQUALIFIED', 'Authentication is required.'))
    const unreachable = qualificationError(new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Connection lost.'))
    expect(onlySignInRequired(new AggregateError([signedOut, signedOut]))).toBe(true)
    expect(onlySignInRequired(new AggregateError([signedOut, unreachable]))).toBe(false)
  })

  it('keeps other catalog failures visible', async () => {
    const unreachable = qualificationError(new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Connection lost.'))
    await expect(chatModelOptions(codex, async () => { throw unreachable })).rejects.toBe(unreachable)
  })
})
