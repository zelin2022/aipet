// Exercise real launcher/primary lifetimes without TEST controls or the user's profile.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

if (process.platform !== 'win32') throw new Error('The single-instance launch test requires Windows.');
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const packaged = process.argv.includes('--packaged');
const distribution = path.join(root, 'dist', 'Aipet-win32-x64');
if (packaged) {
  const deployment = JSON.parse(await readFile(path.join(distribution, 'deployment.json'), 'utf8'));
  assert.equal(deployment.mode, 'electron-portable');
  assert.equal(deployment.executable, 'electron.exe');
}
const executable = packaged ? path.join(distribution, 'electron.exe') : require('electron');
const appArguments = packaged ? [] : [root];
const temporaryRoot = path.resolve(os.tmpdir());
const profile = await mkdtemp(path.join(temporaryRoot, 'aipet-single-instance-'));
const data = path.join(profile, '.aipet');
const settingsFile = path.join(data, 'settings.json');
const env = { ...process.env, USERPROFILE: profile, LOCALAPPDATA: profile };
// This must exercise the production single-instance branches rather than the TEST bypass.
for (const key of ['AIPET_DESKTOP_TEST', 'AIPET_TEST_DATA', 'AIPET_SMOKE_APP_ROOT', 'ELECTRON_RUN_AS_NODE']) delete env[key];
const launched = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let report;

function launch(args, label) {
  const started = performance.now();
  const child = spawn(executable, [...appArguments, ...args], {
    cwd: profile, env, windowsHide: true, shell: false, stdio: 'ignore',
  });
  // Install observers immediately so a fast pre-ready exit cannot be missed.
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, elapsedMs: Math.round(performance.now() - started) }));
  });
  // Keep a rejection handled even if another assertion fails before awaiting this child.
  exited.catch(() => {});
  const value = { child, exited, label };
  launched.push(value);
  return value;
}

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

function alive(value) {
  return value.child.pid !== undefined && value.child.exitCode === null && value.child.signalCode === null;
}

async function expectExit(value) {
  const result = await within(value.exited, 5000, `${value.label} remained alive beyond its five-second exit deadline`);
  assert.equal(result.code, 0, `${value.label} must exit successfully`);
  assert.equal(result.signal, null, `${value.label} must exit without termination`);
  return result;
}

try {
  await mkdir(data, { recursive: true });
  await writeFile(settingsFile, JSON.stringify({ foregroundEnabled: false, autoDormant: true, followActivity: false, position: null }));
  const primary = launch(['--background'], 'primary');
  // The primary's normal boot persists a position only after Electron is ready.
  await within((async () => {
    while (alive(primary)) {
      const stored = await readFile(settingsFile, 'utf8').then(JSON.parse).catch(() => null);
      if (Number.isSafeInteger(stored?.position?.x) && Number.isSafeInteger(stored?.position?.y)) return;
      await delay(50);
    }
    throw new Error('Primary exited before completing normal startup');
  })(), 10000, 'Primary did not complete normal startup');
  assert.equal(alive(primary), true, 'The isolated primary must remain alive');

  const duplicate = launch(['--background'], 'duplicate --background');
  const duplicateResult = await expectExit(duplicate);
  assert.equal(alive(primary), true, 'A duplicate background launch must preserve the primary');

  const quit = launch(['--quit'], 'secondary --quit');
  const [quitResult, primaryResult] = await Promise.all([expectExit(quit), expectExit(primary)]);
  assert.equal(alive(quit), false, 'The secondary quit launcher must not remain orphaned');
  assert.equal(alive(primary), false, 'The primary must handle the quit message');

  // Also exercise the other early exit branch: --quit with no existing primary.
  const standaloneQuit = launch(['--quit'], 'standalone --quit');
  const standaloneQuitResult = await expectExit(standaloneQuit);
  assert.ok(launched.every(value => !alive(value)), 'No test launcher may remain alive');
  report = {
    test: 'real-single-instance-lifecycle', passed: true, packaged, testControls: false,
    duplicateExitMs: duplicateResult.elapsedMs,
    secondaryQuitExitMs: quitResult.elapsedMs,
    primaryExitAfterSecondaryQuit: primaryResult.code === 0,
    standaloneQuitExitMs: standaloneQuitResult.elapsedMs,
    trackedProcessesExited: launched.length,
  };
} finally {
  for (const value of launched) {
    if (!alive(value)) continue;
    // Only child trees created by this test are eligible for forced cleanup.
    const stopped = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(value.child.pid), '/T', '/F'], {
      windowsHide: true, shell: false, stdio: 'ignore', timeout: 10000,
    });
    if (stopped.error) throw stopped.error;
    if (stopped.status !== 0 && alive(value)) throw new Error(`Could not stop this test's ${value.label}; isolated profile retained`);
    await within(value.exited, 5000, `Could not observe cleanup of this test's ${value.label}`);
  }
  const relative = path.relative(temporaryRoot, profile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(profile).startsWith('aipet-single-instance-')) throw new Error('Refusing unexpected temporary profile cleanup path');
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
console.log(JSON.stringify({ ...report, isolatedProfileRemoved: true }));
