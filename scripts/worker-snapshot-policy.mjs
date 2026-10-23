import { verificationScripts } from '../packages/verification-runner/runtime-files.mjs'
export { verificationScripts }

export const workerEntryPoints = {
  cli: 'apps/worker/src/cli.mjs',
  worker: 'apps/worker/src/workerFactory.mjs',
}
export const rsyncWriterEntrypoint = 'apps/api/src/modules/byte-transfer/rsyncWriterCli.ts'
export const schemaWorkerEntrypoint = 'apps/api/src/modules/harnesses/compatibility/schemaWorker.ts'

export const workerSnapshotFiles = [
  'apps/web/public/graphql.svg',
  'scripts/build-worker-artifact.mjs',
  'scripts/quota-helper-abi.mjs',
  'scripts/worker-artifact-files.mjs',
  'scripts/worker-snapshot-policy.mjs',
  'scripts/foreman-mcp.mjs',
  'packages/contracts/package.json',
  'packages/contracts/src/productEnvironment.mjs',
  'packages/contracts/src/installationNames.mjs',
  'packages/contracts/src/verificationEnvironment.mjs',
  'packages/contracts/src/integrationScheduling.mjs',
  'packages/ci-protocol/src/testResults.mjs',
  'apps/api/package.json',
  'apps/ci/package.json',
  'apps/worker/package.json',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
]

export function assertWorkerSnapshotSource(path) {
  const forbiddenApiModule = /^apps\/api\/src\/(?:server|app|production)\.ts$/.test(path)
    || /^apps\/api\/src\/(?:infrastructure\/(?:db|database)|(?:db|migrations|bootstrap)\/)/.test(path)
  const invalidPath = path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')
  const testSource = /\.(?:test|spec)\.[cm]?[jt]s$/.test(path)
  const secretSource = /(?:^|\/)\.env(?:\.|$)|\.(?:pem|key)$|(?:^|\/)(?:credentials|secrets)\.json$/.test(path)
  const allowedSource = path.startsWith('apps/api/src/') || path.startsWith('apps/ci/src/') || path.startsWith('apps/worker/src/')
    || path.startsWith('apps/worker/artifacts/') || path.startsWith('packages/contracts/src/')
    || verificationScripts.includes(path) || workerSnapshotFiles.includes(path)
  if (forbiddenApiModule || invalidPath || testSource || secretSource || !allowedSource) {
    throw new Error(`Forbidden snapshot source: ${path}`)
  }
}

/** Workspace packages the Worker bundles from source: package directory by short name. */
export const workerPackages = Object.freeze({ contracts: 'packages/contracts', ci: 'apps/ci', api: 'apps/api' })

/** Bundler aliases from each package's exported dist module to its TypeScript source.
 * @param {Partial<Record<keyof typeof workerPackages, Record<string, unknown>>>} manifests `exports` by package. */
export function workerPackageAliases(manifests) {
  return Object.fromEntries(Object.entries(manifests).flatMap(([name, exports]) => {
    const directory = workerPackages[name]
    if (!directory) throw new Error(`Unknown Worker package: ${name}`)
    return Object.entries(exports ?? {}).map(([key, value]) => [
      key === '.' ? `@foreman-code/${name}` : `@foreman-code/${name}/${key.slice(2)}`,
      `./${directory}/${(typeof value === 'string' ? value : value.import)
        .replace('./dist/', './src/').replace(/\.js$/, '.ts')}`,
    ])
  }))
}

export function workerContractAliases(exports) {
  return workerPackageAliases({ contracts: exports })
}
