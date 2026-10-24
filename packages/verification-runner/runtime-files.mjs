/** Runtime assets shared by Worker, API, production, fixture cache and CI context packaging. */
export const verificationScripts = [
  'scripts/ci-watchdog.mjs',
  'scripts/ci-progress-reporter.mjs',
  'scripts/ci-test-results.mjs',
  'scripts/dense-resources.mjs',
  'scripts/verification-runner.mjs',
  'scripts/verify-repository.mjs',
  'scripts/verification-reports.mjs',
  'scripts/integration-process.mjs',
  'scripts/integration-capabilities.mjs',
  'packages/verification-runner/package.json',
  'packages/verification-runner/runtime-files.mjs',
  'packages/verification-runner/src/verification-runner.mjs',
  'packages/verification-runner/src/verification-reports.mjs',
  'packages/verification-runner/src/integration-process.mjs',
  'packages/verification-runner/src/integration-capabilities.mjs',
]

export const verificationRuntimeFiles = [
  ...verificationScripts,
  'apps/worker/src/diagnostics.mjs',
  'packages/contracts/src/installationNames.mjs',
  'packages/contracts/src/verificationEnvironment.mjs',
  'packages/contracts/src/integrationScheduling.mjs',
  'packages/ci-protocol/src/testResults.mjs',
]

/** Installed Workers retain their existing flattened scripts directory. */
export const verificationArtifactPath = path => path.replace(/^scripts\//, 'verification/')
