import { readFile } from 'node:fs/promises'
import { checkCodexSchema, parseExport } from './schema.js'
import { sha256Hex } from '../../../shared/hash.js'

// A short-lived local schema parser, NOT a provider transport. Running compilation
// out of process lets the parent enforce its deadline without blocking the API.
try {
  const harness = process.argv[2]
  const file = process.argv[3]
  if (!file || harness !== 'codex') throw new Error('Invalid checker input.')
  const text = await readFile(file, 'utf8')
  const schema = parseExport(text)
  checkCodexSchema(schema)
  console.info(JSON.stringify({ ok: true, schemaSha256: sha256Hex(text) }))
} catch (error) {
  console.info(JSON.stringify({ ok: false, contract: error instanceof Error ? error.message.slice(0, 500) : 'schema validation' }))
}
