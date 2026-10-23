// CI's MCP tool specs; the API's MCP servers register them with their own results, audit and discovery.
export { CI_ENROLLMENT_TOOL_SPECS, CI_TOOL_DESCRIPTIONS, CI_TOOL_SPECS, CIRCLE_ACCOUNT_TOOL_SPECS,
  COMPUTER_PREPARATION_TOOL_SPECS, ciToolInputSchema } from '@foreman-code/ci/tools'
export type { CiToolSpec } from '@foreman-code/ci/tools'
export { CI_ENROLLMENT_ACTIONS } from '@foreman-code/ci/ciEnrollment'
export { BUILD_COMPUTER_PREPARE_ACTIONS } from '@foreman-code/ci/ciRuntimeProvisioner'
