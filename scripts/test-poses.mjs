import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
await mkdir(path.join(root, 'out/smoke'), { recursive: true });
const data = await mkdtemp(path.join(os.tmpdir(), 'aipet-poses-test-'));
const targetRoot = process.argv.includes('--release') ? path.join(root, 'dist/release/payload/Aipet-win32-x64/resources/app') : process.argv.includes('--packaged')
  ? path.join(root, 'dist/Aipet-win32-x64/resources/app')
  : root;
const child = spawn(require('electron'), [path.join(root, 'tests/poses-smoke.cjs'), '--background'], {
  cwd: root,
  windowsHide: true,
  env: { ...process.env, AIPET_DESKTOP_TEST: '1', AIPET_TEST_DATA: data, AIPET_SMOKE_APP_ROOT: targetRoot },
  stdio: 'inherit',
});
const timeout = setTimeout(() => {
  console.error('Pose smoke exceeded its 60-second deadline.');
  child.kill();
  process.exitCode = 1;
}, 60000);
const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', resolve);
});
clearTimeout(timeout);
process.exitCode = typeof result === 'number' ? result : 1;
