import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(os.tmpdir(), 'aipet-signal-test-'));
const targetRoot = process.argv.includes('--packaged') ? path.join(root, 'dist/Aipet-win32-x64/resources/app') : root;
try {
  const child = spawn(require('electron'), [path.join(root, 'tests/signal-smoke.cjs'), '--background'], {
    cwd: root, windowsHide: true, stdio: 'inherit', env: {...process.env, USERPROFILE: data, LOCALAPPDATA: path.join(data, 'Local'), APPDATA: path.join(data, 'Roaming'), AIPET_DESKTOP_TEST: '1', AIPET_TEST_DATA: data, AIPET_SMOKE_APP_ROOT: targetRoot}
  });
  const timeout = setTimeout(() => { console.error('Signal smoke exceeded its 45-second deadline.'); child.kill(); }, 45000);
  try { process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); }); }
  finally { clearTimeout(timeout); }
} finally {
  const relative = path.relative(os.tmpdir(), data);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(data).startsWith('aipet-signal-test-')) throw new Error('Unsafe signal-test cleanup target.');
  await rm(data, {recursive: true, force: true});
}
