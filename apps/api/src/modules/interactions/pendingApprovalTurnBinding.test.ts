import { PendingNativeInteractionSchema } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { pendingOnLaneTurn } from './pendingLaneTurn.js'

const options = [{ optionId: 'allow_once', semantic: 'approve_once', label: 'Allow once', persistence: 'request',
  affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }]
const claude = PendingNativeInteractionSchema.parse({
  session: { harness: 'claude', providerVersion: '2.1.284', nativeSessionId: 'claude-session' },
  turn: { nativeMessageId: 'submitted-message', nativeRequestId: 'request' },
  nativeRequestType: 'can_use_tool', request: { toolName: 'Bash', input: {} }, responseOptions: options,
})
const codex = PendingNativeInteractionSchema.parse({
  session: { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'thread' },
  turn: { nativeTurnId: 'turn', nativeRequestId: 'request' },
  nativeRequestType: 'item/commandExecution/requestApproval', request: {}, responseOptions: options,
})

it('binds a Claude tool approval to the lane by its submitted message id', () => {
  expect(pendingOnLaneTurn(claude, 'submitted-message')).toBe(true)
  expect(pendingOnLaneTurn(claude, 'other-message')).toBe(false)
  expect(pendingOnLaneTurn(claude, null)).toBe(false)
})

it('binds a Codex approval to the lane by its native turn id', () => {
  expect(pendingOnLaneTurn(codex, 'turn')).toBe(true)
  expect(pendingOnLaneTurn(codex, 'other-turn')).toBe(false)
  expect(pendingOnLaneTurn(codex, undefined)).toBe(false)
})
