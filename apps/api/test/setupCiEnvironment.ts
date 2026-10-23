import { beforeAll } from 'vitest'

// CI code reaches the API's logger, transactions, Git sources and device errors only through the services the API
// installs into the CI package. Install them the way Main does, but after the test file has loaded: a file's
// vi.mock calls are registered by then, so CI sees the same mocked modules the rest of the file sees.
beforeAll(async () => {
  await import('../src/modules/ci/platform.js')
  await import('../src/modules/ci/serverPorts.js')
})
