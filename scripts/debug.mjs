// Explicit, short-lived metadata diagnostics. Never starts the normal application.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dataDirectory } = require('../src/core/data.cjs');
const { readStatus } = require('../src/core/diagnostics.cjs');
const { readDebugControl, readDebug, isDebugActive, MAX_DEBUG_WINDOW_MS } = require('../src/core/debug-log.cjs');
const root = path.resolve(import.meta.dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = (status, reason) => process.stdout.write(JSON.stringify({ status, reason }) + '\n');

async function regular(filename, maxBytes = Infinity) {
  try { const stat = await lstat(filename); return stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes; }
  catch { return false; }
}

function controlStatus(control) {
  const now = Date.now();
  return { enabled: isDebugActive(control, now), scheduled: control?.enabled === true && Date.parse(control.startsAt) > now,
    startsAt: control?.startsAt || null,
    expiresAt: control?.expiresAt || null };
}

async function main() {
  const [action, ...extra] = process.argv.slice(2);
  if (process.platform !== 'win32' || !['start', 'stop', 'status', 'read', 'schedule'].includes(action)
    || (action === 'schedule' ? extra.length !== 2 : extra.length !== 0)) {
    report('unavailable', 'unsupported-request');
    return 2;
  }
  let startsAt, expiresAt;
  if (action === 'schedule') {
    const values = extra.map(value => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) ? Date.parse(value) : NaN);
    if (!values.every(Number.isFinite)
      || extra.some((value, index) => new Date(values[index]).toISOString() !== (value.includes('.') ? value : value.replace('Z', '.000Z')))
      || values[0] < Date.now() || values[0] > Date.now() + 86400000
      || values[1] <= values[0] || values[1] - values[0] > MAX_DEBUG_WINDOW_MS) {
      report('unavailable', 'invalid-debug-window'); return 2;
    }
    [startsAt, expiresAt] = values.map(value => new Date(value).toISOString());
  }
  const data = dataDirectory();
  try {
    const stat = await lstat(data);
    if (!stat.isDirectory() || stat.isSymbolicLink()) { report('unavailable', 'invalid-debug-directory'); return 2; }
  } catch { report('not-running', 'no-debug-directory'); return 2; }
  if (action === 'read') {
    const records = await readDebug(data);
    if (!records) { report('unavailable', 'no-valid-debug-log'); return 2; }
    for (const record of records) process.stdout.write(JSON.stringify(record) + '\n');
    return 0;
  }
  if (action === 'status') {
    process.stdout.write(JSON.stringify({ status: 'debug-control', ...controlStatus(await readDebugControl(data)) }) + '\n');
    return 0;
  }
  const portable = path.join(root, 'dist/Aipet-win32-x64/electron.exe');
  const packaged = await regular(portable);
  const target = packaged ? path.join(root, 'dist/Aipet-win32-x64/resources/app') : root;
  const mainFile = path.join(target, 'src/main.cjs');
  if (!await regular(path.join(target, 'src/core/debug-log.cjs'), 65536)
    || !await regular(mainFile, 65536)
    || !(await readFile(mainFile, 'utf8')).includes(action === 'schedule' ? 'requestDebugWindow(nonce, startsAt, expiresAt)' : 'hasDebugArgument(args)')) {
    report('unavailable', 'build-has-no-debug-protocol');
    return 2;
  }
  const nonce = randomBytes(16).toString('hex');
  const argument = action === 'schedule'
    ? `--aipet-debug=window:${nonce}:${Date.parse(startsAt)}:${Date.parse(expiresAt)}` : `--aipet-debug=${action}:${nonce}`;
  const environment = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'AIPET_DESKTOP_TEST', 'AIPET_TEST_DATA', 'AIPET_SMOKE_APP_ROOT']) delete environment[key];
  let child, launchFailed = false;
  try {
    // Pair with the old status protocol: an older primary handles that switch
    // passively instead of treating the new debug flag as a request to show UI.
    child = spawn(packaged ? portable : require('electron'), [
      ...(packaged ? [] : [root]), argument, `--status=${nonce}`,
    ], { cwd: packaged ? path.dirname(portable) : root, windowsHide: true, shell: false, stdio: 'ignore', env: environment });
    child.on('error', () => { launchFailed = true; });
    child.unref();
  } catch { report('unavailable', 'launch-failed'); return 2; }
  const hardDeadline = setTimeout(() => {
    child.kill(); report('unavailable', launchFailed ? 'launch-failed' : 'no-running-debug-primary'); process.exit(2);
  }, 5200);
  try {
    const until = Date.now() + 5000;
    while (Date.now() < until && !launchFailed) {
      const ack = await readStatus(data, nonce);
      if (ack) {
        const control = await readDebugControl(data);
        if (!control || control.nonce !== nonce || control.enabled !== (action !== 'stop')
          || (action === 'schedule' && (control.version !== 2 || control.startsAt !== startsAt || control.expiresAt !== expiresAt))) {
          report('unavailable', 'primary-has-no-debug-protocol'); return 2;
        }
        process.stdout.write(JSON.stringify({ status: 'running', ...controlStatus(control) }) + '\n');
        return 0;
      }
      await sleep(100);
    }
    child.kill(); report('unavailable', launchFailed ? 'launch-failed' : 'no-running-debug-primary'); return 2;
  } finally { clearTimeout(hardDeadline); }
}

try { process.exitCode = await main(); }
catch { report('unavailable', 'debug-operation-failed'); process.exitCode = 2; }
