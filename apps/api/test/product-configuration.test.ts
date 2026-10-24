import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import { readDeviceListenerConfig } from '../src/modules/devices/productionConfig.js'
import { resolveLocalBrowserOrigin } from '@foreman-code/contracts/browser-origin'

const database = { DATABASE_URL: 'postgresql://graphql:graphql@127.0.0.1:5432/graphql' }
describe('frozen configuration boundaries', () => {
  it('preserves opt-in defaults and installation settings through the saved names', () => {
    const config = loadConfig({ ...database, GRAPHQL_LAPTOP_EXECUTION_ENABLED: '1' })
    expect(config.workerExecution?.enabled).toBe(true)
    expect(config.database.connectionString).toBe(database.DATABASE_URL)
    expect(config.checkpoints.schema).toBe('langgraph')
    expect(loadConfig(database).workerExecution?.enabled).toBe(false)
    expect(resolveLocalBrowserOrigin({ GRAPHQL_WEB_PORT: '5198' }).origin).toBe('http://127.0.0.1:5198')
    expect(new NativeRollout({ GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '0' }).enabled('codex')).toBe(false)
    expect(readDeviceListenerConfig({ GRAPHQL_DEVICE_LISTENER_ENABLED: '0' }, 3000)).toBeUndefined()
  })

  it('does not interpret product aliases and retains strict validation and security defaults', () => {
    expect(loadConfig({ ...database, FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: '1' }).workerExecution?.enabled).toBe(false)
    expect(loadConfig({ ...database, FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: '1', GRAPHQL_LAPTOP_EXECUTION_ENABLED: '0' }).workerExecution?.enabled).toBe(false)
    expect(() => loadConfig({ ...database, GRAPHQL_LAPTOP_EXECUTION_ENABLED: '1 ' })).toThrow()
    expect(() => resolveLocalBrowserOrigin({ GRAPHQL_BROWSER_ORIGIN: 'https://example.com' })).toThrow('loopback')
    expect(new NativeRollout({ NODE_ENV: 'production', GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1' }).enabled('codex')).toBe(false)
    expect(() => readDeviceListenerConfig({ GRAPHQL_DEVICE_LISTENER_ENABLED: '1 ' }, 3000)).toThrow()
  })
})
