import { INSTALLATION_NAMES } from './installationNames.mjs'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parseEnv } from 'node:util'
import { readProductEnvironment, resolveProductEnvironment } from './productEnvironment.mjs'

/**
 * Provider accounts may override HOME; the bridge belongs to the operating-system user.
 * @param {NodeJS.ProcessEnv} [environment]
 */
export function appMcpDirectory(environment = process.env) {
  const configured = readProductEnvironment(environment, 'APP_MCP_DIRECTORY')
  if (configured !== undefined && !isAbsolute(configured)) {
    throw new Error(`${INSTALLATION_NAMES.environment.APP_MCP_DIRECTORY} requires an absolute directory.`)
  }
  return configured ?? join(homedir(), INSTALLATION_NAMES.paths.mcpDirectory)
}

/**
 * Select the custom env file before reading it; process settings retain precedence.
 * @param {string | undefined} [defaultFile]
 * @param {NodeJS.ProcessEnv} [environment]
 */
export function loadProductEnvFile(defaultFile, environment = process.env) {
  const file = readProductEnvironment(environment, 'API_ENV_FILE') ?? defaultFile ?? '.env'
  const merged = resolveProductEnvironment(environment, parseEnv(readFileSync(file, 'utf8')))
  Object.assign(environment, merged)
}
