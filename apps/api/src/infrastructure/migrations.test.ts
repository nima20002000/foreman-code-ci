import { expect, it } from 'vitest'
import { assertMigrationVersions, LEGACY_UNORDERED_MIGRATIONS, migrations } from './migrations.js'

const legacy = (count = LEGACY_UNORDERED_MIGRATIONS) => Array.from({ length: count }, (_, index) => ({ version: index + 1 }))

it('rejects duplicate migration versions before applying either migration', () => {
  expect(() => assertMigrationVersions([{ version: 7 }, { version: 7 }]))
    .toThrow('Duplicate application migration version: 7')
})

it('preserves registered migration versions and accepts distinct versions in registration order', () => {
  expect(() => assertMigrationVersions([{ version: 8 }, { version: 3 }])).not.toThrow()
  expect(() => assertMigrationVersions(migrations)).not.toThrow()
})

it('requires every migration after the legacy entries to have a version greater than all earlier ones', () => {
  const recorded = [...legacy(), { version: 5_000 }]
  expect(() => assertMigrationVersions([...recorded, { version: 5_001 }])).not.toThrow()
  expect(() => assertMigrationVersions([...recorded, { version: 4_999 }]))
    .toThrow('Application migration 4999 must have a version greater than 5000')
})

it('appends a new registry migration only above the highest registered version', () => {
  const highest = Math.max(...migrations.map(({ version }) => version))
  expect(() => assertMigrationVersions([...migrations, { version: highest + 1 }])).not.toThrow()
  expect(() => assertMigrationVersions([...migrations, { version: highest - 1 }])).toThrow('must have a version greater than')
})

it('rejects versions the application_migrations integer column cannot record', () => {
  expect(() => assertMigrationVersions([{ version: 2_147_483_648 }])).toThrow('must be a positive PostgreSQL integer')
  expect(() => assertMigrationVersions([{ version: 1.5 }])).toThrow('must be a positive PostgreSQL integer')
  expect(() => assertMigrationVersions([{ version: 0 }])).toThrow('must be a positive PostgreSQL integer')
})
