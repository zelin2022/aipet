'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const targetRoot = process.env.AIPET_SMOKE_APP_ROOT || root;
const data = process.env.AIPET_TEST_DATA;
const { readDebug, readDebugControl, MAX_DEBUG_DURATION_MS, workspaceScope } = require(path.join(targetRoot, 'src/core/debug-log.cjs'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let instance;
const deadline = setTimeout(() => app.exit(1), 24000);
async function until(predicate, description, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await predicate(); if (result) return result; await sleep(40); }
  throw new Error(`Timed out: ${description}`);
}
function normalEnvironment() {
  const env = { ...process.env };
  for (const key of ['AIPET_DESKTOP_TEST', 'AIPET_TEST_DATA', 'AIPET_SMOKE_APP_ROOT', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  return env;
}
async function child(executable, args, { cwd = root, input = '' } = {}) {
  const process = spawn(executable, args, { cwd, env: normalEnvironment(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process.stdout.on('data', chunk => { stdout += chunk; });
  process.stderr.on('data', chunk => { stderr += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.end(input);
  const timer = setTimeout(() => process.kill(), 5000);
  try {
    const code = await new Promise((resolve, reject) => { process.once('error', reject); process.once('exit', resolve); });
    assert.equal(code, 0, `Owned launcher failed: ${stderr}`);
    return { stdout, stderr };
  } finally { clearTimeout(timer); }
}
async function secondary(args) { return child(process.execPath, [targetRoot, ...args]); }
async function toggle(action) {
  const nonce = randomBytes(16).toString('hex');
  await secondary([`--aipet-debug=${action}:${nonce}`, `--status=${nonce}`]);
  return until(async () => {
    const status = await fs.readFile(path.join(data, 'status.json'), 'utf8').then(JSON.parse).catch(() => null);
    const control = await readDebugControl(data);
    return status?.requestId === nonce && control?.nonce === nonce && control.enabled === (action === 'start') ? control : null;
  }, `debug ${action} acknowledgement`);
}
async function hook(provider, state) {
  // This Node hook process reads no synthetic stdin and writes only this owned inbox.
  const result = await child(process.env.AIPET_TEST_NODE, [path.join(root, 'integrations/activity.mjs'), '--provider', provider, '--state', state, '--hook', '--inbox', path.join(data, 'events')], { cwd: root, input: 'SYNTHETIC-PROMPT-CREDENTIAL-MUST-STAY-UNREAD' });
  assert.equal(result.stdout, '{}\n');
  assert.equal(result.stderr, '');
}
(async () => {
  assert.equal(process.env.AIPET_DESKTOP_TEST, '1');
  assert.ok(data && path.isAbsolute(data));
  assert.ok(process.env.AIPET_TEST_NODE);
  app.setPath('userData', data);
  assert.equal(app.requestSingleInstanceLock(), true);
  instance = await require(path.join(targetRoot, 'src/main.cjs')).ready;
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  assert.equal(await readDebugControl(data), null);
  assert.deepEqual(await readDebug(data), []);
  const initialCli = await child(process.env.AIPET_TEST_NODE, [path.join(root, 'scripts/debug.mjs'), 'status']);
  assert.deepEqual(JSON.parse(initialCli.stdout), { status: 'debug-control', enabled: false, scheduled: false, startsAt: null, expiresAt: null });
  for (const args of [ ['--aipet-debug'], ['--aipet-debug=start:invalid'], [`--aipet-debug=start:${'a'.repeat(32)}`, `--status=${'b'.repeat(32)}`] ]) await secondary(args);
  assert.equal(await readDebugControl(data), null);
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'Malformed requests do not wake a companion or studio.');
  const startedAt = Date.now();
  const control = await toggle('start');
  assert.ok(Date.parse(control.expiresAt) > startedAt);
  assert.ok(Date.parse(control.expiresAt) <= Date.now() + MAX_DEBUG_DURATION_MS);
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'Opt-in recording leaves a dormant app in the tray.');
  instance.acceptPresence({ foreground: 'unknown', running: ['claude', 'codex'], fullscreen: null });
  const pet = instance.getPet();
  pet.setOpacity(0);
  await until(() => pet.isVisible() && !pet.webContents.isLoading(), 'owned pet load');
  await hook('claude', 'reading');
  await hook('codex', 'coding');
  const records = await until(async () => {
    const records = await readDebug(data);
    const ready = ['claude', 'codex'].every(provider => ['hook-invoked', 'hook-written', 'inbox-accepted', 'main-state', 'renderer-state'].every(phase => records?.some(record => record.provider === provider && record.phase === phase && record.state === (provider === 'claude' ? 'reading' : 'coding'))));
    return ready ? records : null;
  }, 'complete independent hook, inbox, main and renderer metadata');
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ['at', 'eventAt', 'phase', 'provider', 'state', 'workspace']);
    assert.ok(record.workspace === null || record.workspace === workspaceScope(root));
    if (!record.phase.startsWith('hook-')) assert.equal(record.workspace, null);
  }
  for (const forbidden of ['SYNTHETIC', 'session', 'prompt', 'credential', 'cwd', root, data]) assert.equal(JSON.stringify(records).includes(forbidden), false);
  const readCli = await child(process.env.AIPET_TEST_NODE, [path.join(root, 'scripts/debug.mjs'), 'read']);
  const cliRecords = readCli.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(cliRecords.length >= records.length);
  assert.ok(cliRecords.every(record => Object.keys(record).sort().join(',') === 'at,eventAt,phase,provider,state,workspace'));
  await toggle('stop');
  await sleep(100);
  const stopped = await fs.readFile(path.join(data, 'debug.jsonl'), 'utf8');
  await hook('codex', 'thinking');
  await until(() => instance.snapshot().companions.find(item => item.provider === 'codex')?.state === 'thinking', 'normal activity continues after debug stop');
  await sleep(150);
  assert.equal(await fs.readFile(path.join(data, 'debug.jsonl'), 'utf8'), stopped, 'Stop preserves the log and blocks later writes.');
  await toggle('start');
  await sleep(150);
  const expiring = await readDebugControl(data);
  await fs.writeFile(path.join(data, 'debug-control.json'), JSON.stringify({ ...expiring, expiresAt: new Date(Date.now() - 1).toISOString() }) + '\n');
  await sleep(100);
  const expired = await fs.readFile(path.join(data, 'debug.jsonl'), 'utf8');
  await hook('claude', 'tool');
  await until(() => instance.snapshot().companions.find(item => item.provider === 'claude')?.state === 'tool', 'normal activity continues after expiry');
  await sleep(150);
  assert.equal(await fs.readFile(path.join(data, 'debug.jsonl'), 'utf8'), expired, 'Expired consent blocks app and hook writes.');
  await toggle('stop');
  const windowNonce = randomBytes(16).toString('hex');
  const windowStart = Date.now() + 1200, windowEnd = windowStart + 2200;
  await secondary([`--aipet-debug=window:${windowNonce}:${windowStart}:${windowEnd}`, `--status=${windowNonce}`]);
  await until(async () => (await readDebugControl(data))?.nonce === windowNonce, 'scheduled window acknowledgement');
  assert.equal((await readDebugControl(data)).version, 2);
  await hook('claude', 'reading');
  assert.ok(Date.now() < windowStart, 'Synthetic hook ran before the scheduled start.');
  assert.deepEqual(await readDebug(data), [], 'App and hook must not record before the scheduled window.');
  const scheduled = await until(async () => {
    const records = await readDebug(data);
    return records?.some(record => record.phase === 'main-state') && records.some(record => record.phase === 'renderer-state') ? records : null;
  }, 'scheduled timer activates unchanged main and renderer snapshots');
  assert.ok(scheduled.every(record => Date.parse(record.at) >= windowStart && Date.parse(record.at) < windowEnd));
  await sleep(Math.max(0, windowEnd - Date.now() + 100));
  const ended = await fs.readFile(path.join(data, 'debug.jsonl'), 'utf8');
  await hook('codex', 'tool');
  await until(() => instance.snapshot().companions.find(item => item.provider === 'codex')?.state === 'tool', 'normal activity after the scheduled end');
  await sleep(150);
  assert.equal(await fs.readFile(path.join(data, 'debug.jsonl'), 'utf8'), ended, 'Scheduled end stops both hook and app writes.');
  await toggle('stop');
  instance.hidePet();
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  await fs.writeFile(path.join(root, 'out/debug-smoke.json'), JSON.stringify({ passed: true, defaultOff: true, explicitStartStop: true, expiryBlocksWrites: true, scheduledWindowBoundaries: true, scheduledActivationTimer: true, completeProviderPipelines: true, privateClosedMetadata: true, finalOwnedWindows: 0 }, null, 2) + '\n');
  clearTimeout(deadline); app.exit(0);
})().catch(error => { console.error(error); clearTimeout(deadline); if (instance) instance.hidePet(); app.exit(1); });
