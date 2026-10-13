import { DEFAULT_MANAGEMENT_ACTIONS, type ManagementAction } from '@foreman-code/contracts/management'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../modules/jobs/ciAuthority.js'

/** Omitted --access preserves the existing CLI behavior; explicit read-only never gains mutations. */
export function credentialActions(access: 'manage' | 'read-only' | 'ci-lane' = 'manage'): ManagementAction[] {
  if (access === 'ci-lane') return [...new Set([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS, 'capabilities:read' as const])]
  return access === 'read-only' ? DEFAULT_MANAGEMENT_ACTIONS.filter((action) => action.endsWith(':read')) : [...DEFAULT_MANAGEMENT_ACTIONS]
}
