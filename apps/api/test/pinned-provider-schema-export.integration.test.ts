import { createRequire } from 'node:module'
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { checkCodexSchema, parseExport } from '../src/modules/harnesses/compatibility/schema.js'
import { passiveDriverPayloads } from '../src/modules/harnesses/payloadDiscovery.js'
import { copyProviderSchemas } from './helpers/remoteReviewProvider.js'

const require = createRequire(import.meta.url)

it('provisions locked provider schemas when the installed launcher has no native package', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'provider-schema-export-'))
  try {
    const installed = require.resolve('@openai/codex/bin/codex.js')
    const launcher = join(directory, 'incomplete-package/bin/codex.js')
    await mkdir(dirname(launcher), { recursive: true })
    await copyFile(installed, launcher)
    await copyFile(join(dirname(installed), '../package.json'), join(dirname(launcher), '../package.json'))
    expect(await passiveDriverPayloads('codex', launcher)).toEqual({ complete: false, paths: [] })

    const schemas = join(directory, 'schemas')
    await copyProviderSchemas(schemas, launcher)

    for (const variant of ['stable', 'experimental']) {
      const document = parseExport(await readFile(join(schemas, variant, 'codex_app_server_protocol.schemas.json'), 'utf8'))
      expect(document.definitions).toBeDefined()
      if (variant === 'experimental') expect(() => checkCodexSchema(document)).not.toThrow()
    }
    await expect(access(join(directory, 'incomplete-package/node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 240_000)
