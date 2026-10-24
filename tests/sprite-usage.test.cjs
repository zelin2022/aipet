'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSpriteUsage, MAX_SPRITES, MAX_USAGE_BYTES, MAX_COUNTER } = require('../src/core/sprite-usage.cjs');

const HASH_A = 'a'.repeat(64), HASH_B = 'b'.repeat(64), HASH_C = 'c'.repeat(64);
const AT = Date.parse('2026-10-24T12:00:00.000Z');
const catalog = () => [
  { id: 'custom/claude/idle.png', hash: HASH_A, character: 'claude', name: 'idle.png', states: ['idle'], eligible: true, blink: false, url: '../assets/custom/claude/idle.png' },
  { id: 'custom/claude/think.png', hash: HASH_B, character: 'claude', name: 'think.png', states: ['thinking'], eligible: true, blink: false },
  { id: 'custom/gpt/blink.png', hash: HASH_C, character: 'gpt', name: 'blink.png', states: [], eligible: true, blink: true },
  { id: 'crosspet/gpt/old.webp', hash: HASH_B, character: 'gpt', name: 'old.webp', states: [], eligible: false, blink: false },
];
const shown = id => [{ slot: 'claude', id }];

function fixture(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-sprite-usage-'));
  t.after(() => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(directory).startsWith('aipet-sprite-usage-'));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const clock = { mono: 0, wall: AT };
  const options = { directory, catalog: catalog(), now: () => clock.mono, wallNow: () => clock.wall, ...extra };
  return { directory, clock, options, usage: createSpriteUsage(options), filename: path.join(directory, 'sprite-usage.json') };
}
function row(usage, id = 'custom/claude/idle.png') { return usage.snapshot().rows.find(entry => entry.id === id); }
function saved(entries, extra = {}) {
  return { version: 1, startedAt: new Date(AT - 60000).toISOString(), savedAt: new Date(AT - 10000).toISOString(), entries, ...extra };
}
function record(id = 'custom/claude/idle.png', extra = {}) { return { id, hash: HASH_A, count: 7, visibleMs: 42000, ...extra }; }

test('catalog includes unused sprites and merges aliases without inventing prior use', async t => {
  const alias = { ...catalog()[0], states: ['coaxed'], name: 'coaxed alias' };
  const { usage, directory } = fixture(t, { catalog: [...catalog(), alias] });
  assert.equal(await usage.load(), true);
  const snapshot = usage.snapshot();
  assert.equal(snapshot.rows.length, 4);
  assert.deepEqual(snapshot.rows[0].states, ['coaxed', 'idle']);
  assert.equal(snapshot.rows[3].eligible, false);
  assert.deepEqual(snapshot.totals, { count: 0, visibleMs: 0 });
  assert.ok(snapshot.rows.every(entry => entry.count === 0 && entry.visibleMs === 0 && entry.timeShare === 0));
  assert.equal(snapshot.savedAt, null);
  snapshot.rows[0].count = 99; snapshot.rows[0].states.push('external-mutation');
  assert.equal(row(usage).count, 0);
  assert.deepEqual(row(usage).states, ['coaxed', 'idle']);
  assert.equal(await usage.flush(), true);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('counts visual transitions and exposures while heartbeats accrue time only', async t => {
  const { usage, clock } = fixture(t);
  await usage.load();
  assert.equal(usage.observe(shown('custom/claude/idle.png')), true);
  for (let second = 1; second <= 3; second++) {
    clock.mono = second * 1000;
    usage.tick();
    usage.observe(shown('custom/claude/idle.png'));
  }
  assert.deepEqual({ count: row(usage).count, visibleMs: row(usage).visibleMs }, { count: 1, visibleMs: 3000 });
  usage.observe(shown('custom/claude/think.png'));
  clock.mono += 500;
  usage.observe(shown('custom/claude/idle.png'));
  assert.equal(row(usage).count, 2);
  assert.equal(row(usage, 'custom/claude/think.png').visibleMs, 500);
  assert.equal(row(usage, 'custom/claude/think.png').count, 1);
});

test('a lost renderer report stops time at the lease and a later report begins a new exposure', async t => {
  const { usage, clock } = fixture(t);
  await usage.load(); usage.observe(shown('custom/claude/idle.png'));
  clock.mono = 1000; usage.tick();
  clock.mono = 3000; usage.tick();
  clock.mono = 60000; usage.tick();
  assert.equal(row(usage).visibleMs, 5000);
  clock.mono = 120000;
  assert.equal(row(usage).visibleMs, 5000, 'Repeated snapshots must not renew the renderer lease.');
  usage.observe(shown('custom/claude/idle.png'));
  assert.equal(row(usage).count, 2);
  clock.mono += 500; usage.pause();
  assert.equal(row(usage).visibleMs, 5500);
});

test('hide, suspend and lock pauses prevent hidden time and count the next visible exposure', async t => {
  const { usage, clock } = fixture(t);
  await usage.load(); usage.observe(shown('custom/claude/idle.png'));
  clock.mono = 400; usage.pause();
  clock.mono = 100000; usage.tick(); usage.pause();
  assert.equal(row(usage).visibleMs, 400);
  usage.observe(shown('custom/claude/idle.png'));
  clock.mono += 600; usage.observe([]);
  clock.mono += 100000;
  assert.equal(row(usage).visibleMs, 1000);
  assert.equal(row(usage).count, 2);
});

test('provider slots aggregate pet time and character shares without bias from another character', async t => {
  const { usage, clock } = fixture(t);
  await usage.load();
  usage.observe([{ slot: 'claude', id: 'custom/claude/idle.png' }, { slot: 'codex', id: 'custom/gpt/blink.png' }]);
  clock.mono = 3000;
  usage.observe([{ slot: 'claude', id: 'custom/claude/think.png' }, { slot: 'codex', id: 'custom/gpt/blink.png' }]);
  clock.mono = 4000; usage.pause();
  const snapshot = usage.snapshot();
  assert.deepEqual(snapshot.characters.claude, { count: 2, visibleMs: 4000 });
  assert.deepEqual(snapshot.characters.gpt, { count: 1, visibleMs: 4000 });
  assert.equal(row(usage).timeShare, 0.75);
  assert.equal(row(usage).globalTimeShare, 0.375);
  assert.equal(row(usage, 'custom/gpt/blink.png').timeShare, 1);
  assert.equal(snapshot.totals.visibleMs, 8000);
  usage.observe([{ slot: 'claude', id: 'crosspet/gpt/old.webp' }, { slot: 'codex', id: 'crosspet/gpt/old.webp' }]);
  clock.mono += 100; usage.pause();
  const archived = row(usage, 'crosspet/gpt/old.webp');
  assert.equal(archived.count, 2, 'A known archived asset can expose an unexpected renderer selection.');
  assert.equal(archived.visibleMs, 200, 'Two visible pets legitimately contribute two pet-seconds.');
});

test('restart restores matching content hashes, drops changed or removed assets, and adds no downtime', async t => {
  const { usage, clock, options, filename } = fixture(t);
  await usage.load(); usage.observe(shown('custom/claude/idle.png'));
  clock.mono = 1500; usage.observe(shown('custom/claude/think.png'));
  clock.mono = 1800; usage.pause();
  clock.wall += 1800; assert.equal(await usage.flush(), true);
  const disk = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.deepEqual(Object.keys(disk).sort(), ['entries', 'savedAt', 'startedAt', 'version']);
  assert.deepEqual(Object.keys(disk.entries[0]).sort(), ['count', 'hash', 'id', 'visibleMs']);
  assert.equal(JSON.stringify(disk).includes('url'), false);
  assert.equal(JSON.stringify(disk).includes('../assets'), false);
  clock.mono = 700000; clock.wall += 700000;
  const updated = catalog().filter(entry => entry.id !== 'custom/gpt/blink.png').map(entry => entry.id.endsWith('think.png') ? { ...entry, hash: HASH_C } : entry);
  const next = createSpriteUsage({ ...options, catalog: updated });
  assert.equal(await next.load(), true);
  assert.equal(await next.load(), true, 'Repeated load must not double counters.');
  assert.equal(row(next).count, 1);
  assert.equal(row(next).visibleMs, 1500);
  assert.equal(row(next, 'custom/claude/think.png').count, 0);
  assert.equal(next.snapshot().rows.length, 3);
  assert.equal(next.snapshot().startedAt, disk.startedAt);
  assert.notEqual(next.snapshot().sessionStartedAt, disk.startedAt);
  assert.equal(next.snapshot().savedAt, disk.savedAt);
});

test('reset starts a fresh period, retains one exposure per currently visible slot and persists', async t => {
  const { usage, clock, options } = fixture(t);
  await usage.load(); usage.observe(shown('custom/claude/idle.png'));
  clock.mono = 2000; clock.wall += 2000;
  const fresh = usage.reset();
  assert.deepEqual(fresh.totals, { count: 1, visibleMs: 0 });
  assert.equal(fresh.startedAt, new Date(clock.wall).toISOString());
  assert.equal(fresh.savedAt, null);
  clock.mono += 1000; usage.pause();
  assert.equal(await usage.flush(), true);
  const restarted = createSpriteUsage(options); await restarted.load();
  assert.deepEqual(restarted.snapshot().totals, { count: 1, visibleMs: 1000 });
  restarted.pause(); restarted.reset();
  assert.deepEqual(restarted.snapshot().totals, { count: 0, visibleMs: 0 });
});

test('malformed, duplicate, unknown and tampered records cannot populate counters or leak payload fields', async t => {
  const { usage, filename } = fixture(t);
  fs.writeFileSync(filename, JSON.stringify(saved([
    record(), record('custom/claude/idle.png', { count: 800 }),
    record('custom/claude/think.png', { hash: HASH_B, count: -1 }),
    record('custom/gpt/blink.png', { hash: HASH_C, prompt: 'PRIVATE-CONVERSATION' }),
    record('crosspet/gpt/old.webp', { hash: HASH_C }),
    record('../../PRIVATE-PROJECT', { count: 99 }),
  ])));
  assert.equal(await usage.load(), true);
  assert.deepEqual(usage.snapshot().totals, { count: 0, visibleMs: 0 });
  usage.observe(shown('custom/claude/idle.png')); await usage.flush();
  assert.equal(fs.readFileSync(filename, 'utf8').includes('PRIVATE'), false);
  assert.equal(row(usage).count, 1);
});

test('invalid store envelopes and corrupt JSON recover to an empty bounded local snapshot', async t => {
  const { filename, options } = fixture(t);
  for (const text of ['broken JSON', JSON.stringify({ ...saved([]), conversation: 'PRIVATE' }), JSON.stringify(saved(new Array(MAX_SPRITES + 1).fill(null))), JSON.stringify(saved([], { version: 2 }))]) {
    fs.writeFileSync(filename, text);
    const usage = createSpriteUsage(options);
    assert.equal(await usage.load(), false);
    assert.equal(usage.snapshot().storage, 'ready');
    assert.deepEqual(usage.snapshot().totals, { count: 0, visibleMs: 0 });
    assert.equal(await usage.flush(), true);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).entries.length, 4);
  }
});

test('counter saturation keeps rows and aggregate totals safe even for a maximum-sized catalog', async t => {
  const many = Array.from({ length: MAX_SPRITES }, (_, index) => ({ ...catalog()[0], id: `custom/claude/pose-${index}.png`, name: `pose-${index}.png` }));
  const { usage, filename, clock } = fixture(t, { catalog: many });
  fs.writeFileSync(filename, JSON.stringify(saved(many.map(entry => record(entry.id, { count: MAX_COUNTER, visibleMs: MAX_COUNTER })))));
  assert.equal(await usage.load(), true);
  usage.observe(shown(many[0].id)); clock.mono = 1000; usage.pause();
  const snapshot = usage.snapshot();
  assert.ok(Number.isSafeInteger(snapshot.totals.count));
  assert.ok(Number.isSafeInteger(snapshot.totals.visibleMs));
  assert.equal(snapshot.rows[0].count, MAX_COUNTER);
  assert.equal(snapshot.rows[0].visibleMs, MAX_COUNTER);
  assert.equal(await usage.flush(), true);
  assert.ok(fs.statSync(filename).size <= MAX_USAGE_BYTES);
  assert.throws(() => createSpriteUsage({ directory: path.dirname(filename), catalog: [...many, many[0]] }), /catalog/);
});

test('rejects unsafe catalog keys and sample metadata while monotonic time ignores wall-clock changes', async t => {
  const { usage, clock, options, filename } = fixture(t);
  for (const id of ['/absolute.png', '../outside.png', 'custom/../outside.png', 'C:/outside.png', 'custom\\outside.png', 'a//b.png']) {
    assert.throws(() => createSpriteUsage({ ...options, catalog: [{ ...catalog()[0], id }] }), /catalog/);
  }
  await usage.load(); usage.observe(shown('custom/claude/idle.png'));
  clock.mono = 1000; clock.wall -= 600000;
  for (const sample of [null, [{ slot: 'other', id: 'custom/claude/idle.png' }], [{ slot: 'claude', id: 'PRIVATE-PATH' }], [{ slot: 'claude', id: 'custom/claude/idle.png', prompt: 'PRIVATE' }], [shown('custom/claude/idle.png')[0], shown('custom/claude/idle.png')[0]]]) assert.equal(usage.observe(sample), false);
  assert.equal(row(usage).visibleMs, 1000);
  clock.mono = 500; usage.tick();
  assert.equal(row(usage).visibleMs, 1000, 'A backwards monotonic value may not subtract time.');
  clock.mono = 1500; usage.pause();
  assert.equal(row(usage).visibleMs, 1500);
  assert.equal(await usage.flush(), true);
  const disk = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.ok(Date.parse(disk.savedAt) >= Date.parse(disk.startedAt));
  assert.equal(JSON.stringify(disk).includes('PRIVATE'), false);
});

test('oversized and hard-linked stores fail safely without rewriting their targets', async t => {
  const { options, filename, directory } = fixture(t);
  fs.writeFileSync(filename, 'x'.repeat(MAX_USAGE_BYTES + 1));
  let usage = createSpriteUsage(options);
  assert.equal(await usage.load(), false);
  usage.observe(shown('custom/claude/idle.png'));
  assert.equal(await usage.flush(), false);
  assert.equal(usage.snapshot().storage, 'unavailable');
  assert.equal(fs.statSync(filename).size, MAX_USAGE_BYTES + 1);
  fs.unlinkSync(filename);
  const target = path.join(directory, 'sentinel'); fs.writeFileSync(target, 'preserve target');
  fs.linkSync(target, filename);
  usage = createSpriteUsage(options); assert.equal(await usage.load(), false);
  usage.observe(shown('custom/claude/idle.png')); assert.equal(await usage.flush(), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserve target');
});

test('linked directories including parent junctions are rejected and stale regular temp files recover', async t => {
  const { directory, options, usage } = fixture(t);
  const target = path.join(directory, 'target'), link = path.join(directory, 'redirect');
  fs.mkdirSync(target); fs.mkdirSync(path.join(target, 'nested'));
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const redirected of [link, path.join(link, 'nested')]) {
    const blocked = createSpriteUsage({ ...options, directory: redirected });
    assert.equal(await blocked.load(), false);
    blocked.observe(shown('custom/claude/idle.png')); assert.equal(await blocked.flush(), false);
  }
  assert.deepEqual(fs.readdirSync(path.join(target, 'nested')), []);
  const temporary = path.join(directory, '.sprite-usage.json.tmp');
  fs.writeFileSync(temporary, 'previous interrupted write');
  await usage.load(); usage.observe(shown('custom/claude/idle.png'));
  assert.equal(await usage.flush(), true);
  assert.equal(fs.existsSync(temporary), false);
  fs.symlinkSync(target, temporary, process.platform === 'win32' ? 'junction' : 'dir');
  usage.reset(); assert.equal(await usage.flush(), false);
  assert.equal(fs.lstatSync(temporary).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(target), ['nested']);
});
