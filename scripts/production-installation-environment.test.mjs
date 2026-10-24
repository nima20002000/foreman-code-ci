import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEnv } from 'node:util'
import { localProductionEnvironment, renderEnvironment } from './local-production-runtime.mjs'
import { appMcpDirectory } from '../packages/contracts/src/productEnvironmentNode.mjs'

test('the installer writes the deployed API names while retaining the compose database credential name', () => {
  const environment = parseEnv(renderEnvironment(localProductionEnvironment('/installed/home', 'a'.repeat(64))))
  assert.equal(environment.FOREMAN_CODE_LOCAL_PRODUCTION, '1')
  assert.equal(environment.FOREMAN_CODE_BROWSER_ORIGIN, 'http://127.0.0.1:3041')
  assert.equal(environment.FOREMAN_CODE_WEB_DIST, '/installed/home/.local/lib/graphql-production/current/apps/web/dist')
  assert.equal(environment.FOREMAN_CODE_APP_MCP_DIRECTORY, '/installed/home/.local/share/graphql/mcp')
  assert.equal(appMcpDirectory(environment), environment.FOREMAN_CODE_APP_MCP_DIRECTORY)
  assert.equal(environment.GRAPHQL_PRODUCTION_DB_PASSWORD, 'a'.repeat(64))
  for (const suffix of ['LOCAL_PRODUCTION', 'BROWSER_ORIGIN', 'WEB_DIST', 'APP_MCP_DIRECTORY']) {
    assert.equal(Object.hasOwn(environment, `GRAPHQL_${suffix}`), false)
  }
})
