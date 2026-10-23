import type pg from 'pg'

import type { ApiConfig } from '../../config.js'
import type { PostgresAccessService } from '../access/index.js'
import { CurrentWorkerCredentialService } from '../interactions/index.js'
import type { PostgresCommandCoordinator } from '../commands/index.js'
import { CodexAppServerSessionManager } from '../harnesses/index.js'
import { codexMcpInspectorAdapter } from '../harnesses/index.js'
import { McpDetectionService, WorkerLaunchCredentialService } from '../harnesses/index.js'
import { PostgresAppInteractionService } from '../interactions/index.js'
import type { PostgresInteractionRepository } from '../interactions/index.js'

export function localAppMcpEndpoint(host: string, port: number): string {
  const localHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host
  const authority = localHost.includes(':') && !localHost.startsWith('[') ? `[${localHost}]` : localHost
  return new URL('/mcp', `http://${authority}:${port}`).href
}

/** Used by normal startup and composition tests; no test-only launch wiring. */
export function createAppMcpRuntime(input: {
  pool: pg.Pool
  config: ApiConfig
  access: PostgresAccessService
  commands: PostgresCommandCoordinator
  interactions: PostgresInteractionRepository
  runnerId: string
}) {
  // The Codex manager supplies its model-free inspection primitive only.
  // Execution uses the production-qualified adapters.
  const codex = codexMcpInspectorAdapter(new CodexAppServerSessionManager(input.config.harnesses.codexBinary))
  const detection = new McpDetectionService(codex, localAppMcpEndpoint(input.config.host, input.config.port))
  const credentials = new CurrentWorkerCredentialService(input.pool, input.access)
  return {
    appMcp: {
      access: input.access,
      interactions: new PostgresAppInteractionService(input.pool, input.interactions, input.commands),
    },
    mcpDetection: { pool: input.pool, service: detection },
    executionCredentials: new WorkerLaunchCredentialService(detection, credentials, input.runnerId),
  }
}
