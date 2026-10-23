import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { capabilityDescriptorsOf, harnessCapabilityDescriptors, supportsExpectedTurnSteer } from './capabilities.js'
import { pendingSessionControls } from './sessionControlDefaults.js'

describe('harness capability descriptors', () => {
  it('lets only Codex steer the exact active turn', () => {
    expect(supportsExpectedTurnSteer({ harness: 'codex' })).toBe(true)
    expect(supportsExpectedTurnSteer({ harness: 'claude' })).toBe(false)
    expect(supportsExpectedTurnSteer({ harness: 'opencode' })).toBe(false)
  })

  it('lets both live harnesses compact and treats an unknown harness as having nothing', () => {
    expect(harnessCapabilityDescriptors('codex').compact).toBe('native')
    expect(harnessCapabilityDescriptors('claude').compact).toBe('native')
    expect(harnessCapabilityDescriptors('other')).toEqual({ steer: 'unavailable', compact: 'unavailable' })
  })

  it('prefers the descriptors an adapter declares over the harness table', () => {
    expect(capabilityDescriptorsOf({ harness: 'claude', harnessCapabilities: { steer: 'native_expected_turn', compact: 'native' } }).steer)
      .toBe('native_expected_turn')
  })

  it('offers compaction in a chat that has no native session yet', () => {
    expect(pendingSessionControls(DEFAULT_HARNESS_DEFAULTS.codex).compact.supported).toBe(true)
    expect(pendingSessionControls(DEFAULT_HARNESS_DEFAULTS.claude).compact.supported).toBe(true)
  })
})
