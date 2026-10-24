'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { InboxReader, readBounded, MAX_FILE_BYTES } = require('../src/core/inbox.cjs');
const { Activity, EVENT_TTL } = require('../src/core/activity.cjs');

const now = Date.now();
function event(id, age = 0, extra = {}) {
  return { version: 1, provider: 'claude', state: 'thinking', session: id.toString(16).padStart(32, '0'), at: new Date(now - age).toISOString(), ...extra };
}
function filename(value) { return `${value.provider}-${value.session}.json`; }
async function put(directory, value, name = filename(value)) {
  await fs.writeFile(path.join(directory, name), JSON.stringify(value));
}
async function fixture(fn) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'aipet-inbox-'));
  try { await fn(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('reader forwards only canonical metadata and ignores arbitrary files, extra fields and symlinks', async t => {
  await fixture(async directory => {
    await put(directory, event(1));
    await put(directory, event(2, 0, { prompt: 'SECRET-CONTENT' }));
    await put(directory, event(3), 'unrelated.json');
    await put(directory, event(4), filename(event(5)));
    await fs.writeFile(path.join(directory, filename(event(6))), 's'.repeat(2048));
    await fs.mkdir(path.join(directory, filename(event(7))));
    try { await fs.symlink(path.join(directory, filename(event(1))), path.join(directory, filename(event(8)))); }
    catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; t.diagnostic('Symlink creation is unavailable; ordinary-file and canonical-name checks exercised.'); }
    const seen = [];
    const reader = new InboxReader(directory);
    const result = await reader.poll(value => { seen.push(value); return true; }, now);
    assert.equal(result.accepted, 1);
    assert.deepEqual(seen, [event(1)]);
    assert.ok(!JSON.stringify(seen).includes('SECRET-CONTENT'));
    assert.ok((await fs.readdir(directory)).includes('unrelated.json'));
  });
});

test('expired files do not starve newest sessions after more than 128 historical sessions', async () => {
  await fixture(async directory => {
    for (let id = 1; id <= 140; id++) await put(directory, event(id, EVENT_TTL + 1));
    const latest = event(1000);
    await put(directory, latest);
    const activity = new Activity();
    const reader = new InboxReader(directory);
    const result = await reader.poll((value, at) => activity.ingest(value, at), now);
    assert.equal(result.pruned, 140);
    assert.equal(result.accepted, 1);
    assert.deepEqual(await fs.readdir(directory), [filename(latest)]);
    assert.equal([...activity.sessions.values()][0].session, latest.session);
    assert.equal((await reader.poll((value, at) => activity.ingest(value, at), now)).accepted, 0);
  });
});

test('retention chooses newest event timestamps, bounds the cache and prunes only valid own files', async () => {
  await fixture(async directory => {
    for (let id = 1; id <= 8; id++) await put(directory, event(id, (8 - id) * 1000));
    await put(directory, event(9, 0, { content: 'not-our-event' }));
    const reader = new InboxReader(directory, { maxFiles: 3 });
    const seen = [];
    const result = await reader.poll(value => { seen.push(value.session); return true; }, now);
    assert.equal(result.pruned, 5);
    assert.deepEqual(seen, [event(6).session, event(7).session, event(8).session]);
    assert.equal(reader.cache.size, 3);
    assert.equal((await fs.readdir(directory)).length, 4);
    assert.ok((await fs.readdir(directory)).includes(filename(event(9))));
  });
});

test('growing files are read with a fixed buffer and rejected instead of readFile allocation', async () => {
  await fixture(async directory => {
    const file = path.join(directory, filename(event(1)));
    await fs.writeFile(file, '{}');
    const before = await fs.lstat(file);
    let readLimit = 0;
    const io = { open: async (...args) => {
      const handle = await fs.open(...args);
      let firstStat = true;
      return {
        stat: async () => { const stat = await handle.stat(); if (firstStat) { firstStat = false; await fs.writeFile(file, 's'.repeat(1024 * 1024)); } return stat; },
        read: async (buffer, ...args) => { readLimit = Math.max(readLimit, buffer.length); return handle.read(buffer, ...args); },
        close: () => handle.close(),
      };
    } };
    assert.equal(await readBounded(io, file, before, MAX_FILE_BYTES), null);
    assert.equal(readLimit, MAX_FILE_BYTES + 1);
  });
});

test('overlapping polls are skipped and missing/replaced directories are harmless', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const io = { lstat: async () => { await pending; throw new Error('missing'); } };
  const reader = new InboxReader('unused', { io });
  const first = reader.poll(() => { throw new Error('must-not-ingest'); }, now);
  assert.equal((await reader.poll(() => true, now)).busy, true);
  release();
  assert.deepEqual(await first, { busy: false, accepted: 0, pruned: 0 });
  assert.equal(reader.polling, false);
});
