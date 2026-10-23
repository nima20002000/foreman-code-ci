import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { createCompanionServer } from '../src/companionServer.mjs';
import { persistentFixtureRoot } from './fixtureStorage.mjs';

test('companion pairing preserves the running Worker error and renders stop and retry instructions', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(persistentFixtureRoot, 'companion-pairing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.3' };
  const manifestFile = join(directory, 'manifest.json');
  await writeFile(manifestFile, JSON.stringify({ target }));
  const spawn = t.mock.method(childProcess, 'spawn', (_binary, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.once('finish', () => setImmediate(() => {
      if (args[1] === 'pair') child.stderr.end('worker_already_running: Stop the background Worker. private diagnostic\n');
      else child.stdout.end(JSON.stringify({ versions: target, pairing: 'unpaired', service: { active: true } }));
      child.emit('close', args[1] === 'pair' ? 1 : 0);
    }));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  const gui = await createCompanionServer({ stateDirectory: directory, manifestFile, installationRoot: join(directory, 'app') });
  t.after(() => gui.close());
  const post = await fetch(`${gui.origin}/api/pair`, { method: 'POST',
    headers: { origin: gui.origin, 'content-type': 'application/json', 'x-graphql-companion-session': gui.session },
    body: JSON.stringify({ enrollmentCode: 'GQLWE1.private-code' }) });
  assert.equal(post.status, 400);
  assert.deepEqual(await post.json(), { error: 'worker_already_running' });

  const html = await (await fetch(gui.origin)).text();
  const elements = new Map(), ready = Promise.withResolvers();
  function getElementById(id) {
    if (!elements.has(id)) {
      const element = { dataset: {}, events: {},
        addEventListener(name, callback) { this.events[name] = callback; },
        replaceChildren() {}, append() {}, toggleAttribute() {}, setAttribute() {},
      };
      if (id === 'state') Object.defineProperty(element, 'textContent', { set(value) { ready.resolve(value); } });
      elements.set(id, element);
    }
    return elements.get(id);
  }
  const location = new URL(gui.url);
  runInNewContext(html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1], {
    URLSearchParams, location,
    history: { replaceState(_state, _title, path) { location.href = new URL(path, location).href; } },
    document: { getElementById, createElement: () => ({ style: {} }) },
    fetch: (path, options) => fetch(new URL(path, gui.origin), {
      ...options, headers: { ...options.headers, origin: gui.origin },
    }),
  });
  await ready.promise;
  elements.get('code').value = 'GQLWE1.private-code';
  await elements.get('pairForm').events.submit({ preventDefault() {} });
  const message = elements.get('m3');
  assert.equal(message.dataset.tone, 'bad');
  assert.match(message.textContent, /Stop the background Worker/);
  assert.match(message.textContent, /systemctl --user stop graphql-worker\.service/);
  assert.match(message.textContent, /same pairing code/);
  assert.match(message.textContent, /systemctl --user start graphql-worker\.service/);
  assert.doesNotMatch(message.textContent, /private diagnostic|private-code/);
  assert.equal(elements.get('retry').hidden, false);
  assert.equal(elements.get('pair').disabled, false);
});
