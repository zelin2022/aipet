'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  MAX_DEBUG_BYTES, MAX_DEBUG_RECORDS, MAX_DEBUG_DURATION_MS,
  setDebug, setDebugWindow, isDebugActive, readDebugControl, readDebug, appendDebug, workspaceScope,
} = require('../src/core/debug-log.cjs');
const nonce = '0123456789abcdef0123456789abcdef';
const nextNonce = 'fedcba9876543210fedcba9876543210';

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aipet-debug-unit-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(directory).startsWith('aipet-debug-unit-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  return directory;
}
function entry(extra = {}) { return { phase: 'main-state', provider: 'claude', state: 'reading', ...extra }; }
function assertClosed(records) {
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ['at', 'eventAt', 'phase', 'provider', 'state', 'workspace']);
    assert.ok(Number.isFinite(Date.parse(record.at)));
    assert.ok(record.workspace === null || /^[a-f0-9]{32}$/.test(record.workspace));
  }
}

test('debugging defaults off and neither disabled nor expired appends create a log', async t => {
  const directory = await temporary(t);
  assert.equal(await readDebugControl(directory), null);
  assert.deepEqual(await readDebug(directory), []);
  assert.equal(await appendDebug(directory, entry()), false);
  assert.deepEqual(await fs.readdir(directory), []);
  const started = Date.now();
  const control = await setDebug(directory, { enabled: true, nonce, durationMs: 10 }, started);
  assert.deepEqual(Object.keys(control).sort(), ['enabled', 'expiresAt', 'nonce', 'version']);
  assert.equal(control.enabled, true);
  assert.equal(Date.parse(control.expiresAt), started + 10);
  assert.equal(await appendDebug(directory, entry(), started + 11), false);
  assert.deepEqual(await readDebug(directory), []);
});

test('explicit start has a fifteen-minute maximum, stop preserves records, and a new start resets them', async t => {
  const directory = await temporary(t);
  const now = Date.now();
  const control = await setDebug(directory, { enabled: true, nonce }, now);
  assert.equal(MAX_DEBUG_DURATION_MS, 15 * 60 * 1000);
  assert.equal(Date.parse(control.expiresAt) - now, MAX_DEBUG_DURATION_MS);
  assert.equal(await appendDebug(directory, entry(), now + 1), true);
  const saved = await readDebug(directory);
  assert.equal(saved.length, 1);
  await setDebug(directory, { enabled: false, nonce: nextNonce }, now + 2);
  assert.equal((await readDebugControl(directory)).enabled, false);
  assert.equal(await appendDebug(directory, entry(), now + 3), false);
  assert.deepEqual(await readDebug(directory), saved);
  await setDebug(directory, { enabled: true, nonce }, now + 4);
  assert.deepEqual(await readDebug(directory), []);
  for (const durationMs of [0, -1, MAX_DEBUG_DURATION_MS + 1, Infinity, NaN, '100'])
    await assert.rejects(setDebug(directory, { enabled: true, nonce, durationMs }, now));
  await assert.rejects(setDebug(directory, { enabled: true, nonce: '../invalid' }, now));
});

test('debug records reject payload fields and only hook phases permit a workspace pseudonym', async t => {
  const directory = await temporary(t);
  await setDebug(directory, { enabled: true, nonce });
  for (const invalid of [
    entry({ prompt: 'PRIVATE-CONVERSATION' }), entry({ session: 'PRIVATE-SESSION' }),
    entry({ cwd: 'G:/PRIVATE-PROJECT' }), entry({ error: 'PRIVATE-STACK' }),
    entry({ provider: 'other' }), entry({ state: 'arbitrary text' }), entry({ phase: 'raw-hook-payload' }),
    entry({ workspace: 'G:/PRIVATE-PROJECT' }), entry({ workspace: 'a'.repeat(32) }), entry({ eventAt: 'PRIVATE-EVENT' }),
  ]) assert.equal(await appendDebug(directory, invalid), false);
  assert.equal(await appendDebug(directory, entry()), true);
  assert.equal(await appendDebug(directory, entry({ phase: 'hook-invoked', workspace: 'a'.repeat(32) })), true);
  const records = await readDebug(directory);
  assertClosed(records);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.workspace), [null, 'a'.repeat(32)]);
  for (const forbidden of ['PRIVATE', 'prompt', 'session', 'cwd', 'error', 'G:/']) assert.equal(JSON.stringify(records).includes(forbidden), false);
});

test('workspace correlation normalizes Windows paths without disclosing directory names', () => {
  const canonical = workspaceScope('G:\\workspace\\aipet');
  assert.match(canonical, /^[a-f0-9]{32}$/);
  assert.equal(workspaceScope('g:/WORKSPACE/aipet/.'), canonical);
  assert.equal(workspaceScope('G:\\workspace\\aipet\\'), canonical);
  assert.notEqual(workspaceScope('G:/workspace/different-project'), canonical);
  assert.equal(workspaceScope('relative-project'), null);
  assert.equal(workspaceScope(null), null);
  assert.equal(canonical.includes('aipet'), false);
});

test('decorative poses are metadata-only renderer/main records and cannot be hook or inbox events', async t => {
  const directory = await temporary(t);
  await setDebug(directory, { enabled: true, nonce });
  for (const state of ['greet', 'coaxed', 'puffed', 'hairplay', 'aloof', 'wink', 'smug', 'sip']) {
    for (const phase of ['main-state', 'renderer-state']) assert.equal(await appendDebug(directory, entry({ state, phase })), true);
    for (const phase of ['hook-invoked', 'hook-written', 'hook-write-failed', 'inbox-accepted']) assert.equal(await appendDebug(directory, entry({ state, phase })), false);
    assert.equal(await appendDebug(directory, entry({ state, prompt: 'PRIVATE-CONTENT' })), false);
  }
  const records = await readDebug(directory);
  assert.equal(records.length, 16);
  assertClosed(records);
  assert.ok(records.every(record => record.workspace === null && record.eventAt === null));
  assert.equal(JSON.stringify(records).includes('PRIVATE'), false);
});

test('record retention stays bounded and concurrent writers leave only complete metadata records', async t => {
  const directory = await temporary(t);
  const now = Date.now() - 1000;
  await setDebug(directory, { enabled: true, nonce }, now);
  const retained = Array.from({ length: MAX_DEBUG_RECORDS }, (_, index) => ({ at: new Date(now + index).toISOString(), eventAt: null, provider: 'claude', state: 'reading', phase: 'main-state', workspace: null }));
  await fs.writeFile(path.join(directory, 'debug.jsonl'), retained.map(record => JSON.stringify(record)).join('\n') + '\n');
  assert.equal(await appendDebug(directory, entry({ provider: 'codex', state: 'coding' }), now + MAX_DEBUG_RECORDS), true);
  let records = await readDebug(directory);
  assert.equal(records.length, MAX_DEBUG_RECORDS);
  assert.equal(records[0].at, retained[1].at);
  assert.equal(records.at(-1).provider, 'codex');
  const outcomes = await Promise.all(Array.from({ length: 16 }, (_, index) => appendDebug(directory, entry({ provider: index % 2 ? 'codex' : 'claude', phase: 'renderer-state' }))));
  assert.ok(outcomes.every(outcome => typeof outcome === 'boolean'));
  assert.ok(outcomes.some(Boolean));
  records = await readDebug(directory);
  assertClosed(records);
  assert.ok(records.length <= MAX_DEBUG_RECORDS);
  assert.ok((await fs.stat(path.join(directory, 'debug.jsonl'))).size <= MAX_DEBUG_BYTES);
});

test('oversized and linked debug paths fail closed without changing their targets', async t => {
  const directory = await temporary(t);
  await setDebug(directory, { enabled: true, nonce });
  const filename = path.join(directory, 'debug.jsonl');
  await fs.writeFile(filename, 'x'.repeat(MAX_DEBUG_BYTES + 1));
  assert.equal(await readDebug(directory), null);
  assert.equal(await appendDebug(directory, entry()), false);
  assert.equal((await fs.stat(filename)).size, MAX_DEBUG_BYTES + 1);
  const target = path.join(directory, 'target');
  const link = path.join(directory, 'link');
  await fs.mkdir(target);
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await readDebugControl(link), null);
  assert.equal(await appendDebug(link, entry()), false);
  await assert.rejects(setDebug(link, { enabled: true, nonce }));
  assert.deepEqual(await fs.readdir(target), []);
});

test('an unavailable debug log never rejects a hook or prevents its activity event', async t => {
  const directory = await temporary(t);
  const inbox = path.join(directory, 'events');
  await fs.mkdir(inbox);
  await setDebug(directory, { enabled: true, nonce });
  const logfile = path.join(directory, 'debug.jsonl');
  await fs.unlink(logfile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await fs.mkdir(logfile);
  const secret = 'SYNTHETIC-STDIN-RAW-SESSION-CREDENTIAL';
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../integrations/activity.mjs'), '--provider', 'claude', '--state', 'reading', '--hook', '--inbox', inbox], {
    cwd: directory, env: { ...process.env, USERPROFILE: directory, LOCALAPPDATA: directory, CLAUDE_CODE_SESSION_ID: secret }, input: secret, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '{}\n');
  assert.equal(result.stderr, '');
  const files = await fs.readdir(inbox);
  assert.equal(files.length, 1);
  const event = await fs.readFile(path.join(inbox, files[0]), 'utf8');
  assert.equal(JSON.parse(event).state, 'reading');
  assert.equal(event.includes(secret), false);
  assert.equal((await fs.stat(logfile)).isDirectory(), true);
});

test('an opted-in fixed hook logs only its invocation and write metadata with hashed workspace correlation', async t => {
  const directory = await temporary(t);
  const inbox = path.join(directory, 'events');
  await fs.mkdir(inbox);
  await setDebug(directory, { enabled: true, nonce });
  const secret = 'SYNTHETIC-RAW-SESSION-PROMPT-CREDENTIAL';
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../integrations/activity.mjs'), '--provider', 'claude', '--state', 'reading', '--hook', '--inbox', inbox], {
    cwd: directory, env: { ...process.env, USERPROFILE: directory, LOCALAPPDATA: directory, CLAUDE_CODE_SESSION_ID: secret }, input: secret, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '{}\n');
  assert.equal(result.stderr, '');
  const records = await readDebug(directory);
  assertClosed(records);
  assert.deepEqual(records.map(({ phase, provider, state, workspace }) => ({ phase, provider, state, workspace })), [
    { phase: 'hook-invoked', provider: 'claude', state: 'reading', workspace: workspaceScope(directory) },
    { phase: 'hook-written', provider: 'claude', state: 'reading', workspace: workspaceScope(directory) },
  ]);
  const files = await fs.readdir(inbox);
  const event = JSON.parse(await fs.readFile(path.join(inbox, files[0]), 'utf8'));
  assert.ok(records.every(record => record.eventAt === event.at));
  assert.equal(JSON.stringify(records).includes(secret), false);
  assert.equal(JSON.stringify(records).includes(directory), false);
});

test('an activity write failure records a fixed phase while the hook remains passive', async t => {
  const directory = await temporary(t);
  const inbox = path.join(directory, 'blocked-inbox');
  await fs.writeFile(inbox, 'owned test blocker');
  await setDebug(directory, { enabled: true, nonce });
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../integrations/activity.mjs'), '--provider', 'codex', '--state', 'tool', '--hook', '--inbox', inbox], {
    cwd: directory, input: 'PRIVATE-RAW-HOOK-PAYLOAD', encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '{}\n');
  assert.equal(result.stderr, '');
  const records = await readDebug(directory);
  assertClosed(records);
  assert.deepEqual(records.map(record => record.phase), ['hook-invoked', 'hook-write-failed']);
  assert.equal(JSON.stringify(records).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(records).includes(directory), false);
  assert.equal(await fs.readFile(inbox, 'utf8'), 'owned test blocker');
});

test('bounded stale temporary files recover while linked temporary targets remain untouched', async t => {
  const directory = await temporary(t);
  await setDebug(directory, { enabled: true, nonce });
  const temporaryFile = path.join(directory, '.debug.jsonl.tmp');
  await fs.writeFile(temporaryFile, 'owned incomplete previous write');
  assert.equal(await appendDebug(directory, entry()), true);
  assert.equal(await fs.lstat(temporaryFile).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error)), false);
  assert.equal((await readDebug(directory)).length, 1);
  const target = path.join(directory, 'temporary-target');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'sentinel'), 'leave unchanged');
  await fs.symlink(target, temporaryFile, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await appendDebug(directory, entry()), false);
  assert.equal((await fs.lstat(temporaryFile)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(path.join(target, 'sentinel'), 'utf8'), 'leave unchanged');
});

test('one scheduled twenty-minute window gates both boundaries and preserves a continuous journal', async t => {
  const directory = await temporary(t);
  const now = Date.now(), start = now + 1000, end = start + 20 * 60 * 1000;
  const control = await setDebugWindow(directory, { nonce, startsAt: new Date(start).toISOString(), expiresAt: new Date(end).toISOString() }, now);
  assert.equal(control.version, 2);
  assert.equal(control.enabled, true);
  assert.equal(isDebugActive(control, start - 1), false);
  assert.equal(isDebugActive(control, start), true);
  assert.equal(isDebugActive(control, end - 1), true);
  assert.equal(isDebugActive(control, end), false);
  for (const phase of ['hook-invoked', 'inbox-accepted', 'main-state', 'renderer-state'])
    assert.equal(await appendDebug(directory, entry({ phase }), start - 1), false);
  assert.deepEqual(await readDebug(directory), []);
  for (const time of [start + 100, start + 10 * 60 * 1000, end - 100])
    assert.equal(await appendDebug(directory, entry(), time), true, 'The complete twenty-minute window must stay active.');
  const records = await readDebug(directory);
  assert.equal(records.length, 3, 'No midpoint reset may discard earlier records.');
  assert.deepEqual(records.map(record => record.at), [start + 100, start + 10 * 60 * 1000, end - 100].map(time => new Date(time).toISOString()));
  assert.equal(await appendDebug(directory, entry(), end), false);
  assert.deepEqual(await readDebug(directory), records);
  assert.deepEqual(await readDebugControl(directory), control);
});

test('scheduled debug windows reject stale, malformed, reversed and excessive requests', async t => {
  const directory = await temporary(t);
  const now = Date.now(), iso = time => new Date(time).toISOString();
  for (const options of [
    { nonce, startsAt: iso(now - 1), expiresAt: iso(now + 1000) },
    { nonce, startsAt: iso(now + 24 * 60 * 60 * 1000 + 1), expiresAt: iso(now + 24 * 60 * 60 * 1000 + 1000) },
    { nonce, startsAt: iso(now + 1000), expiresAt: iso(now + 1000 + 30 * 60 * 1000 + 1) },
    { nonce, startsAt: iso(now + 1000), expiresAt: iso(now + 1000) },
    { nonce, startsAt: iso(now + 1000), expiresAt: iso(now + 999) },
    { nonce, startsAt: 'private arbitrary text', expiresAt: iso(now + 2000) },
    { nonce: '../invalid', startsAt: iso(now + 1000), expiresAt: iso(now + 2000) },
  ]) await assert.rejects(setDebugWindow(directory, options, now));
  assert.equal(await readDebugControl(directory), null);
  assert.deepEqual(await fs.readdir(directory), []);
});
