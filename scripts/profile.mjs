import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The runtime profile targets Windows x64.');
await mkdir(path.join(root, 'out'), { recursive: true });
const data = await mkdtemp(path.join(os.tmpdir(), 'aipet-profile-'));
let child;
try {
  child = spawn(require('electron'), [path.join(root, 'tests/runtime-profile.cjs'), '--background'], {
    cwd: root, windowsHide: true, stdio: 'inherit',
    env: { ...process.env, USERPROFILE: data, LOCALAPPDATA: path.join(data, 'Local'), APPDATA: path.join(data, 'Roaming'), AIPET_DESKTOP_TEST: '1', AIPET_TEST_DATA: data },
  });
  const deadline = setTimeout(() => { console.error('Runtime profile exceeded its 150-second deadline.'); child.kill(); }, 150000);
  try { process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(typeof code === 'number' ? code : 1)); }); }
  finally { clearTimeout(deadline); }
} finally {
  // Only the exact newly created profile directory can be recursively removed.
  const relative = path.relative(os.tmpdir(), data);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(data).startsWith('aipet-profile-')) throw new Error('Unsafe profile cleanup target.');
  await rm(data, { recursive: true, force: true });
}
