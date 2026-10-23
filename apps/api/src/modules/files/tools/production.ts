import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { PostgresAccessService } from '../../access/postgres.js'
import { PostgresFileConversationAuthorization } from '../authorization.js'
import type { TemporaryFileService } from '../service.js'
import { FileToolArtifacts } from './artifacts.js'
import { FileToolSessions } from './context.js'
import { registerFileToolsMcp } from './mcp.js'
import { PostgresFileToolRepository } from './postgres.js'
import { AgentFileToolService } from './service.js'
import type { FileReferenceResolver } from './types.js'

const registered = new WeakMap<FastifyInstance, AgentFileToolService>()

/** Creates the file tools and mounts their MCP endpoint on a standalone API instance. */
export function registerProductionFileTools(app: FastifyInstance, pool: pg.Pool, files: TemporaryFileService,
  references?: FileReferenceResolver): AgentFileToolService {
  const service = createProductionFileTools(app, pool, files, references)
  registerFileToolsMcp(app, service)
  return service
}

/** The file tools bound to one API instance. Their MCP endpoint mounts from `routes/registry.ts`. */
export function createProductionFileTools(app: FastifyInstance, pool: pg.Pool, files: TemporaryFileService,
  references?: FileReferenceResolver): AgentFileToolService {
  if (registered.has(app)) throw new Error('File tools are already registered for this API.')
  const repository = new PostgresFileToolRepository(pool)
  const access = new PostgresAccessService(pool)
  const sessions = new FileToolSessions(repository, (id) => access.currentOperator(id), new PostgresFileConversationAuthorization(pool))
  const artifacts = new FileToolArtifacts(repository, files.bytes, sessions)
  const service = new AgentFileToolService(files, sessions, artifacts, repository, references)
  registered.set(app, service)
  return service
}

/** Trusted composition seam for native harness registration. Never exposed as an HTTP issuer. */
export function productionFileTools(app: FastifyInstance): AgentFileToolService {
  const service = registered.get(app)
  if (!service) throw new Error('Register production file storage/tools before admitting a file session.')
  return service
}
