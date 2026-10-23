import { defineConfig } from 'vitest/config'

// Live cross-computer CI acceptance (docs/runbooks/cross-computer-ci-acceptance.md). It drives an already-running
// production Main and its paired Worker, with real model and CI usage, so no CI suite or release gate runs it: an
// operator runs it by hand with this config. It needs no local app or test database.
export default defineConfig({
  test: {
    include: ['test/cross-computer-ci.acceptance.test.ts'],
    maxWorkers: 1,
    // One case runs two consecutive rounds of 16 Agent executions and 12 full CI requests on live computers; the
    // runbook's credentials cover this nine-hour bound. Its steps carry their own shorter deadlines.
    testTimeout: 9 * 60 * 60_000,
  },
})
