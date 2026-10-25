'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

function fixture(t, runtime = false) {
  fs.mkdirSync(output, { recursive: true });
  const directory = fs.mkdtempSync(path.join(output, 'bundled-bridge-test-'));
  t.after(() => {
    assert.equal(path.dirname(directory), output);
    assert.ok(path.basename(directory).startsWith('bundled-bridge-test-'));
    const resolved = fs.realpathSync(directory);
    assert.ok(resolved.startsWith(fs.realpathSync(output) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const app = path.join(directory, "app-folder \u03a9 with spaces 'quote'");
  const integrations = path.join(app, 'resources/app/integrations');
  fs.mkdirSync(integrations, { recursive: true });
  const launcher = path.join(integrations, 'activity-launch.ps1');
  fs.copyFileSync(path.join(root, 'integrations/activity-launch.ps1'), launcher);
  if (runtime) {
    // Node mode needs the pinned executable and its ICU/V8 data, not a second
    // dependency or an installed system Node. The packaged smoke covers the
    // complete vendor payload separately.
    for (const name of ['electron.exe', 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin']) fs.copyFileSync(path.join(root, 'node_modules/electron/dist', name), path.join(app, name));
    fs.copyFileSync(path.join(root, 'integrations/activity.mjs'), path.join(integrations, 'activity.mjs'));
    fs.mkdirSync(path.join(app, 'resources/app/src/core'), { recursive: true });
    for (const name of ['activity.cjs', 'debug-log.cjs']) fs.copyFileSync(path.join(root, 'src/core', name), path.join(app, 'resources/app/src/core', name));
  }
  const profile = path.join(directory, 'isolated-user'); fs.mkdirSync(profile);
  const inbox = path.join(profile, '.aipet/events');
  function run(provider, state, extra = []) {
    const before = Date.now();
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Provider', provider, '-State', state, ...extra], {
      env: { ...process.env, USERPROFILE: profile, LOCALAPPDATA: path.join(profile, 'Local'), APPDATA: path.join(profile, 'Roaming'), ELECTRON_RUN_AS_NODE: 'parent-value-must-not-be-used' },
      cwd: directory, windowsHide: true, input: 'SYNTHETIC-HOST-PAYLOAD-MUST-NOT-BE-READ', encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(result.stdout, '{}\n');
    assert.equal(result.stderr, '');
    return Date.now() - before;
  }
  return { directory, app, integrations, profile, inbox, run };
}

test('bundled activity launcher fails passively for invalid arguments or missing runtime', { skip: process.platform !== 'win32' }, t => {
  const { inbox, run } = fixture(t);
  run('other', 'thinking');
  run('codex', 'not-a-state');
  run('codex', 'thinking', ['-Unexpected', 'ignored']);
  run('codex', 'thinking');
  assert.equal(fs.existsSync(inbox), false);
});

test('bundled activity launcher uses its relocated vendor Node, emits only metadata and bounds child lifetime', { skip: process.platform !== 'win32', timeout: 30000 }, t => {
  const { integrations, inbox, run } = fixture(t, true);
  run('codex', 'thinking');
  run('claude', 'tool');
  const files = fs.readdirSync(inbox);
  assert.equal(files.length, 2);
  for (const file of files) {
    const event = JSON.parse(fs.readFileSync(path.join(inbox, file), 'utf8'));
    assert.deepEqual(Object.keys(event), ['version', 'provider', 'state', 'session', 'at']);
    assert.ok(['claude', 'codex'].includes(event.provider));
    assert.equal(event.state, event.provider === 'codex' ? 'thinking' : 'tool');
    assert.match(event.session, /^[a-f0-9]{32}$/);
    assert.ok(!JSON.stringify(event).includes('SYNTHETIC'));
  }
  const before = files.map(file => fs.readFileSync(path.join(inbox, file), 'utf8'));
  // Only this test's copied bridge is replaced; a hung own child must be killed
  // without trapping the AI host or leaking its stdout/stderr.
  fs.writeFileSync(path.join(integrations, 'activity.mjs'), 'process.stdout.write("SYNTHETIC-OUTPUT");process.stderr.write("SYNTHETIC-ERROR");setInterval(()=>{},1000);\n');
  const elapsed = run('codex', 'coding');
  assert.ok(elapsed < 3500, `Launcher exceeded the bounded hook budget: ${elapsed}ms`);
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(inbox, file), 'utf8')), before);
});
