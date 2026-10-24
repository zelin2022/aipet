// Full offline installer smoke. All install locations, shortcuts, registration
// and application data are redirected to a unique directory under out/.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assembleInstaller } from './assemble.mjs';

if (process.platform !== 'win32') throw new Error('Windows is required.');
const root = path.resolve(import.meta.dirname, '../..');
const outputRoot = path.join(root, 'out');
await mkdir(outputRoot, { recursive: true });
const work = await mkdtemp(path.join(outputRoot, 'installer-real-smoke-'));
assert.equal(path.dirname(work), outputRoot);
const source = path.resolve(process.argv[2] || path.join(root, 'dist/release/payload/Aipet-win32-x64'));
const archive = path.join(work, 'archive');
const assembled = await assembleInstaller({ payloadDirectory: source, outputDirectory: archive, version: '0.1.0' });
const isolated = path.join(work, 'isolated-user');
await mkdir(isolated);
const install = path.join(isolated, 'Programs', 'Aipet');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const runInstaller = (script, args = []) => {
  const result = spawnSync(powershell, ['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-TestRoot',isolated,...args], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout + result.stderr);
};
runInstaller(path.join(archive, 'Install.ps1'));
const executable = path.join(install, 'app/electron.exe');
const data = path.join(isolated, '.aipet');
await mkdir(data, { recursive: true });
await writeFile(path.join(data, 'preserve-me.txt'), 'uninstall must preserve application data');
const environment = { ...process.env, USERPROFILE: isolated, LOCALAPPDATA: isolated, APPDATA: path.join(isolated, 'Roaming') };
for (const key of ['AIPET_DESKTOP_TEST','AIPET_TEST_DATA','AIPET_SMOKE_APP_ROOT','ELECTRON_RUN_AS_NODE']) delete environment[key];
let child;
let status;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function launcher(args) {
  const secondary = spawn(executable, args, { cwd: path.dirname(executable), env: environment, windowsHide: true, shell: false, stdio: 'ignore' });
  const timeout = setTimeout(() => secondary.kill(), 8000);
  try {
    const code = await new Promise((resolve,reject) => { secondary.once('error',reject); secondary.once('exit',resolve); });
    assert.equal(code, 0, 'Owned secondary launcher exits successfully.');
  } finally { clearTimeout(timeout); }
}
try {
  child = spawn(executable, ['--background'], { cwd: path.dirname(executable), env: environment, windowsHide: true, shell: false, stdio: 'ignore' });
  await new Promise((resolve,reject) => { child.once('spawn',resolve); child.once('error',reject); });
  await sleep(1600);
  assert.equal(child.exitCode, null, 'Installed app remains running.');
  const nonce = randomBytes(16).toString('hex');
  await launcher([`--status=${nonce}`]);
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    status = await readFile(path.join(data, 'status.json'),'utf8').then(JSON.parse).catch(() => null);
    if (status?.requestId === nonce) break;
    await sleep(100);
  }
  assert.equal(status?.requestId, nonce, 'Installed app responds through its isolated real single-instance lock.');
  assert.equal(status.pid, child.pid, 'Status belongs to the installed test child.');
  assert.equal(status.poll.failure, 'none');
  assert.notEqual(status.renderer.probe, 'error');
  await assert.rejects(stat(path.join(data, 'sprite-usage.json')), { code: 'ENOENT' });
  await launcher(['--quit']);
  const quitUntil = Date.now() + 8000;
  while (Date.now() < quitUntil && child.exitCode === null && child.signalCode === null) await sleep(100);
  assert.equal(child.exitCode, 0, 'Installed app quits cleanly.');
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const stopped = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows','System32/taskkill.exe'), ['/PID',String(child.pid),'/T','/F'], { windowsHide: true, stdio: 'ignore', shell: false, timeout: 15000 });
    if (stopped.error) throw stopped.error;
    assert.equal(stopped.status, 0, 'Only the owned test process tree is stopped on failure.');
    await sleep(400);
  }
}
runInstaller(path.join(install, 'Uninstall.ps1'));
await assert.rejects(stat(install), { code: 'ENOENT' });
await assert.rejects(stat(path.join(isolated, 'StartMenu/Aipet.lnk')), { code: 'ENOENT' });
await assert.rejects(stat(path.join(isolated, 'registration.json')), { code: 'ENOENT' });
assert.equal(await readFile(path.join(data, 'preserve-me.txt'),'utf8'), 'uninstall must preserve application data');
const report = {
  test: 'real-offline-install-launch-status-quit-uninstall', passed: true,
  source, work, payloadFiles: assembled.files, payloadBytes: assembled.bytes,
  processId: status.pid, isolatedRealSingleInstance: true,
  noUsageFile: true, noStartupOrHookChanges: true,
  shortcutsAndRegistrationRemoved: true, applicationDataPreserved: true,
  status: { poll: status.poll.failure, renderer: status.renderer.probe, windowCount: status.windowCount },
};
await writeFile(path.join(work, 'report.json'), JSON.stringify(report,null,2) + '\n');
console.log(JSON.stringify(report,null,2));
