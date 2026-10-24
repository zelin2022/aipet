'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  MAX_STATUS_BYTES, hasStatusArgument, requestIdFromArguments,
  validateStatus, collectDiagnostics, writeStatus, readStatus,
} = require('../src/core/diagnostics.cjs');

const requestId = '0123456789abcdef0123456789abcdef';
const at = '2026-10-23T17:00:00.000Z';
function input(pet = null) {
  return {
    requestId, pid: 1234, now: Date.parse(at),
    pollHealth: { lastStartedAt: at, lastFinishedAt: at, accepted: { claude: 3, codex: 4 }, failure: 'none' },
    providerEvents: [{ provider: 'claude', state: 'reading', at }, { provider: 'codex', state: 'coding', at }],
    companions: [{ provider: 'claude', character: 'claude', state: 'reading' }, { provider: 'codex', character: 'gpt', state: 'coding' }],
    pet,
    visibility: { show: true, reason: 'ai-present', mode: 'auto', providers: ['claude', 'codex'] },
    windowCount: pet ? 1 : 0,
  };
}
function renderer(result) {
  return { isDestroyed: () => false, webContents: { isDestroyed: () => false, isLoading: () => false, isCrashed: () => false, executeJavaScript: async () => result } };
}
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aipet-diagnostics-unit-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(directory).startsWith('aipet-diagnostics-unit-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('status arguments require one exact nonce and malformed diagnostic flags remain identifiable', () => {
  assert.equal(requestIdFromArguments(['app', `--status=${requestId}`]), requestId);
  assert.equal(hasStatusArgument(['app']), false);
  for (const args of [
    ['--status'], ['--status='], ['--status=../other'], [`--status=${requestId.toUpperCase()}`],
    [`--status=${requestId}`, `--status=${requestId}`], [`--status=${requestId}`, '--status'],
  ]) {
    assert.equal(hasStatusArgument(args), true);
    assert.equal(requestIdFromArguments(args), null);
  }
});

test('diagnostics reconstruct metadata and report independent owned main and renderer states', async () => {
  const value = input(renderer([{ provider: 'claude', state: 'reading' }, { provider: 'codex', state: 'coding' }]));
  value.pollHealth.rawError = 'private stack';
  value.providerEvents.forEach(item => { item.session = 'private session'; item.prompt = 'private prompt'; });
  value.companions.forEach(item => { item.session = 'private session'; });
  value.visibility.windowTitle = 'private title';
  const report = await collectDiagnostics(value);
  assert.equal(validateStatus(report, requestId), true);
  assert.equal(report.renderer.probe, 'ok');
  assert.deepEqual(report.renderer.companions, [{ provider: 'claude', state: 'reading' }, { provider: 'codex', state: 'coding' }]);
  assert.deepEqual(report.companions.map(({ provider, state }) => ({ provider, state })), report.renderer.companions);
  for (const text of ['private', 'session', 'prompt', 'windowTitle', 'rawError']) assert.equal(JSON.stringify(report).includes(text), false);
  assert.equal(validateStatus({ ...report, prompt: 'unexpected' }), false);
  assert.equal(validateStatus({ ...report, requestId: 'x'.repeat(32) }), false);
  assert.equal(validateStatus({ ...report, providers: [{ provider: 'claude', lastEventAt: at, state: 'reading' }] }), false);
});

test('untrusted renderer results cannot add fields, unsupported states or duplicate providers', async () => {
  for (const result of [
    [{ provider: 'claude', state: 'reading', session: 'private' }],
    [{ provider: 'claude', state: 'unsupported' }],
    [{ provider: 'claude', state: 'reading' }, { provider: 'claude', state: 'coding' }],
    [{ provider: 'other', state: 'idle' }],
  ]) {
    const report = await collectDiagnostics(input(renderer(result)));
    assert.equal(report.renderer.probe, 'failed');
    assert.deepEqual(report.renderer.companions, []);
    assert.equal(validateStatus(report), true);
  }
  const absent = await collectDiagnostics(input());
  assert.equal(absent.renderer.probe, 'absent');
  assert.equal(absent.renderer.exists, false);
});

test('decorative poses remain visible in diagnostics without becoming provider activity or exposing content', async () => {
  const { validateEvent } = require('../src/core/activity.cjs');
  for (const state of ['greet', 'coaxed', 'puffed', 'hairplay', 'aloof', 'wink', 'smug', 'sip']) {
    const value = input(renderer([{ provider: 'claude', state }]));
    value.companions = [{ provider: 'claude', character: 'claude', state, prompt: 'PRIVATE-CONTENT' }];
    value.providerEvents = [{ provider: 'claude', state, at, prompt: 'PRIVATE-CONTENT' }];
    const report = await collectDiagnostics(value);
    assert.equal(validateStatus(report), true);
    assert.equal(report.renderer.probe, 'ok');
    assert.deepEqual(report.renderer.companions, [{ provider: 'claude', state }]);
    assert.deepEqual(report.companions, [{ provider: 'claude', character: 'claude', state }]);
    assert.equal(report.providers[0].state, 'idle');
    assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
    assert.equal(validateStatus({ ...report, providers: [{ provider: 'claude', state, lastEventAt: at }, report.providers[1]] }), false);
    assert.equal(validateEvent({ version: 1, provider: 'claude', session: 'a'.repeat(16), state, at }, Date.parse(at)), null);
  }
});

test('a nonresponding owned renderer has a bounded probe timeout', async () => {
  const pet = renderer([]);
  pet.webContents.executeJavaScript = () => new Promise(() => {});
  const started = Date.now();
  const report = await collectDiagnostics(input(pet));
  assert.equal(report.renderer.probe, 'timeout');
  assert.deepEqual(report.renderer.companions, []);
  assert.ok(Date.now() - started < 2500, 'Diagnostic renderer probe must not wait indefinitely.');
});

test('bounded status files roundtrip only for their matching request and reject oversized destinations', async t => {
  const directory = await temporary(t);
  const report = await collectDiagnostics(input());
  await writeStatus(directory, report);
  assert.deepEqual(await readStatus(directory, requestId), report);
  assert.equal(await readStatus(directory, 'f'.repeat(32)), null);
  const destination = path.join(directory, 'status.json');
  await fs.writeFile(destination, 'x'.repeat(MAX_STATUS_BYTES + 1));
  assert.equal(await readStatus(directory, requestId), null);
  await assert.rejects(writeStatus(directory, report));
  assert.equal((await fs.stat(destination)).size, MAX_STATUS_BYTES + 1);
  await fs.unlink(destination);
  await assert.rejects(writeStatus(directory, { ...report, content: 'private' }));
  assert.equal(await readStatus(directory, requestId), null);
});

test('status reads and writes reject a linked directory and leave its target untouched', async t => {
  const directory = await temporary(t);
  const target = path.join(directory, 'target');
  const link = path.join(directory, 'link');
  await fs.mkdir(target);
  const report = await collectDiagnostics(input());
  await writeStatus(target, report);
  const before = await fs.readFile(path.join(target, 'status.json'), 'utf8');
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await readStatus(link, requestId), null);
  await assert.rejects(writeStatus(link, report));
  assert.equal(await fs.readFile(path.join(target, 'status.json'), 'utf8'), before);
});

test('a reserved temporary file or nonregular destination cannot be overwritten or removed', async t => {
  const directory = await temporary(t);
  const report = await collectDiagnostics(input());
  const reserved = path.join(directory, `.status-${requestId}.tmp`);
  await fs.writeFile(reserved, 'existing independent request');
  await assert.rejects(writeStatus(directory, report));
  assert.equal(await fs.readFile(reserved, 'utf8'), 'existing independent request');
  assert.equal(await readStatus(directory, requestId), null);
  await fs.unlink(reserved);
  await fs.mkdir(path.join(directory, 'status.json'));
  await assert.rejects(writeStatus(directory, report));
  assert.equal((await fs.stat(path.join(directory, 'status.json'))).isDirectory(), true);
});
