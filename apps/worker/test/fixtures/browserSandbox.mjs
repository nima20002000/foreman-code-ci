import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function usable(info) {
  return info.isFile() && info.uid === 0 && (info.mode & 0o4000) !== 0
    && (info.mode & 0o111) !== 0 && (info.mode & 0o022) === 0;
}

async function stageSandbox(scratch) {
  const directory = await mkdtemp(join(scratch, 's-'));
  try {
    const inputs = JSON.parse(await readFile(new URL('../../../../runtime/browser/runtime-lock.json', import.meta.url), 'utf8'));
    const response = await fetch(inputs.chromium.url);
    if (!response.ok || !response.body) throw new Error(`Chromium sandbox download failed: ${response.status}`);
    const archive = join(directory, 'chromium.zip');
    const output = await open(archive, 'wx', 0o600);
    const archiveHash = createHash('sha256');
    let size = 0;
    try {
      for await (const bytes of response.body) {
        size += bytes.length;
        if (size > 2 * 1024 ** 3) throw new Error('Chromium sandbox archive exceeds the runtime download bound.');
        archiveHash.update(bytes);
        await output.writeFile(bytes);
      }
    } finally { await output.close(); }
    const digest = archiveHash.digest('hex');
    if (inputs.chromium.sha256 && inputs.chromium.sha256 !== digest) throw new Error('Chromium sandbox archive checksum mismatch.');
    const { stdout: bytes } = await execute('unzip', ['-p', archive, 'chrome-linux64/chrome_sandbox'],
      { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    const source = join(directory, 'source');
    const helper = join(directory, 'sandbox');
    await writeFile(source, bytes, { mode: 0o600 });
    await execute('sudo', ['-n', 'install', '--owner=root', '--group=root', '--mode=4755', source, helper]);
    if (!usable(await lstat(helper)) || hash(await readFile(helper)) !== hash(bytes)) {
      throw new Error('The staged Chromium sandbox did not retain its verified bytes and required permissions.');
    }
    await rm(archive);
    await rm(source);
    process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
    return helper;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Configure Chromium's documented SUID sandbox without changing host policy or installed browsers. */
export async function configureBrowserSandbox() {
  const scratch = join(userInfo().homedir, '.cache', 'foreman-tmp', 'chrome');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = scratch;
  const configured = process.env.CHROME_DEVEL_SANDBOX;
  let helper = configured || '/opt/google/chrome/chrome-sandbox';
  let info;
  try { info = await lstat(helper); }
  catch (error) { if (error.code !== 'ENOENT' || configured) throw error; }
  if (!info || !usable(info)) {
    if (configured) throw new Error('The explicitly configured Chromium sandbox is not a private root-owned setuid helper.');
    helper = await stageSandbox(scratch);
  }
  process.env.CHROME_DEVEL_SANDBOX = helper;
  process.stdout.write(`Using verified Chromium sandbox helper: ${helper}\n`);
}
