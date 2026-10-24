import { INSTALLATION_NAMES } from './installationNames.mjs'
/** Product copy and supported native connection names; persisted identifiers stay stable. */
export const PRODUCT_NAME = 'Foreman Code'
export const PRODUCT_SLUG = 'foreman-code'
export const MCP_DISPLAY_NAME = 'Foreman Code MCP'
export const APP_MCP_SERVER_NAMES = ['foreman-code', INSTALLATION_NAMES.mcp.server] as const
export const APP_MCP_TOKEN_NAMES = [INSTALLATION_NAMES.environment.MCP_TOKEN] as const
