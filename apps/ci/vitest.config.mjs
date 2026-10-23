import { configDefaults, defineConfig } from 'vitest/config'

const configuredWorkers = process.env.FOREMAN_CODE_VERIFICATION_UNIT_WORKERS
const maxWorkers = configuredWorkers === undefined ? 4 : Number(configuredWorkers)
if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 256) {
  throw new Error('Verification unit workers must be an integer from 1 to 256')
}

export default defineConfig({
  test: {
    ...(process.env.CI_PROGRESS_FILE ? { runner: '../../packages/contracts/ci-test-runner.mjs', reporters: ['default', '../../scripts/ci-progress-reporter.mjs'] } : {}),
    // The owned test root holds fixture directories, and the test database serves the few tests that need Postgres.
    globalSetup: ['../../scripts/vitest-heavy-setup.mjs', '../../scripts/vitest-test-resources.mjs'],
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/dist/**'],
    // Leave CPU headroom for the Vitest coordinator and application processes.
    maxWorkers,
    // Runner cases start real processes and Git; the 5 s default times them out under load.
    testTimeout: 20_000,
    fsModuleCache: true,
  },
})
