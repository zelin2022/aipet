// Exercise opt-in debug recording with an isolated app, hooks and profile.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
if (process.platform !== 'win32') throw new Error('Debug smoke targets Windows.');
const targetRoot = process.argv.includes('--packaged') ? path.join(root, 'dist/Aipet-win32-x64/resources/app') : root;
const temporaryRoot = path.resolve(os.tmpdir());
const profile = await mkdtemp(path.join(temporaryRoot, 'aipet-debug-test-'));
const env = { ...process.env, USERPROFILE: profile, LOCALAPPDATA: profile, AIPET_DESKTOP_TEST: '1', AIPET_TEST_DATA: path.join(profile, '.aipet'), AIPET_SMOKE_APP_ROOT: targetRoot, AIPET_TEST_NODE: process.execPath, CLAUDE_CODE_SESSION_ID: 'synthetic-debug-test-session' };
const normalEnv = { ...env };
for (const key of ['AIPET_DESKTOP_TEST', 'AIPET_TEST_DATA', 'AIPET_SMOKE_APP_ROOT', 'ELECTRON_RUN_AS_NODE']) delete normalEnv[key];
async function run(args, childEnv, timeout = 30000) {
  const child = spawn(require('electron'), args, { cwd: root, env: childEnv, windowsHide: true, shell: false, stdio: 'inherit' });
  const timer = setTimeout(() => {
    if (child.pid && child.exitCode === null && child.signalCode === null)
      spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore', timeout: 10000 });
  }, timeout);
  try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }), 0); }
  finally { clearTimeout(timer); }
}
try {
  await mkdir(path.join(root, 'out'), { recursive: true });
  await run([path.join(root, 'tests/debug-smoke.cjs'), '--background'], env);
  const empty = path.join(profile, 'unused-home');
  const alone = { ...normalEnv, USERPROFILE: empty, LOCALAPPDATA: empty };
  const nonce = randomBytes(16).toString('hex');
  await run([targetRoot, `--aipet-debug=start:${nonce}`, `--status=${nonce}`], alone, 8000);
  await run([targetRoot, '--aipet-debug'], alone, 8000);
  const files = await readdir(path.join(empty, '.aipet')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const name of ['settings.json', 'events', 'debug-control.json', 'debug.jsonl']) assert.equal(files.includes(name), false, 'A standalone debug request must not start the app.');
  console.log('Debug smoke passed: isolated opt-in/stop/expiry, hook → inbox → main → renderer metadata, passive malformed/no-primary requests and zero owned windows after cleanup.');
} finally {
  const relative = path.relative(temporaryRoot, profile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(profile).startsWith('aipet-debug-test-')) throw new Error('Unsafe debug test cleanup target.');
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
