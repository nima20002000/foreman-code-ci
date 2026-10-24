import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadProductEnvFile } from './productEnvironmentNode.mjs'

describe('product env file selection', () => {
  it('selects the frozen selector before loading and keeps process precedence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'foreman-env-'))
    try {
      const custom = join(directory, 'custom.env')
      writeFileSync(custom, 'FOREMAN_CODE_WEB_PORT=5199\nFOREMAN_CODE_LAPTOP_EXECUTION_ENABLED=0\nDATABASE_URL=file-db\n')
      const environment: NodeJS.ProcessEnv = { FOREMAN_CODE_API_ENV_FILE: custom, FOREMAN_CODE_WEB_PORT: '5198', DATABASE_URL: 'process-db' }
      loadProductEnvFile(join(directory, 'missing-default.env'), environment)
      expect(environment.FOREMAN_CODE_WEB_PORT).toBe('5198')
      expect(environment.FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED).toBe('0')
      expect(environment.DATABASE_URL).toBe('process-db')
      expect(environment.GRAPHQL_WEB_PORT).toBeUndefined()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('does not use a product-name selector and leaves the environment unchanged on a missing file', () => {
    const environment = { GRAPHQL_API_ENV_FILE: '/missing/alias.env' }
    const original = { ...environment }
    expect(() => loadProductEnvFile('/missing/selected.env', environment)).toThrow('selected.env')
    expect(environment).toEqual(original)
  })
})
