// Machine administration: what the API asks of the computer it runs on, and what a paired computer's agent does for
// Main. The API calls HostAdministration and does not run OS commands itself.
import { HostSystem, type HostSystemPorts } from './system.js'

export { HostSystem } from './system.js'
export type { HostStep, HostSystemPorts } from './system.js'

/** The one interface the API calls for machine administration. */
export interface HostAdministration {
  /** OS packages and restarts. */
  readonly system: HostSystem
}

export function createHostAdministration(ports: HostSystemPorts): HostAdministration {
  return { system: new HostSystem(ports) }
}
