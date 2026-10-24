'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Activity, validateEvent, EVENT_TTL } = require('../src/core/activity.cjs');

const now = Date.now();
const characters = [{ id: 'claude', provider: 'claude' }, { id: 'gpt', provider: 'codex' }];
const settings = { character: 'claude', followActivity: true };
function event({ provider = 'claude', state = 'thinking', id = 1, time = now } = {}) {
  return { version: 1, provider, state, session: id.toString(16).padStart(32, '0'), at: new Date(time).toISOString() };
}

test('untrusted activity rejects content, unsupported labels, malformed identities, expired and future events', () => {
  const valid = event();
  assert.equal(validateEvent(valid, now).state, 'thinking');
  for (const value of [null, [], 'thinking', { ...valid, prompt: 'private' }, { ...valid, version: 2 },
    { ...valid, provider: 'other' }, { ...valid, state: '<script>' }, { ...valid, session: '../credentials' },
    { ...valid, at: 'not-a-date' }, event({ time: now - EVENT_TTL - 1 }), event({ time: now + 60001 })]) {
    assert.equal(validateEvent(value, now), null);
  }
  assert.ok(validateEvent(event({ time: now - EVENT_TTL }), now));
  assert.ok(validateEvent(event({ time: now + 60000 }), now));
});

test('duplicates and delayed session events cannot roll a completed session back into work', () => {
  const activity = new Activity(now);
  assert.equal(activity.ingest(event({ time: now - 1000 }), now), true);
  assert.equal(activity.ingest(event({ state: 'success' }), now), true);
  assert.equal(activity.ingest(event(), now), false);
  assert.equal(activity.ingest(event({ time: now - 500 }), now), false);
  assert.equal(activity.snapshot(settings, characters, now).state, 'success');
});

test('foreground identity, last event and manual selection have deterministic precedence', () => {
  const activity = new Activity(now);
  activity.ingest(event({ provider: 'codex', state: 'coding' }), now);
  assert.equal(activity.snapshot(settings, characters, now).character, 'gpt');
  activity.setForeground('claude');
  assert.equal(activity.snapshot(settings, characters, now).character, 'claude');
  assert.equal(activity.snapshot(settings, characters, now).state, 'idle');
  const manual = activity.snapshot({ ...settings, followActivity: false }, characters, now);
  assert.equal(manual.character, 'claude');
  assert.equal(manual.state, 'idle');
  activity.setForeground('terminal');
  assert.equal(activity.snapshot(settings, characters, now).character, 'gpt');
});

test('one session stopping does not hide another ongoing session of the same provider', () => {
  const activity = new Activity(now);
  activity.ingest(event({ id: 1, state: 'coding', time: now - 1000 }), now);
  activity.ingest(event({ id: 2, state: 'success' }), now);
  let current = activity.snapshot(settings, characters, now);
  assert.equal(current.state, 'coding');
  assert.equal(current.concurrent, 1);
  activity.ingest(event({ id: 1, state: 'tool', time: now + 100 }), now + 100);
  activity.ingest(event({ id: 2, state: 'idle', time: now + 200 }), now + 200);
  assert.equal(activity.snapshot(settings, characters, now + 200).state, 'tool');
  activity.ingest(event({ id: 1, state: 'success', time: now + 300 }), now + 300);
  current = activity.snapshot(settings, characters, now + 300);
  assert.equal(current.state, 'success');
  assert.equal(current.concurrent, 0);
});

test('settled animations expire, abandoned busy states expire, and interaction wakes sleeping companion', () => {
  const settled = new Activity(now);
  settled.ingest(event({ state: 'error' }), now);
  assert.equal(settled.snapshot(settings, characters, now + 12001).state, 'idle');
  const busy = new Activity(now);
  busy.ingest(event(), now);
  const expired = busy.snapshot(settings, characters, now + EVENT_TTL + 1);
  assert.equal(expired.sessions.length, 0);
  assert.equal(expired.concurrent, 0);
  assert.equal(expired.state, 'sleeping');
  busy.touch(now + EVENT_TTL + 1);
  assert.equal(busy.snapshot(settings, characters, now + EVENT_TTL + 1).state, 'idle');
});

test('session pressure keeps newest 32 and snapshots never expose session pseudonyms or raw input', () => {
  const activity = new Activity(now);
  for (let id = 1; id <= 40; id++) activity.ingest(event({ id, time: now - 1000 + id }), now);
  assert.equal(activity.sessions.size, 32);
  const current = activity.snapshot(settings, characters, now);
  assert.equal(current.sessions.length, 32);
  assert.equal(current.concurrent, 32);
  assert.equal(current.lastEventAt, event({ time: now - 960 }).at);
  assert.ok([...activity.sessions.values()].every(value => Number.parseInt(value.session, 16) >= 9));
  for (const value of current.sessions) assert.deepEqual(Object.keys(value), ['provider', 'state', 'at']);
});
test('running app identity survives a generic foreground and an ended hook cannot hold identity or presence', () => {
  const activity = new Activity(now);
  activity.setRunning(['codex']);
  assert.equal(activity.snapshot(settings,characters,now).character,'gpt');
  activity.ingest(event({provider:'claude',state:'offline'}),now);
  assert.deepEqual(activity.presentProviders(now),[]);
  assert.equal(activity.snapshot(settings,characters,now).character,'gpt');
  activity.setRunning(['codex','claude']);activity.setForeground('codex');activity.setForeground(null);
  assert.equal(activity.snapshot(settings,characters,now).character,'gpt');
});

test('side-by-side snapshots keep each provider character, work and session metadata independent', () => {
  const activity = new Activity(now);
  activity.ingest(event({ provider: 'claude', state: 'reading', time: now - 100 }), now);
  activity.ingest(event({ provider: 'codex', state: 'coding' }), now);
  activity.setForeground('codex');
  const claude = activity.snapshotForProvider('claude', characters, now);
  const codex = activity.snapshotForProvider('codex', characters, now);
  assert.deepEqual([claude.character, claude.provider, claude.state, claude.concurrent], ['claude', 'claude', 'reading', 1]);
  assert.deepEqual([codex.character, codex.provider, codex.state, codex.concurrent], ['gpt', 'codex', 'coding', 1]);
  assert.equal(claude.lastEventAt, event({ time: now - 100 }).at);
  assert.equal(codex.lastEventAt, event().at);
  for (const snapshot of [claude, codex]) {
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0].provider, snapshot.provider);
    assert.deepEqual(Object.keys(snapshot.sessions[0]), ['provider', 'state', 'at']);
  }
  assert.equal(activity.foreground, 'codex');
  assert.equal(activity.snapshot(settings, characters, now).character, 'gpt');
  assert.equal(activity.snapshot(settings, characters, now).sessions.length, 2);
  assert.equal(activity.snapshotForProvider('unsupported', characters, now), null);
});

test('one provider completing cannot replace the other provider ongoing work', () => {
  const activity = new Activity(now);
  activity.ingest(event({ provider: 'claude', state: 'reading', time: now - 1000 }), now);
  activity.ingest(event({ provider: 'codex', state: 'success' }), now);
  assert.equal(activity.snapshotForProvider('claude', characters, now).state, 'reading');
  assert.equal(activity.snapshotForProvider('codex', characters, now).state, 'success');
  const settled = now + 12001;
  assert.equal(activity.snapshotForProvider('claude', characters, settled).state, 'reading');
  assert.equal(activity.snapshotForProvider('codex', characters, settled).state, 'idle');
  assert.equal(activity.snapshotForProvider('codex', characters, settled).concurrent, 0);
});

test('provider events and pet interactions wake only their own sleeping companion', () => {
  const activity = new Activity(now);
  const later = now + 5 * 60 * 1000 + 1;
  assert.equal(activity.snapshotForProvider('claude', characters, later).state, 'sleeping');
  assert.equal(activity.snapshotForProvider('codex', characters, later).state, 'sleeping');
  activity.ingest(event({ provider: 'codex', state: 'success', time: later }), later);
  assert.equal(activity.snapshotForProvider('claude', characters, later).state, 'sleeping');
  assert.equal(activity.snapshotForProvider('codex', characters, later).state, 'success');
  assert.equal(activity.touchProvider('claude', later), true);
  assert.equal(activity.snapshotForProvider('claude', characters, later).state, 'idle');
  const afterSleep = later + 5 * 60 * 1000 + 1;
  activity.touchProvider('codex', afterSleep);
  assert.equal(activity.snapshotForProvider('claude', characters, afterSleep).state, 'sleeping');
  assert.equal(activity.snapshotForProvider('codex', characters, afterSleep).state, 'idle');
  assert.equal(activity.touchProvider('unsupported', afterSleep), false);
});

test('abandoned activity expires independently while the other provider continues receiving events', () => {
  const activity = new Activity(now);
  activity.ingest(event({ provider: 'claude', state: 'reading' }), now);
  const later = now + EVENT_TTL + 1;
  activity.ingest(event({ provider: 'codex', state: 'coding', time: later }), later);
  const claude = activity.snapshotForProvider('claude', characters, later);
  const codex = activity.snapshotForProvider('codex', characters, later);
  assert.equal(claude.state, 'sleeping');
  assert.equal(claude.sessions.length, 0);
  assert.equal(claude.lastEventAt, null);
  assert.equal(codex.state, 'coding');
  assert.equal(codex.sessions.length, 1);
  assert.equal(codex.concurrent, 1);
});
