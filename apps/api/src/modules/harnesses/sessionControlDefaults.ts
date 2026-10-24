import type { HarnessOptions } from '@foreman-code/contracts/management'
import { RETIRED_OPENCODE_MESSAGE, unavailableSessionControls, type RecordedHarnessConfiguration, type SessionControlCapabilities } from '@foreman-code/contracts'
import { harnessCapabilityDescriptors } from './capabilities.js'
import { harnessSignInRequired } from './qualificationErrors.js'

/** Preferences for a not-yet-created native session are desired, never applied. */
export interface ChatModelCatalog {
  modelOptions?(configuration: RecordedHarnessConfiguration): Promise<HarnessOptions['models']>
}

/** The chat model catalog. A signed-out harness has none yet; its session controls still read, without a model
 * window, and the composer reports the sign-in when a message is sent. */
export async function chatModelOptions(configuration: RecordedHarnessConfiguration,
  read: (harness: Exclude<RecordedHarnessConfiguration['harness'], 'opencode'>) => Promise<Pick<HarnessOptions, 'models'>>): Promise<HarnessOptions['models']> {
  if (configuration.harness === 'opencode') return []
  try { return (await read(configuration.harness)).models } catch (error) {
    if (harnessSignInRequired(error)) return []
    throw error
  }
}

export function pendingSessionControls(configuration: RecordedHarnessConfiguration,
  models: HarnessOptions['models'] = []): SessionControlCapabilities {
  if (configuration.harness === 'opencode') return unavailableSessionControls(
    `${configuration.harness}:${configuration.model}`, RETIRED_OPENCODE_MESSAGE)
  const controls = unavailableSessionControls(`${configuration.harness}:${configuration.model}`,
    'Native settings will be checked when the first session is admitted.')
  return { ...controls, model: configuration.model,
    modelCapacity: models.find(model => model.id === configuration.model)?.contextWindow ?? null,
    compact: { supported: harnessCapabilityDescriptors(configuration.harness).compact === 'native', reason: 'There is no native context to compact until the first message.' },
    plan: { supported: true, reason: 'Plan applies to the first native message; no model turn is created by this selection.' },
    autoCompact: { supported: harnessCapabilityDescriptors(configuration.harness).autoCompact, reason: harnessCapabilityDescriptors(configuration.harness).autoCompact
      ? 'Applies when the owned SDK query starts.' : 'This harness has no automatic-compaction toggle.' },
    autoCompactBudget: { supported: harnessCapabilityDescriptors(configuration.harness).autoCompact, reason: harnessCapabilityDescriptors(configuration.harness).autoCompact
      ? 'Native startup validates the token budget against its model window.' : 'This harness has no supported automatic budget control.' },
  }
}
