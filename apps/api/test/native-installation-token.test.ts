import { expect, it } from 'vitest'
import { appLauncherConnection } from '../src/modules/harnesses/appMcpLauncher.js'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE } from '../src/modules/access/workerCredentials.js'
import { appMcpTokenEnvironment } from '../src/modules/harnesses/secrets.js'

it('keeps the deployed native launcher token separate from saved Worker credential bindings', () => {
  expect(APP_MCP_TOKEN_ENVIRONMENT_VARIABLE).toBe('GRAPHQL_MCP_TOKEN')
  expect(appLauncherConnection().environmentVariables).toEqual(['FOREMAN_CODE_MCP_TOKEN'])
  expect(appMcpTokenEnvironment({ GRAPHQL_MCP_TOKEN: 'scoped-token' },
    { FOREMAN_CODE_APP_MCP_DIRECTORY: '/installed/mcp' })).toEqual({
    FOREMAN_CODE_MCP_TOKEN: 'scoped-token', FOREMAN_CODE_APP_MCP_DIRECTORY: '/installed/mcp',
  })
})
