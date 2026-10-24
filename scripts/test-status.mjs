// Exercise diagnostics through an owned single-instance app and isolated profile.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('Status smoke targets Windows.');
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const targetRoot = process.argv.includes('--packaged') ? path.join(root, 'dist/Aipet-win32-x64/resources/app') : root;
const executable = require('electron');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = await mkdtemp(path.join(temporaryRoot, 'aipet-status-test-'));
const data = path.join(profile, '.aipet');
const env = { ...process.env, USERPROFILE: profile, LOCALAPPDATA: profile, AIPET_DESKTOP_TEST: '1', AIPET_TEST_DATA: data, AIPET_SMOKE_APP_ROOT: targetRoot };
const productionEnv = { ...env };
for (const key of ['AIPET_DESKTOP_TEST', 'AIPET_TEST_DATA', 'AIPET_SMOKE_APP_ROOT', 'ELECTRON_RUN_AS_NODE']) delete productionEnv[key];

async function run(args, childEnv, timeout = 30000) {
  const child = spawn(executable, args, { cwd: root, env: childEnv, windowsHide: true, shell: false, stdio: 'inherit' });
  const timer = setTimeout(() => {
    // Only this explicitly owned test child tree is eligible for termination.
    if (child.pid && child.exitCode === null && child.signalCode === null)
      spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore', timeout: 10000 });
  }, timeout);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, 'Isolated status process must complete successfully.');
  } finally { clearTimeout(timer); }
}

try {
  await mkdir(path.join(root, 'out'), { recursive: true });
  await run([path.join(root, 'tests/status-smoke.cjs'), '--background'], env);
  // With no primary, a diagnostic launcher must exit before normal app startup.
  // Use a fresh, otherwise nonexistent user profile to detect accidental boot.
  const emptyProfile = path.join(profile, 'unused-profile');
  const aloneEnv = { ...productionEnv, USERPROFILE: emptyProfile, LOCALAPPDATA: emptyProfile };
  await run([targetRoot, `--status=${randomBytes(16).toString('hex')}`], aloneEnv, 8000);
  await run([targetRoot, '--status'], aloneEnv, 8000);
  await run([targetRoot, '--status=invalid'], aloneEnv, 8000);
  const files = await readdir(path.join(emptyProfile, '.aipet')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.equal(files.includes('settings.json'), false, 'Standalone status must not persist preferences.');
  assert.equal(files.includes('events'), false, 'Standalone status must not create an activity inbox.');
  assert.equal(files.includes('status.json'), false, 'Standalone status must not fabricate an app report.');
  const report = JSON.parse(await readFile(path.join(root, 'out/status-smoke.json'), 'utf8'));
  assert.equal(report.passed, true);
  console.log(JSON.stringify({ ...report, standaloneValidAndMalformedExitWithoutBoot: true }));
} finally {
  const relative = path.relative(temporaryRoot, profile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(profile).startsWith('aipet-status-test-')) throw new Error('Unsafe status test cleanup path.');
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
