import { describe, expect, it } from 'vitest'
import { HarnessMcpConnectionSchema } from './management/harnessSettings.js'
import { readProductEnvironment, resolveProductEnvironment } from './productEnvironment.mjs'

describe('frozen installation environment', () => {
  it('reads the saved spelling without interpreting product-name aliases', () => {
    expect(readProductEnvironment({}, 'WEB_PORT')).toBeUndefined()
    expect(readProductEnvironment({ GRAPHQL_WEB_PORT: '05198' }, 'WEB_PORT')).toBe('05198')
    expect(readProductEnvironment({ FOREMAN_CODE_WEB_PORT: '5198' }, 'WEB_PORT')).toBeUndefined()
    expect(readProductEnvironment({ GRAPHQL_WEB_PORT: '5198', FOREMAN_CODE_WEB_PORT: '5199' }, 'WEB_PORT')).toBe('5198')
    expect(readProductEnvironment({ GRAPHQL_MCP_TOKEN: 'saved-token', FOREMAN_CODE_MCP_TOKEN: 'other-token' }, 'MCP_TOKEN')).toBe('saved-token')
    expect(readProductEnvironment({ FOREMAN_CODE_TEST_ROOT: '/owned/test' }, 'TEST_ROOT')).toBe('/owned/test')
  })

  it('keeps process precedence and leaves every name unchanged', () => {
    const file = { GRAPHQL_WEB_PORT: '5199', DATABASE_URL: 'file-db' }
    const process = { GRAPHQL_WEB_PORT: '5198', DATABASE_URL: 'process-db' }
    expect(resolveProductEnvironment(process, file)).toEqual(process)
    expect(resolveProductEnvironment({}, file)).toEqual(file)
    expect(file).toEqual({ GRAPHQL_WEB_PORT: '5199', DATABASE_URL: 'file-db' })
  })

  it.each(['API_ENV_FILE', 'HEAVY_BASE_TMPDIR', 'HEAVY_JOB_COMMON'])('preserves exact filesystem settings for %s', suffix => {
    expect(readProductEnvironment({ [`GRAPHQL_${suffix}`]: '/installation ' }, suffix)).toBe('/installation ')
  })

  it.each(['LAPTOP_EXECUTION_ENABLED', 'DEVICE_LISTENER_ENABLED', 'ENABLE_EXPERIMENTAL_CODEX_APP_SERVER'])(
    'leaves strict opt-in validation to the consumer for %s', suffix => {
      expect(readProductEnvironment({ [`GRAPHQL_${suffix}`]: '1 ' }, suffix)).toBe('1 ')
    },
  )
})

it.each(['GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN'])('keeps %s behind the managed credential boundary', name => {
  expect(HarnessMcpConnectionSchema.safeParse({ transport: 'remote', url: 'http://127.0.0.1:3000/mcp',
    bearerTokenEnvironmentVariable: name }).success).toBe(false)
})
