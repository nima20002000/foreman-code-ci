/**
 * Static control descriptors per harness. Code outside `modules/harnesses/` asks these instead of comparing
 * provider names: whether a harness can add input to an exact active turn, and whether it can compact a session.
 * This module imports no runtime code so every layer can use it.
 */

/** `native_expected_turn`: the provider adds input to the exact active turn and rejects it when that turn ended. */
export type HarnessSteerDescriptor = 'native_expected_turn' | 'unavailable'
export type HarnessCompactDescriptor = 'native' | 'unavailable'

export interface HarnessCapabilityDescriptors {
  readonly steer: HarnessSteerDescriptor
  readonly compact: HarnessCompactDescriptor
}

/** Codex app-server steers through the protocol-qualified `turn/steer` method. */
export const CODEX_CAPABILITY_DESCRIPTORS: HarnessCapabilityDescriptors = { steer: 'native_expected_turn', compact: 'native' }

/** Claude has no expected-turn steer; callers use Queue or Interrupt and send. */
export const CLAUDE_CAPABILITY_DESCRIPTORS: HarnessCapabilityDescriptors = { steer: 'unavailable', compact: 'native' }

const NO_CAPABILITIES: HarnessCapabilityDescriptors = { steer: 'unavailable', compact: 'unavailable' }

/** Descriptors for a harness name; an unknown or retired harness has none. */
export function harnessCapabilityDescriptors(harness: string): HarnessCapabilityDescriptors {
  if (harness === 'codex') return CODEX_CAPABILITY_DESCRIPTORS
  if (harness === 'claude') return CLAUDE_CAPABILITY_DESCRIPTORS
  return NO_CAPABILITIES
}

/** Accepts a manager, session, conversation row or configuration: any `harness` carrier. A manager's own
 * descriptors win over the table. */
export function capabilityDescriptorsOf(subject: { readonly harness: string; readonly harnessCapabilities?: HarnessCapabilityDescriptors | undefined }):
  HarnessCapabilityDescriptors {
  return subject.harnessCapabilities ?? harnessCapabilityDescriptors(subject.harness)
}

/** True when the harness can add input to the exact active native turn. */
export function supportsExpectedTurnSteer(subject: Parameters<typeof capabilityDescriptorsOf>[0]): boolean {
  return capabilityDescriptorsOf(subject).steer === 'native_expected_turn'
}
