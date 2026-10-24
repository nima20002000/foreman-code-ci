import { it } from 'vitest'
import { rejectsUnownedStartup } from './helpers/testStartupIsolation.js'

it(
  'refuses prepared native acceptance when the real API uses an unowned GRAPHQL_APP_MCP_DIRECTORY',
  () => rejectsUnownedStartup('GRAPHQL_APP_MCP_DIRECTORY'),
  120_000,
)
