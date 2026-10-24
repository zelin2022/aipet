'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const MAX_SPRITES = 512;
const MAX_USAGE_BYTES = 256 * 1024;
const MAX_GAP_MS = 5000;
const MAX_COUNTER = Math.floor(Number.MAX_SAFE_INTEGER / MAX_SPRITES);
const FILE = 'sprite-usage.json';
const TEMPORARY = '.sprite-usage.json.tmp';
const CHARACTERS = ['claude', 'gpt'];
const SLOTS = new Set(['claude', 'codex']);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const exact = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNTER;
const add = (left, right) => Math.min(MAX_COUNTER, left + right);
const stamp = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

function assetId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 180 && /^[a-zA-Z0-9_./-]+$/.test(id)
    && !id.startsWith('/') && !id.split('/').some(part => !part || part === '.' || part === '..');
}
function catalogRows(catalog) {
  if (!Array.isArray(catalog) || catalog.length > MAX_SPRITES) throw new Error('Invalid sprite usage catalog.');
  const rows = new Map();
  for (const entry of catalog) {
    if (!entry || typeof entry !== 'object' || !assetId(entry.id) || !/^[a-f0-9]{64}$/.test(entry.hash)
      || !CHARACTERS.includes(entry.character) || typeof entry.eligible !== 'boolean' || typeof entry.blink !== 'boolean'
      || typeof entry.name !== 'string' || entry.name.length < 1 || entry.name.length > 180 || /[\x00-\x1f\x7f]/.test(entry.name)
      || !Array.isArray(entry.states) || entry.states.length > 32 || entry.states.some(state => typeof state !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(state))
      || (entry.url !== undefined && (typeof entry.url !== 'string' || entry.url.length > 2048 || /[\x00-\x1f\x7f]/.test(entry.url)))) throw new Error('Invalid sprite usage catalog.');
    const previous = rows.get(entry.id);
    if (previous) {
      if (previous.hash !== entry.hash || previous.character !== entry.character) throw new Error('Conflicting sprite usage catalog.');
      previous.states = [...new Set([...previous.states, ...entry.states])].sort();
      previous.eligible ||= entry.eligible;
      previous.blink ||= entry.blink;
    } else rows.set(entry.id, {
      id: entry.id, hash: entry.hash, character: entry.character, name: entry.name,
      states: [...new Set(entry.states)].sort(), eligible: entry.eligible, blink: entry.blink,
      ...(entry.url !== undefined ? { url: entry.url } : {}),
    });
  }
  return rows;
}

// This feature reads and writes only one bounded local aggregate. Check the whole
// ancestry so a parent junction cannot redirect the store to another directory.
function checkDirectory(directory) {
  const ancestry = [];
  for (let current = directory; ; current = path.dirname(current)) {
    ancestry.push(current);
    if (path.dirname(current) === current) break;
  }
  for (const current of ancestry.reverse()) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe sprite usage directory.');
  }
}
function checkFile(filename, optional = false) {
  let stat;
  try { stat = fs.lstatSync(filename); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_USAGE_BYTES) throw new Error('Unsafe sprite usage file.');
  return stat;
}
function readStore(directory) {
  checkDirectory(directory);
  const filename = path.join(directory, FILE), before = checkFile(filename, true);
  if (!before) return null;
  let handle;
  try {
    handle = fs.openSync(filename, 'r');
    if (stamp(fs.fstatSync(handle)) !== stamp(before)) throw new Error('Changed sprite usage file.');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(handle, bytes, length, bytes.length - length, length);
      if (!read) break;
      length += read;
    }
    checkDirectory(directory);
    if (length !== before.size || stamp(fs.fstatSync(handle)) !== stamp(before) || stamp(checkFile(filename)) !== stamp(before)) throw new Error('Changed sprite usage file.');
    return bytes.subarray(0, length).toString('utf8');
  } finally { if (handle !== undefined) fs.closeSync(handle); }
}
function writeStore(directory, text) {
  if (Buffer.byteLength(text) > MAX_USAGE_BYTES) throw new Error('Oversized sprite usage store.');
  checkDirectory(directory);
  const target = path.join(directory, FILE), temporary = path.join(directory, TEMPORARY);
  checkFile(target, true);
  // One reserved temporary name prevents crash leftovers from accumulating.
  if (checkFile(temporary, true)) fs.unlinkSync(temporary);
  let handle, created = false;
  try {
    handle = fs.openSync(temporary, 'wx', 0o600); created = true;
    fs.writeFileSync(handle, text, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle); handle = undefined;
    checkDirectory(directory);
    checkFile(target, true);
    checkFile(temporary);
    fs.renameSync(temporary, target);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    if (created) { try { fs.unlinkSync(temporary); } catch {} }
  }
}

function createSpriteUsage({ directory, catalog, now = () => performance.now(), wallNow = () => Date.now(), maxGapMs = MAX_GAP_MS } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof now !== 'function' || typeof wallNow !== 'function'
    || !Number.isSafeInteger(maxGapMs) || maxGapMs < 1 || maxGapMs > MAX_GAP_MS) throw new Error('Invalid sprite usage options.');
  directory = path.resolve(directory);
  const assets = catalogRows(catalog);
  const records = new Map([...assets.keys()].map(id => [id, { count: 0, visibleMs: 0 }]));
  const isoNow = () => {
    try { const value = new Date(wallNow()).toISOString(); if (timestamp(value)) return value; } catch {}
    return new Date().toISOString();
  };
  const sessionStartedAt = isoNow();
  let startedAt = sessionStartedAt, savedAt = null, dirty = false, loaded = false, storage = 'ready';
  let slots = new Map(), mark = null, leaseUntil = null;
  function clock() {
    let value;
    try { value = Math.floor(now()); } catch { return mark; }
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - MAX_GAP_MS) return mark;
    return mark === null ? value : Math.max(mark, value);
  }
  function advance(value = clock()) {
    if (value === null) return;
    if (mark !== null && slots.size && leaseUntil !== null) {
      const elapsed = Math.max(0, Math.min(value, leaseUntil) - mark);
      if (elapsed) {
        for (const id of slots.values()) records.get(id).visibleMs = add(records.get(id).visibleMs, elapsed);
        dirty = true;
      }
      if (value >= leaseUntil) { slots.clear(); leaseUntil = null; }
    }
    mark = value;
  }
  async function load() {
    if (loaded) return storage === 'ready';
    loaded = true;
    let text;
    try { text = readStore(directory); storage = 'ready'; }
    catch { storage = 'unavailable'; return false; }
    if (text === null) return true;
    let saved;
    try { saved = JSON.parse(text); }
    catch { dirty = true; return false; }
    if (!exact(saved, ['version', 'startedAt', 'savedAt', 'entries']) || saved.version !== 1 || !timestamp(saved.startedAt) || !timestamp(saved.savedAt)
      || Date.parse(saved.savedAt) < Date.parse(saved.startedAt) || !Array.isArray(saved.entries) || saved.entries.length > MAX_SPRITES) { dirty = true; return false; }
    startedAt = saved.startedAt; savedAt = saved.savedAt;
    const seen = new Set(), duplicates = new Set();
    for (const entry of saved.entries) {
      if (!entry || typeof entry.id !== 'string') continue;
      if (seen.has(entry.id)) duplicates.add(entry.id);
      seen.add(entry.id);
    }
    for (const entry of saved.entries) {
      if (!exact(entry, ['id', 'hash', 'count', 'visibleMs']) || duplicates.has(entry.id) || !assets.has(entry.id)
        || entry.hash !== assets.get(entry.id).hash || !integer(entry.count) || !integer(entry.visibleMs)) continue;
      const record = records.get(entry.id);
      record.count = add(record.count, entry.count); record.visibleMs = add(record.visibleMs, entry.visibleMs);
    }
    return true;
  }
  function observe(input) {
    if (!Array.isArray(input) || input.length > 2) return false;
    const next = new Map();
    for (const entry of input) {
      if (!exact(entry, ['slot', 'id']) || !SLOTS.has(entry.slot) || next.has(entry.slot) || !assets.has(entry.id)) return false;
      next.set(entry.slot, entry.id);
    }
    const value = clock();
    if (value === null) return false;
    advance(value);
    for (const [slot, id] of next) if (slots.get(slot) !== id) { records.get(id).count = add(records.get(id).count, 1); dirty = true; }
    slots = next;
    leaseUntil = slots.size ? value + maxGapMs : null;
    return true;
  }
  function tick() { advance(); }
  function pause() { advance(); slots.clear(); leaseUntil = null; }
  function snapshot() {
    advance();
    const totals = { count: 0, visibleMs: 0 };
    const characters = Object.fromEntries(CHARACTERS.map(character => [character, { count: 0, visibleMs: 0 }]));
    for (const [id, record] of records) {
      totals.count += record.count; totals.visibleMs += record.visibleMs;
      const character = characters[assets.get(id).character];
      character.count += record.count; character.visibleMs += record.visibleMs;
    }
    const rows = [...assets.values()].map(asset => {
      const record = records.get(asset.id), character = characters[asset.character];
      return { ...asset, states: [...asset.states], ...record, timeShare: character.visibleMs ? record.visibleMs / character.visibleMs : 0, globalTimeShare: totals.visibleMs ? record.visibleMs / totals.visibleMs : 0 };
    });
    return { version: 1, enabled: true, startedAt, sessionStartedAt, savedAt, updatedAt: isoNow(), storage, rows, totals, characters };
  }
  function reset() {
    advance();
    for (const record of records.values()) { record.count = 0; record.visibleMs = 0; }
    // An image already visible begins one exposure in the newly reset period.
    for (const id of slots.values()) records.get(id).count++;
    startedAt = isoNow(); savedAt = null; dirty = true;
    return snapshot();
  }
  async function flush() {
    advance();
    if (!dirty) return storage === 'ready';
    const at = new Date(Math.max(Date.parse(startedAt), Date.parse(isoNow()))).toISOString();
    const value = { version: 1, startedAt, savedAt: at, entries: [...records].map(([id, record]) => ({ id, hash: assets.get(id).hash, ...record })) };
    try {
      writeStore(directory, JSON.stringify(value) + '\n');
      savedAt = at; storage = 'ready'; dirty = false; return true;
    } catch { storage = 'unavailable'; return false; }
  }
  return { load, observe, tick, pause, snapshot, reset, flush };
}

module.exports = { createSpriteUsage, MAX_SPRITES, MAX_USAGE_BYTES, MAX_GAP_MS, MAX_COUNTER };
