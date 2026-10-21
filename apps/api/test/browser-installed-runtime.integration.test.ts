import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserSnapshotKeyStore, type BrowserPairingAuthority, type BrowserInstallationBinding } from '../src/modules/browser-profiles/keys.js'
import type { BrowserSnapshotTransfer } from '../src/modules/browser-profiles/types.js'
import type { BrowserRuntimeInstallation } from '../src/modules/browser-runtime/browserUseAdapter.js'
import type { BrowserHostOptions, BrowserHostKeyRequests, createBrowserHost } from '../src/modules/browser-runtime/hostFactory.js'
import type { AgentSubject, BrowserActor, BrowserSession, BrowserPreparedBinding, BrowserHostAction, BrowserPrepareResult } from '../src/modules/browser-runtime/types.js'

type Host = Awaited<ReturnType<typeof createBrowserHost>>
type InstalledRuntime = BrowserRuntimeInstallation & { manifestSha256: string; nativeHostModule: string }
type InstalledHostModule = Pick<typeof import('../src/modules/browser-runtime/hostFactory.js'), 'createBrowserHost'>
type HostFixture = { host: Host; computerId: string; options: BrowserHostOptions;
  prepare(subject: AgentSubject, profileId: string): Promise<BrowserSession>; reopen(): Promise<void>; close(): Promise<void> }

const downloadBytes = Buffer.from([0, 255, 9, 10, 13, 128, 67, 68])
let root: string, site: Server, origin: string, runtime: InstalledRuntime, native: InstalledHostModule
let keys: BrowserSnapshotKeyStore, pairing: BrowserPairingAuthority
const hosts = new Set<HostFixture>(), failures: unknown[] = []
const bindingByComputer = new Map<string, BrowserInstallationBinding>(), wrappingByComputer = new Map<string, Buffer>()
const published = new Map<string, BrowserSnapshotTransfer>()

function subjects(): AgentSubject[] {
  const agent = { workspaceId: 'fixture-workspace', workflowId: 'fixture-workflow', workflowNodeId: 'fixture-node',
    agentId: 'fixture-agent', productRole: 'coder' as const, displayName: 'Browser fixture', configurationVersionId: 'fixture-configuration' }
  return [
    { kind: 'execution', agent, execution: { runId: 'fixture-run', workflowVersionId: 'fixture-version', executionId: 'fixture-execution', attempt: 1 } },
    { kind: 'conversation', agent, conversationId: 'fixture-conversation' },
    { kind: 'coordinator_consultation', agent: { ...agent, productRole: 'orchestrator' }, binding: {
      runId: 'fixture-run', workflowVersionId: 'fixture-version', waitingActivationId: 'fixture-waiting', delegationGroupId: 'fixture-group',
      consultationId: 'fixture-consultation', nativeSessionId: 'fixture-native-consultation', purpose: 'consultation' } },
  ]
}

function page(path: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Managed browser fixture</title>
<style>body{font:16px sans-serif;margin:12px}button,input,a{position:absolute;height:36px;box-sizing:border-box}#text{left:12px;top:90px;width:250px}#dialog{left:12px;top:150px;width:120px}#popup{left:160px;top:150px;width:120px}#file{left:12px;top:210px;width:330px}#download{left:12px;top:270px;width:200px}#facts{position:absolute;left:380px;top:20px}iframe{position:absolute;left:380px;top:250px;width:220px;height:100px}</style>
<h1>Managed browser fixture</h1><div id="account"></div>
<input id="text" aria-label="Fixture text"><button id="dialog">Dialog</button><button id="popup">Popup</button>
<input id="file" type="file" aria-label="Fixture upload"><a id="download" href="/download" download="fixture-download.bin">Download fixture</a>
<div id="facts"><div id="stored"></div><div id="typed">Typed:</div><div id="dialogResult">Dialog result:</div><div id="uploadResult">Upload:</div></div>
<iframe title="Owned fixture frame" src="/frame"></iframe>
<script>
const path = ${JSON.stringify(path)};
if (path === '/login') { localStorage.setItem('remembered', 'present'); localStorage.setItem('removed-next', 'present'); }
if (path === '/logout') localStorage.clear();
if (path === '/local') localStorage.setItem('destination-only', 'present');
document.querySelector('#account').textContent = document.cookie.split(';').some(x => x.trim() === 'fixture_login=present') ? 'Signed in' : 'Signed out';
document.querySelector('#stored').textContent = 'Remembered: ' + (localStorage.getItem('remembered') ?? 'absent') + '; Removed-next: ' + (localStorage.getItem('removed-next') ?? 'absent') + '; Destination-only: ' + (localStorage.getItem('destination-only') ?? 'absent');
document.querySelector('#text').addEventListener('input', e => document.querySelector('#typed').textContent = 'Typed: ' + e.target.value);
document.querySelector('#dialog').onclick = () => document.querySelector('#dialogResult').textContent = 'Dialog result: ' + (confirm('Fixture confirmation') ? 'accepted' : 'dismissed');
document.querySelector('#popup').onclick = () => window.open('/popup', '_blank');
document.querySelector('#file').onchange = async e => { const bytes = await e.target.files[0].arrayBuffer(); const result = await fetch('/upload-echo', {method:'POST',body:bytes}); document.querySelector('#uploadResult').textContent = 'Upload: ' + await result.text(); };
</script>`
}

async function startSite(): Promise<void> {
  site = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    response.setHeader('cache-control', 'no-store')
    if (path === '/download') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture-download.bin"' })
      response.end(downloadBytes); return
    }
    if (path === '/upload-echo') {
      const chunks: Buffer[] = []; let length = 0
      for await (const part of request) {
        const bytes = Buffer.from(part); length += bytes.length
        if (length > 262_144) { response.writeHead(413); response.end(); return }
        chunks.push(bytes)
      }
      response.writeHead(200, { 'content-type': 'text/plain' }); response.end(Buffer.concat(chunks).toString('base64')); return
    }
    if (path === '/login') response.setHeader('set-cookie', 'fixture_login=present; Max-Age=86400; Path=/; SameSite=Lax')
    if (path === '/logout') response.setHeader('set-cookie', 'fixture_login=; Max-Age=0; Path=/; SameSite=Lax')
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(path === '/frame' ? '<!doctype html><title>Owned frame</title><p>Owned iframe content</p>' : page(path))
  })
  await new Promise<void>((resolve, reject) => { site.once('error', reject); site.listen(0, '127.0.0.1', resolve) })
  const address = site.address()
  if (!address || typeof address === 'string') throw new Error('The deterministic local website did not acquire a port.')
  origin = `http://127.0.0.1:${address.port}`
}

function requireReady(result: BrowserPrepareResult): BrowserSession {
  if (result.kind !== 'ready') throw new Error(`Installed browser preparation failed: ${result.reason} (retryable=${result.retryable}).`)
  return result.session
}
const agent = (session: BrowserSession, epoch = 0): BrowserActor => ({ kind: 'agent', browserGeneration: session.browserGeneration, epoch })
const viewer = (session: BrowserSession, viewerId: string, epoch: number): BrowserActor => ({ kind: 'viewer', viewerId, browserGeneration: session.browserGeneration, epoch })

async function hostFixture(computerId = randomUUID()): Promise<HostFixture> {
  const binding: BrowserInstallationBinding = { computerId, installationId: randomUUID(), connectionId: randomUUID() }
  bindingByComputer.set(computerId, binding); wrappingByComputer.set(computerId, randomBytes(32))
  const assignments = new Map<string, BrowserPreparedBinding>()
  const keyRequests: BrowserHostKeyRequests = {
    exportKey: async (caller, input) => {
      await pairing.assertCurrent(caller)
      await keys.allocate({ ...input, source: caller })
      return keys.envelope(input.operationId, caller)
    },
    snapshotKey: async (caller, transfer, jobId) => {
      await pairing.assertCurrent(caller)
      if (published.get(jobId)?.snapshot.sha256 !== transfer.snapshot.sha256) throw new Error('This fixture transfer was not admitted for its snapshot.')
      return keys.snapshotEnvelope(transfer.snapshot, caller)
    },
  }
  const options: BrowserHostOptions = { stateDirectory: join(root, computerId), computerId, installationId: binding.installationId,
    runtime, pairing, keys: keyRequests, assertHostOwnership: async () => { await pairing.assertCurrent(binding) },
    reportFailure: error => { failures.push(error) },
    subjectAuthority: {
      resolve: async subject => {
        const found = assignments.get(JSON.stringify(subject))
        if (!found) throw new Error('The native fixture did not authorize this exact subject.')
        return found
      },
      assertCurrent: async subject => { if (!assignments.has(JSON.stringify(subject))) throw new Error('The exact fixture subject has ended.') },
    } }
  const fixture: HostFixture = {
    host: await native.createBrowserHost(options), computerId, options,
    async prepare(subject, profileId) {
      const browser = { enabled: true, profileId }
      assignments.set(JSON.stringify(subject), { subject, browser, computerId, readOnly: false, availability: 'ready' })
      return requireReady(await fixture.host.broker.prepare({ subject, browser, computerId, commandId: randomUUID() }))
    },
    async reopen() { await fixture.host.close(); fixture.host = await native.createBrowserHost(options) },
    async close() { await fixture.host.close(); hosts.delete(fixture) },
  }
  hosts.add(fixture)
  return fixture
}

async function createProfile(f: HostFixture, profileId: string) {
  await f.host.profileEndpoint.create({ profileId, computerId: f.computerId, installationId: f.options.installationId,
    operationId: randomUUID(), revision: 1 })
}
async function setup(f: HostFixture, profileId: string) {
  const session = await f.host.broker.openSetup(profileId, randomUUID()), viewerId = randomUUID()
  const control = await f.host.broker.acquire({ sessionId: session.id, viewerId, browserGeneration: session.browserGeneration, commandId: randomUUID() })
  expect(control.state).toBe('user')
  return { session, actor: viewer(session, viewerId, control.epoch) }
}
async function action(f: HostFixture, session: BrowserSession, actor: BrowserActor, value: BrowserHostAction, tabId = session.selectedTabId!) {
  return f.host.broker.action({ sessionId: session.id, tabId, actor, action: value, commandId: randomUUID() })
}
async function navigate(f: HostFixture, session: BrowserSession, actor: BrowserActor, path: string, tabId = session.selectedTabId!) {
  await action(f, session, actor, { kind: 'navigate', url: `${origin}${path}` }, tabId)
  await expect.poll(async () => (await f.host.broker.observe({ sessionId: session.id, tabId, actor })).url).toBe(`${origin}${path}`)
}
async function text(f: HostFixture, session: BrowserSession, actor: BrowserActor, tabId = session.selectedTabId!) {
  return (await f.host.broker.observe({ sessionId: session.id, tabId, actor })).text
}
async function closeSetup(f: HostFixture, session: BrowserSession) {
  expect(await f.host.broker.closeSetup(session.id)).toMatchObject({ state: 'closed' })
}

describe('installed managed browser against a deterministic local website', () => {
  beforeAll(async () => {
    const runtimeRoot = process.env.FOREMAN_BROWSER_RUNTIME_ROOT, expected = process.env.FOREMAN_BROWSER_RUNTIME_MANIFEST_SHA256
    if (!runtimeRoot || !isAbsolute(runtimeRoot) || !expected || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error('Selected native browser acceptance requires FOREMAN_BROWSER_RUNTIME_ROOT (an absolute installed runtime directory) and FOREMAN_BROWSER_RUNTIME_MANIFEST_SHA256 (its approved 64-character manifest identity). Build and install the tested runtime first; this suite never downloads, installs, substitutes, or skips a missing runtime.')
    }
    // The public installer reader verifies the selected unit, every runtime file and its completed readiness receipt.
    const installer: { readInstalledBrowserRuntime(input: { runtimeRoot: string }): Promise<InstalledRuntime> } =
      await import(new URL('../../worker/src/browserRuntimeInstall.mjs', import.meta.url).href)
    runtime = await installer.readInstalledBrowserRuntime({ runtimeRoot })
    expect(runtime.manifestSha256).toBe(expected)
    native = await import(pathToFileURL(runtime.nativeHostModule).href)
    if (typeof native.createBrowserHost !== 'function') throw new Error('The installed runtime has no supported browser host entrypoint.')
    root = await mkdtemp(join(tmpdir(), 'installed-browser-'))
    pairing = {
      current: async computerId => { const value = bindingByComputer.get(computerId); if (!value) throw new Error('Unknown fixture computer'); return value },
      assertCurrent: async binding => {
        const current = bindingByComputer.get(binding.computerId)
        if (!current || current.installationId !== binding.installationId || current.connectionId !== binding.connectionId) throw new Error('Stale fixture pairing')
      },
      assertInstallation: async (computerId, installationId) => {
        if (bindingByComputer.get(computerId)?.installationId !== installationId) throw new Error('Stale fixture installation')
      },
      wrappingKey: async binding => { await pairing.assertCurrent(binding); return Buffer.from(wrappingByComputer.get(binding.computerId)!) },
    }
    keys = new BrowserSnapshotKeyStore(join(root, 'keys'), pairing)
    await startSite()
  }, 30_000)

  afterAll(async () => {
    const cleanup: unknown[] = []
    for (const f of hosts) { try { await f.close() } catch (error) { cleanup.push(error) } }
    if (site?.listening) await new Promise<void>((resolve, reject) => site.close(error => error ? reject(error) : resolve()))
    // Never delete native ownership receipts when process cleanup has not been confirmed.
    if (root && cleanup.length === 0) await rm(root, { recursive: true, force: true })
    if (cleanup.length || failures.length) throw new AggregateError([...cleanup, ...failures], 'Installed browser acceptance reported native or cleanup failures.')
  }, 30_000)

  it('keeps the managed setup sign-in and local storage through host shutdown and a new browser generation', async () => {
    const f = await hostFixture(); await createProfile(f, 'profile')
    const first = await setup(f, 'profile')
    await navigate(f, first.session, first.actor, '/login')
    await expect.poll(() => text(f, first.session, first.actor)).toContain('Signed in')
    expect(await text(f, first.session, first.actor)).toContain('Remembered: present')
    await closeSetup(f, first.session); await f.reopen()
    const reopened = await setup(f, 'profile')
    expect(reopened.session.browserGeneration).toBeGreaterThan(first.session.browserGeneration)
    await navigate(f, reopened.session, reopened.actor, '/state')
    expect(await text(f, reopened.session, reopened.actor)).toContain('Signed in')
    expect(await text(f, reopened.session, reopened.actor)).toContain('Remembered: present')
    expect(f.host.status()).toMatchObject({ ready: true, admissionPaused: false, runtimeVersion: runtime.runtimeVersion })
    await closeSetup(f, reopened.session); await f.close()
  }, 30_000)

  it('leases at least two tabs to each canonical subject and shares profile login without sibling target or focus access', async () => {
    const f = await hostFixture(); await createProfile(f, 'shared')
    const sessions: BrowserSession[] = []
    for (const subject of subjects()) sessions.push(await f.prepare(subject, 'shared'))
    await navigate(f, sessions[0]!, agent(sessions[0]!), '/login')
    for (const session of sessions) {
      const created = await f.host.broker.createTab({ sessionId: session.id, actor: agent(session), commandId: randomUUID() })
      expect(f.host.broker.read(session.id).tabs).toHaveLength(2)
      await navigate(f, session, agent(session), '/state', created.createdTabId)
      expect(await text(f, session, agent(session), created.createdTabId)).toContain('Signed in')
    }
    expect(new Set(sessions.map(session => session.browserGeneration)).size).toBe(1)
    expect(new Set(sessions.flatMap(session => f.host.broker.read(session.id).tabs.map(tab => tab.tabId))).size).toBe(6)
    const first = sessions[0]!, sibling = sessions[1]!
    const selected = f.host.broker.read(first.id).session.selectedTabId
    const siblingSelected = f.host.broker.read(sibling.id).session.selectedTabId
    const held = await f.host.broker.acquire({ sessionId: first.id, viewerId: 'human', browserGeneration: first.browserGeneration, commandId: randomUUID() })
    expect(held.state).toBe('user')
    await f.host.broker.selectTab({ sessionId: first.id, tabId: first.selectedTabId!, actor: viewer(first, 'human', held.epoch), commandId: randomUUID() })
    expect(f.host.broker.read(first.id).session.selectedTabId).toBe(selected)
    expect(f.host.broker.read(sibling.id).session.selectedTabId).toBe(siblingSelected)
    const returned = await f.host.broker.releaseControl({ sessionId: first.id, viewerId: 'human', epoch: held.epoch, commandId: randomUUID() })
    expect(returned.state).toBe('agent')
    await expect(action(f, first, agent(first, returned.epoch), { kind: 'navigate', url: `${origin}/logout` }, siblingSelected!))
      .rejects.toMatchObject({ code: 'BROWSER_TAB_SCOPE' })
    for (const session of sessions) {
      expect(await f.host.broker.release({ sessionId: session.id, subject: session.subject!, commandId: randomUUID(), reason: 'terminal' })).toMatchObject({ state: 'closed' })
    }
    await f.close()
  }, 30_000)

  it('keeps a distinct profile signed out while takeover fences stale input and resume reads the user-edited page', async () => {
    const f = await hostFixture(); await createProfile(f, 'signed-in'); await createProfile(f, 'isolated')
    const first = await f.prepare(subjects()[0]!, 'signed-in'), isolated = await f.prepare(subjects()[1]!, 'isolated')
    await navigate(f, first, agent(first), '/login'); await navigate(f, isolated, agent(isolated), '/state')
    expect(await text(f, isolated, agent(isolated))).toContain('Signed out')
    const held = await f.host.broker.acquire({ sessionId: first.id, viewerId: 'human', browserGeneration: first.browserGeneration, commandId: randomUUID() })
    expect(held.state).toBe('user')
    const human = viewer(first, 'human', held.epoch)
    await f.host.broker.input({ sessionId: first.id, tabId: first.selectedTabId!, actor: human, firstSequence: 1, gestures: [
      { kind: 'pointer', phase: 'down', x: 50, y: 105, button: 0, buttons: 1 },
      { kind: 'pointer', phase: 'up', x: 50, y: 105, button: 0, buttons: 0 },
      { kind: 'composition', phase: 'start', text: '' }, { kind: 'composition', phase: 'update', text: '日本語' },
      { kind: 'composition', phase: 'end', text: '日本語' },
      { kind: 'key', phase: 'down', key: '!', code: 'Digit1', alt: false, control: false, meta: false, shift: true, repeat: false },
      { kind: 'key', phase: 'up', key: '!', code: 'Digit1', alt: false, control: false, meta: false, shift: true, repeat: false },
    ] })
    await expect.poll(() => text(f, first, human)).toContain('Typed: 日本語!')
    const returned = await f.host.broker.releaseControl({ sessionId: first.id, viewerId: 'human', epoch: held.epoch, commandId: randomUUID() })
    expect(returned.state).toBe('agent')
    await expect(f.host.broker.input({ sessionId: first.id, tabId: first.selectedTabId!, actor: human, firstSequence: 8,
      gestures: [{ kind: 'composition', phase: 'end', text: 'stale' }] })).rejects.toMatchObject({ code: 'BROWSER_STALE_INPUT' })
    expect(await text(f, first, agent(first, returned.epoch))).toContain('Typed: 日本語!')
    expect(await text(f, isolated, agent(isolated))).toContain('Signed out')
    await f.close()
  }, 30_000)

  it('handles actual page dialogs, owned file chooser bytes, retained downloads, popups and live frames', async () => {
    const f = await hostFixture(); await createProfile(f, 'profile')
    const { session, actor } = await setup(f, 'profile')
    await navigate(f, session, actor, '/state')
    const screenshot = await f.host.broker.screenshot({ sessionId: session.id, tabId: session.selectedTabId!, actor })
    expect(screenshot.mimeType).toBe('image/png'); expect(screenshot.bytes.byteLength).toBeGreaterThan(100)
    const media = await f.host.media.open({ ownerId: 'fixture-owner', viewerId: actor.viewerId!, sessionId: session.id,
      tabId: session.selectedTabId!, browserGeneration: session.browserGeneration, commandId: randomUUID() })
    await expect.poll(() => f.host.media.read(media.id, 'fixture-owner').frame?.data.byteLength ?? 0).toBeGreaterThan(100)
    await f.host.media.close(media.id, 'fixture-owner')
    const click = action(f, session, actor, { kind: 'click', x: 60, y: 165 }).then(value => ({ value }), error => ({ error }))
    await expect.poll(() => f.host.broker.nativeFacts(session.id).dialog?.message).toBe('Fixture confirmation')
    await action(f, session, actor, { kind: 'dialog', accept: true })
    expect(await click).not.toHaveProperty('error')
    await expect.poll(() => text(f, session, actor)).toContain('Dialog result: accepted')
    await action(f, session, actor, { kind: 'click', x: 70, y: 225 })
    await expect.poll(() => f.host.broker.nativeFacts(session.id).uploadChooser?.selector).toMatch(/^foreman-chooser:/)
    const selector = f.host.broker.nativeFacts(session.id).uploadChooser!.selector
    const owner = { sessionId: session.id, tabId: session.selectedTabId!, browserGeneration: session.browserGeneration }
    const bytes = Buffer.from([0, 255, 128, 65, 10]), upload = await f.host.files.begin({ ...owner,
      name: 'fixture-upload.bin', mimeType: 'application/octet-stream', byteLength: bytes.length, commandId: randomUUID() })
    await f.host.files.write({ fileId: upload.id, sessionId: session.id, offset: 0, bytes }); await f.host.files.finish(upload.id, session.id)
    const attachCommand = randomUUID()
    await f.host.broker.attachFile({ sessionId: session.id, tabId: owner.tabId, actor, fileId: upload.id, selector, commandId: attachCommand },
      attach => f.host.files.attach(upload.id, owner, attachCommand, attach))
    await expect.poll(() => text(f, session, actor)).toContain(`Upload: ${bytes.toString('base64')}`)
    await action(f, session, actor, { kind: 'click', x: 80, y: 285 })
    await expect.poll(async () => (await f.host.files.list(session.id)).filter(file => file.purpose === 'download' && file.state === 'ready').length).toBe(1)
    const download = (await f.host.files.list(session.id)).find(file => file.purpose === 'download' && file.state === 'ready')!
    expect(await f.host.files.read(download.id, session.id, 0, downloadBytes.length)).toEqual(downloadBytes)
    await action(f, session, actor, { kind: 'click', x: 200, y: 165 })
    await expect.poll(() => f.host.broker.read(session.id).tabs.length).toBe(2)
    const popup = f.host.broker.read(session.id).tabs.find(tab => tab.tabId !== session.selectedTabId)!
    expect(popup.openerTabId).toBe(session.selectedTabId)
    await expect.poll(async () => (await f.host.broker.observe({ sessionId: session.id, tabId: popup.tabId, actor })).url).toBe(`${origin}/popup`)
    await closeSetup(f, session)
    await f.host.files.closeSession(session.id)
    expect(await f.host.files.read(download.id, session.id, 0, downloadBytes.length)).toEqual(downloadBytes)
    await f.close()
  }, 30_000)

  let replica: { source: HostFixture; destination: HostFixture; profileId: string } | undefined
  async function replicate(source: HostFixture, destination: HostFixture, profileId: string, revision: number) {
    const operationId = randomUUID(), jobId = randomUUID()
    const transfer = await source.host.profileEndpoint.export({ profileId, computerId: source.computerId, publishedRevision: revision, operationId, jobId })
    await keys.seal(operationId, transfer.snapshot); published.set(jobId, transfer)
    async function* bytes() {
      for (let offset = 0; offset < transfer.manifest.byteLength;) {
        const chunk = await source.host.profileEndpoint.readSnapshot(transfer, offset)
        if (!chunk.length) throw new Error('Snapshot bytes ended before the published length.')
        offset += chunk.length; yield chunk
      }
    }
    await destination.host.profileEndpoint.receive({ profileId, computerId: destination.computerId,
      sourceComputerId: source.computerId, transfer, operationId: `receive:${jobId}`, revision: revision + 1, jobId }, bytes())
    return { transfer, input: { profileId, computerId: destination.computerId, transfer,
      operationId: `apply:${jobId}`, revision: revision + 1, jobId } }
  }

  it('stages encrypted supported state while a local replica is busy and applies a fresh generation after release', async () => {
    const source = await hostFixture(), destination = await hostFixture(), profileId = 'replicated-profile'
    replica = { source, destination, profileId }
    await createProfile(source, profileId); await createProfile(destination, profileId)
    const original = await setup(source, profileId), local = await setup(destination, profileId)
    await navigate(source, original.session, original.actor, '/login'); await navigate(destination, local.session, local.actor, '/local')
    await closeSetup(source, original.session)
    const next = await replicate(source, destination, profileId, 1)
    expect(next.transfer.manifest.origins).toContain(origin)
    await expect(destination.host.profileEndpoint.apply(next.input)).rejects.toMatchObject({ code: 'PROFILE_BUSY' })
    expect(await text(destination, local.session, local.actor)).toContain('Destination-only: present')
    await closeSetup(destination, local.session); await destination.host.profileEndpoint.apply(next.input)
    const imported = await setup(destination, profileId)
    expect(imported.session.browserGeneration).toBeGreaterThan(local.session.browserGeneration)
    await navigate(destination, imported.session, imported.actor, '/state')
    const importedText = await text(destination, imported.session, imported.actor)
    expect(importedText).toContain('Signed in'); expect(importedText).toContain('Remembered: present')
    expect(importedText).toContain('Destination-only: absent')
    await closeSetup(destination, imported.session)
  }, 30_000)

  it('preserves logout and storage deletion when the next snapshot replaces the managed replica', async () => {
    if (!replica) throw new Error('The preceding real snapshot replication did not establish its required fixture.')
    const { source, destination, profileId } = replica, original = await setup(source, profileId)
    await navigate(source, original.session, original.actor, '/logout')
    expect(await text(source, original.session, original.actor)).toContain('Signed out')
    await closeSetup(source, original.session)
    const next = await replicate(source, destination, profileId, 2)
    await destination.host.profileEndpoint.apply(next.input)
    const imported = await setup(destination, profileId)
    await navigate(destination, imported.session, imported.actor, '/state')
    const importedText = await text(destination, imported.session, imported.actor)
    expect(importedText).toContain('Signed out'); expect(importedText).toContain('Remembered: absent')
    expect(importedText).toContain('Removed-next: absent'); expect(importedText).toContain('Destination-only: absent')
    await closeSetup(destination, imported.session); await source.close(); await destination.close()
  }, 30_000)
})
