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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let instance;
const deadline = setTimeout(() => app.exit(1), 24000);

async function until(predicate, description, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await sleep(40); }
  throw new Error(`Timed out: ${description}`);
}

async function secondary(args) {
  const env = { ...process.env };
  for (const key of ['AIPET_DESKTOP_TEST', 'AIPET_TEST_DATA', 'AIPET_SMOKE_APP_ROOT', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  const child = spawn(process.execPath, [targetRoot, ...args], { cwd: root, env, windowsHide: true, shell: false, stdio: 'ignore' });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, 'Status launcher exits normally.');
  } finally { clearTimeout(timer); }
}

async function request() {
  const nonce = randomBytes(16).toString('hex');
  await secondary([`--status=${nonce}`]);
  const value = await until(async () => {
    const report = await fs.readFile(path.join(data, 'status.json'), 'utf8').then(JSON.parse).catch(() => null);
    return report?.requestId === nonce ? report : null;
  }, 'matching on-demand status response');
  assert.equal(value.pid, process.pid, 'Report belongs to the owned primary.');
  assert.deepEqual(Object.keys(value).sort(), ['at', 'companions', 'pid', 'poll', 'providers', 'renderer', 'requestId', 'version', 'visibility', 'windowCount']);
  assert.equal(value.version, 1);
  assert.ok(Number.isFinite(Date.parse(value.at)));
  for (const provider of value.providers) assert.deepEqual(Object.keys(provider).sort(), ['lastEventAt', 'provider', 'state']);
  for (const companion of value.companions) assert.deepEqual(Object.keys(companion).sort(), ['character', 'provider', 'state']);
  for (const companion of value.renderer.companions) assert.deepEqual(Object.keys(companion).sort(), ['provider', 'state']);
  const serialized = JSON.stringify(value);
  for (const forbidden of ['session', 'prompt', 'transcript', 'credential', 'commandLine', 'windowTitle', 'd'.repeat(32), 'e'.repeat(32), data]) assert.equal(serialized.includes(forbidden), false, `Diagnostics must not disclose ${forbidden}.`);
  return value;
}

(async () => {
  assert.equal(process.env.AIPET_DESKTOP_TEST, '1');
  assert.ok(data && path.isAbsolute(data));
  assert.ok(process.argv.includes('--background'));
  // TEST normally bypasses the app lock; acquire an isolated real lock here so
  // production-style secondary launchers exercise the actual message handler.
  app.setPath('userData', data);
  assert.equal(app.requestSingleInstanceLock(), true);
  instance = await require(path.join(targetRoot, 'src/main.cjs')).ready;
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  const dormant = await request();
  assert.equal(dormant.windowCount, 0);
  assert.equal(dormant.renderer.exists, false);
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'Dormant status query creates no windows.');
  assert.equal(instance.getStudio(), undefined);

  instance.updateSettings({ showBoth: true, followActivity: true, reducedMotion: true });
  instance.acceptPresence({ foreground: 'unknown', running: ['claude', 'codex'], fullscreen: null });
  const pet = instance.getPet();
  pet.setOpacity(0);
  await until(() => pet.isVisible() && !pet.webContents.isLoading(), 'owned pet renderer');
  const at = Date.now();
  const sessions = { claude: 'd'.repeat(32), codex: 'e'.repeat(32) };
  for (const [provider, state] of [['claude', 'reading'], ['codex', 'coding']]) {
    await fs.writeFile(path.join(data, 'events', `${provider}-${sessions[provider]}.json`), JSON.stringify({ version: 1, provider, state, session: sessions[provider], at: new Date(at).toISOString() }));
  }
  await instance.pollEvents();
  await until(() => pet.webContents.executeJavaScript("[...document.querySelectorAll('.companion-slot:not([hidden])')].map(slot=>slot.dataset.state).join(',')==='reading,coding'"), 'two distinct rendered activity states');
  const active = await request();
  assert.equal(active.windowCount, 1);
  assert.deepEqual(active.companions, [{ provider: 'claude', character: 'claude', state: 'reading' }, { provider: 'codex', character: 'gpt', state: 'coding' }]);
  assert.equal(active.renderer.probe, 'ok');
  assert.deepEqual(active.renderer.companions, [{ provider: 'claude', state: 'reading' }, { provider: 'codex', state: 'coding' }]);
  assert.deepEqual(active.providers.map(({ provider, state }) => ({ provider, state })), [{ provider: 'claude', state: 'reading' }, { provider: 'codex', state: 'coding' }]);
  assert.ok(active.poll.lastFinishedAt && Number.isFinite(Date.parse(active.poll.lastFinishedAt)));
  assert.equal(instance.getStudio(), undefined);
  const before = await fs.readFile(path.join(data, 'status.json'), 'utf8');
  await secondary(['--status']);
  await secondary(['--status=../../unexpected']);
  await secondary([`--status=${'a'.repeat(32)}`, `--status=${'b'.repeat(32)}`]);
  await sleep(100);
  assert.equal(await fs.readFile(path.join(data, 'status.json'), 'utf8'), before, 'Malformed status arguments do not write a report.');
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'Malformed requests do not open a studio or another pet.');
  assert.equal(instance.getStudio(), undefined);
  // Fail one normal scheduled poll, then verify a later scheduled poll accepts
  // fresh metadata. No manual tick or direct ingestion can make this pass.
  const { InboxReader } = require(path.join(targetRoot, 'src/core/inbox.cjs'));
  const originalPoll = InboxReader.prototype.poll;
  let injected = false;
  try {
    InboxReader.prototype.poll = function (...args) {
      InboxReader.prototype.poll = originalPoll;
      injected = true;
      return Promise.reject(new Error('private simulated failure'));
    };
    await until(() => injected && instance.getPollHealth().failure === 'poll-error', 'one scheduled poll failure');
    assert.ok(Number.isFinite(Date.parse(instance.getPollHealth().lastFinishedAt)));
    await fs.writeFile(path.join(data, 'events', `codex-${sessions.codex}.json`), JSON.stringify({ version: 1, provider: 'codex', state: 'tool', session: sessions.codex, at: new Date(Math.max(at + 1, Date.now())).toISOString() }));
    await until(() => instance.getPollHealth().failure === 'none' && instance.snapshot().companions.find(item => item.provider === 'codex')?.state === 'tool', 'automatic scheduled recovery and fresh activity acceptance');
    const recovered = await request();
    assert.equal(recovered.poll.failure, 'none');
    assert.equal(recovered.renderer.companions.find(item => item.provider === 'codex')?.state, 'tool');
    assert.equal(JSON.stringify(recovered).includes('private simulated failure'), false);
  } finally { InboxReader.prototype.poll = originalPoll; }
  instance.hidePet();
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  const report = { test: 'isolated-status-second-instance', passed: true, dormantZeroWindowRequest: true, independentMainAndRendererStates: true, malformedRequestsPassive: true, scheduledPollRecovery: true, finalOwnedWindows: 0 };
  await fs.writeFile(path.join(root, 'out/status-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  clearTimeout(deadline);
  app.exit(0);
})().catch(error => { console.error(error); clearTimeout(deadline); if (instance) instance.hidePet(); app.exit(1); });
