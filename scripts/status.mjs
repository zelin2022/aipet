import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dataDirectory } = require('../src/core/data.cjs');
const { readStatus } = require('../src/core/diagnostics.cjs');
const root = path.resolve(import.meta.dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = (status, reason) => process.stdout.write(JSON.stringify({ status, reason }) + '\n');

async function regular(filename, maxBytes = Infinity) {
  try {
    const stat = await lstat(filename);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes;
  } catch { return false; }
}

async function main() {
  if (process.platform !== 'win32' || process.argv.length !== 2) {
    report('unavailable', 'unsupported-request');
    return 2;
  }
  const data = dataDirectory();
  try {
    const stat = await lstat(data);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      report('unavailable', 'invalid-status-directory');
      return 2;
    }
  } catch {
    report('not-running', 'no-status-directory');
    return 2;
  }
  const portable = path.join(root, 'dist/Aipet-win32-x64/electron.exe');
  const packaged = await regular(portable);
  const target = packaged ? path.join(root, 'dist/Aipet-win32-x64/resources/app') : root;
  const mainFile = path.join(target, 'src/main.cjs');
  // Older running builds interpret unknown switches as a request to show UI.
  // Do not send this request until the chosen payload supports the status protocol.
  if (!await regular(path.join(target, 'src/core/diagnostics.cjs'), 32768)
      || !await regular(mainFile, 65536)
      || !(await readFile(mainFile, 'utf8')).includes('diagnostics.hasStatusArgument(args)')) {
    report('unavailable', 'build-has-no-status-protocol');
    return 2;
  }
  const requestId = randomBytes(16).toString('hex');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.AIPET_DESKTOP_TEST;
  delete environment.AIPET_TEST_DATA;
  delete environment.AIPET_SMOKE_APP_ROOT;
  let child;
  let launchFailed = false;
  try {
    child = spawn(packaged ? portable : require('electron'), [...(packaged ? [] : [root]), `--status=${requestId}`], {
      cwd: packaged ? path.dirname(portable) : root,
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
      env: environment,
    });
    child.on('error', () => { launchFailed = true; });
    child.unref();
  } catch {
    report('unavailable', 'launch-failed');
    return 2;
  }
  const hardDeadline = setTimeout(() => {
    child.kill();
    report('unavailable', launchFailed ? 'launch-failed' : 'no-response');
    process.exit(2);
  }, 4200);
  try {
    const until = Date.now() + 4000;
    while (Date.now() < until && !launchFailed) {
      const value = await readStatus(data, requestId);
      if (value) {
        process.stdout.write(JSON.stringify({ status: 'running', ...value }) + '\n');
        return 0;
      }
      await sleep(100);
    }
    child.kill();
    report('unavailable', launchFailed ? 'launch-failed' : 'no-response');
    return 2;
  } finally { clearTimeout(hardDeadline); }
}

process.exitCode = await main();
