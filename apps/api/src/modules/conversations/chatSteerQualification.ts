import type { AgentConfigurationVersion, OperatorConfigurationVersion } from '@foreman-code/contracts'
import { supportsExpectedTurnSteer } from '../harnesses/index.js'

/**
 * Installed-provider steering qualification for a live Agent or Operator chat owner. Codex app-server
 * owners (local or Worker-hosted) add input to the exact active turn through the protocol-qualified
 * `turn/steer` method; Claude has no expected-turn steer and uses Queue or Interrupt and send. The harness
 * capability descriptor decides, never the provider name.
 */
export async function qualifiedAgentChatSteer(_row: unknown,
  configuration: Pick<AgentConfigurationVersion | OperatorConfigurationVersion, 'harness'>): Promise<boolean> {
  return supportsExpectedTurnSteer(configuration.harness)
}
