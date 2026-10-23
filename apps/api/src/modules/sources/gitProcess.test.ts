import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { runGitProcess } from './gitProcess.js'

it.each(['cancelled', 'timed out'] as const)('lets a %s Git writer clean up before escalation', async interruption => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'git-grace-'))
  const bin = join(root, 'bin')
  const lock = join(root, 'writer.lock')
  const ready = join(root, 'ready')
  await mkdir(bin)
  await writeFile(join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => setTimeout(() => { fs.unlinkSync(${JSON.stringify(lock)}); process.exit(0); }, 350));
fs.writeFileSync(${JSON.stringify(lock)}, 'locked');
fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
setInterval(() => {}, 1000);
`, { mode: 0o700 })
  const controller = new AbortController()
  const environment = gitFixtureEnvironment()
  const running = runGitProcess(['status'], { signal: controller.signal,
    ...(interruption === 'timed out' ? { timeoutMs: 1500 } : {}) },
  { ...environment, PATH: `${bin}:${environment.PATH}` })
  try {
    await vi.waitFor(async () => expect(await readFile(ready, 'utf8')).toBe('ready'))
    if (interruption === 'cancelled') controller.abort()
    expect((await running).code).not.toBe(0)
    await expect(readFile(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    controller.abort()
    await running
    await rm(root, { recursive: true, force: true })
  }
})
