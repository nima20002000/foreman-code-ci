import { lstat } from 'node:fs/promises';

/** Chromium documents this installed helper for AppArmor-restricted developer builds. */
export async function configureBrowserSandbox() {
  const configured = process.env.CHROME_DEVEL_SANDBOX;
  const helper = configured || '/opt/google/chrome/chrome-sandbox';
  let info;
  try {
    info = await lstat(helper);
  } catch (error) {
    if (error.code !== 'ENOENT' || configured) throw error;
    process.stdout.write('No installed SUID helper; Chromium must provide its kernel sandbox.\n');
    return;
  }
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o4000) === 0
    || (info.mode & 0o111) === 0 || (info.mode & 0o022) !== 0) {
    throw new Error(`The Chromium sandbox helper must be root-owned, setuid and not writable by other users: ${JSON.stringify({
      helper, uid: info.uid, mode: (info.mode & 0o7777).toString(8), file: info.isFile(), symlink: info.isSymbolicLink(),
    })}`);
  }
  process.env.CHROME_DEVEL_SANDBOX = helper;
  process.stdout.write(`Using installed Chromium sandbox helper: ${helper}\n`);
}
