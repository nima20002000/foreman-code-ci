import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, ClaudeHarnessConfigurationSchema } from '@foreman-code/contracts'
import { capabilityDescriptorsOf, harnessCapabilityDescriptors, supportsExpectedTurnSteer } from './capabilities.js'
import { pendingSessionControls } from './sessionControlDefaults.js'

const claude = ClaudeHarnessConfigurationSchema.parse({ harness: 'claude', model: 'fixture', authMode: 'subscription',
  configDirectory: '/fixture/profile', permissionMode: 'default', sandbox: 'danger-full-access',
  tools: [], permissionRules: [], instructions: '', mcpServers: {} })

describe('harness capability descriptors', () => {
  it('lets only Codex steer the exact active turn', () => {
    expect(supportsExpectedTurnSteer({ harness: 'codex' })).toBe(true)
    expect(supportsExpectedTurnSteer({ harness: 'claude' })).toBe(false)
    expect(supportsExpectedTurnSteer({ harness: 'opencode' })).toBe(false)
  })

  it('lets both live harnesses compact and treats an unknown harness as having nothing', () => {
    expect(harnessCapabilityDescriptors('codex').compact).toBe('native')
    expect(harnessCapabilityDescriptors('claude').compact).toBe('native')
    expect(harnessCapabilityDescriptors('other')).toEqual({ steer: 'unavailable', compact: 'unavailable',
      inputIdentity: 'unavailable', files: 'unavailable', applicationMcp: 'unavailable', autoCompact: false })
  })

  it('prefers the descriptors an adapter declares over the harness table', () => {
    expect(capabilityDescriptorsOf({ harness: 'claude', harnessCapabilities: { ...harnessCapabilityDescriptors('claude'), steer: 'native_expected_turn' } }).steer)
      .toBe('native_expected_turn')
  })

  it('offers compaction in a chat that has no native session yet', () => {
    expect(pendingSessionControls(DEFAULT_HARNESS_DEFAULTS.codex).compact.supported).toBe(true)
    expect(pendingSessionControls(claude).compact.supported).toBe(true)
    expect(pendingSessionControls(DEFAULT_HARNESS_DEFAULTS.codex).autoCompact.supported).toBe(false)
    expect(pendingSessionControls(claude).autoCompact.supported).toBe(true)
  })
})

it('describes native identity, file delivery and application credential lifetimes independently of steering', () => {
  expect(harnessCapabilityDescriptors('codex')).toMatchObject({
    inputIdentity: 'turn', files: 'turn_mcp', applicationMcp: 'session_config',
  })
  expect(harnessCapabilityDescriptors('claude')).toMatchObject({
    inputIdentity: 'message', files: 'session_bridge', applicationMcp: 'startup_config',
  })
  const adapter = { harness: 'another-native-driver', harnessCapabilities: harnessCapabilityDescriptors('claude') }
  expect(capabilityDescriptorsOf(adapter).inputIdentity).toBe('message')
  expect(capabilityDescriptorsOf(adapter).files).toBe('session_bridge')
})
