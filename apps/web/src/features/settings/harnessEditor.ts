import {
  SupportedHarnessConfigurationSchema, withAdvancedDefaults,
  type RecordedHarnessConfiguration, type AgentHarness,
} from '@foreman-code/contracts'

import { FieldValidationError } from './fieldValidation'

type Harness = AgentHarness
interface HarnessDraft {
  configuration: RecordedHarnessConfiguration
  shellEnvironmentText: string
  mcpText: string
}

/** Raw JSON and alternate-provider drafts are editor state, never domain/API fields. */
export interface HarnessEditor extends HarnessDraft {
  drafts?: Partial<Record<Harness, HarnessDraft>>
}

export function createHarnessEditor(value: RecordedHarnessConfiguration): HarnessEditor {
  const configuration = withAdvancedDefaults(value)
  if (configuration.harness === 'opencode') return { configuration, shellEnvironmentText: '', mcpText: '' }
  return {
    configuration,
    shellEnvironmentText: configuration.harness === 'codex' ? JSON.stringify(configuration.advanced!.shellEnvironment, null, 2) : '',
    mcpText: JSON.stringify(configuration.harness === 'codex'
      ? configuration.advanced!.mcpServers : configuration.mcpServers, null, 2),
  }
}

export function switchHarnessEditor(editor: HarnessEditor, next: Harness, preset?: RecordedHarnessConfiguration): HarnessEditor {
  if (editor.configuration.harness === next) return editor
  if (editor.configuration.harness === 'opencode') throw new Error('A retired harness is read-only.')
  const restored = editor.drafts?.[next] ?? (preset?.harness === next ? createHarnessEditor(preset) : undefined)
  if (!restored) return editor
  const { configuration, shellEnvironmentText, mcpText } = editor
  return { ...structuredClone(restored), drafts: {
    ...editor.drafts, [configuration.harness]: { configuration, shellEnvironmentText, mcpText },
  } }
}

function json(text: string, field: string, path: string[]): unknown {
  try { return JSON.parse(text) } catch { throw new FieldValidationError([{ path, message: `${field} must contain valid JSON.` }]) }
}

export function prepareHarnessEditor(editor: HarnessEditor): ReturnType<typeof SupportedHarnessConfigurationSchema.parse> {
  const value = withAdvancedDefaults(editor.configuration)
  if (value.harness === 'opencode') throw new FieldValidationError([{ path: ['harness'], message: 'A retired harness is read-only.' }])
  if (value.harness === 'claude') return SupportedHarnessConfigurationSchema.parse(value)
  return SupportedHarnessConfigurationSchema.parse({
    ...value,
    advanced: {
      ...value.advanced,
      additionalWritableDirectories: value.advanced!.additionalWritableDirectories.filter((path) => path !== ''),
      shellEnvironment: json(editor.shellEnvironmentText, 'Shell environment', ['advanced', 'shellEnvironment']),
      mcpServers: json(editor.mcpText, 'Native MCP controls', ['advanced', 'mcpServers']),
    },
  })
}
