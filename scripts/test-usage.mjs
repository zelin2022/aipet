import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
await mkdir(path.join(root, 'out/smoke'), { recursive: true });
const data = await mkdtemp(path.join(os.tmpdir(), 'aipet-usage-test-'));
const targetRoot = process.argv.includes('--packaged')
  ? path.join(root, 'dist/Aipet-win32-x64/resources/app')
  : root;

async function run(phase) {
  const child = spawn(require('electron'), [path.join(root, 'tests/usage-smoke.cjs'), '--background'], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, AIPET_DESKTOP_TEST: '1', AIPET_TEST_DATA: data, AIPET_SMOKE_APP_ROOT: targetRoot, AIPET_USAGE_PHASE: phase },
    stdio: 'inherit',
  });
  const timeout = setTimeout(() => {
    console.error(`Sprite usage ${phase} smoke exceeded its 45-second deadline.`);
    child.kill();
    process.exitCode = 1;
  }, 45000);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  clearTimeout(timeout);
  return typeof result === 'number' ? result : 1;
}

process.exitCode = await run('collect');
if (!process.exitCode) process.exitCode = await run('restart');
