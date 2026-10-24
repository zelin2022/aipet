// Exercise the real portable executable without touching the normal Aipet profile.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('The direct portable launch test requires Windows.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distribution = path.join(root, 'dist', 'Aipet-win32-x64');
const deployment = JSON.parse(await readFile(path.join(distribution, 'deployment.json'), 'utf8'));
assert.equal(deployment.mode, 'electron-portable');
assert.equal(deployment.executable, 'electron.exe');
assert.deepEqual(deployment.arguments, ['--background']);
const executable = path.join(distribution, deployment.executable);
const provenance = JSON.parse(await readFile(path.join(distribution, 'runtime-provenance.json'), 'utf8'));
const executableSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
assert.equal(executableSha256, provenance.executable.sha256, 'Executable must match recorded original vendor runtime');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = await mkdtemp(path.join(temporaryRoot, 'aipet-portable-test-'));
let child;
try {
  child = spawn(executable, deployment.arguments, { cwd: distribution, windowsHide: true, env: { ...process.env, USERPROFILE: profile, LOCALAPPDATA: profile }, stdio: 'ignore', shell: false });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  await new Promise(resolve => setTimeout(resolve, 5000));
  assert.equal(child.exitCode, null, `Portable launcher exited early (${child.exitCode})`);
  assert.equal(child.signalCode, null, `Portable launcher was terminated (${child.signalCode})`);
  assert.equal((await stat(path.join(profile, '.aipet'))).isDirectory(), true, 'App must create its isolated profile');
  console.log(JSON.stringify({ test: 'direct-portable-launch', passed: true, processId: child.pid, vendorExecutableSha256: executableSha256, isolatedProfileCreated: true }));
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    // Stop only this test's child tree. Never enumerate or terminate unrelated Electron instances.
    const stopped = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false, timeout: 15000 });
    if (stopped.error) throw stopped.error;
    if (stopped.status !== 0) throw new Error('Could not stop the isolated portable test child; temporary profile retained.');
    await new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
  }
  const relative = path.relative(temporaryRoot, profile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(profile).startsWith('aipet-portable-test-')) throw new Error('Refusing unexpected temporary profile cleanup path.');
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
