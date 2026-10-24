'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { STATES: ACTIVITY_STATES } = require('./activity.cjs');

const MAX_DEBUG_BYTES = 131072;
const MAX_DEBUG_RECORDS = 512;
const MAX_DEBUG_DURATION_MS = 15 * 60 * 1000;
const MAX_DEBUG_WINDOW_MS = 30 * 60 * 1000;
const CONTROL = 'debug-control.json', JOURNAL = 'debug.jsonl', LOCK = '.debug-lock';
const PROVIDERS = new Set(['claude', 'codex']);
const STATES = new Set(['idle', 'offline', 'thinking', 'reading', 'coding', 'tool', 'success', 'error', 'waiting', 'sleeping', 'pat', 'poke', 'hum', 'stretch', 'yawn', 'greet', 'coaxed', 'puffed', 'hairplay', 'aloof', 'wink', 'smug', 'sip']);
const HOOK_PHASES = new Set(['hook-invoked', 'hook-written', 'hook-write-failed']);
const PHASES = new Set([...HOOK_PHASES, 'inbox-accepted', 'main-state', 'renderer-state']);
const HEX = /^[a-f0-9]{32}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exact = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const stamp = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

function workspaceScope(directory) {
  if (typeof directory !== 'string' || !path.win32.isAbsolute(directory)) return null;
  const normalized = path.win32.resolve(directory).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return createHash('sha256').update('aipet-debug-workspace-v1:' + normalized).digest('hex').slice(0, 32);
}
function validControl(value) {
  if (!value || typeof value.nonce !== 'string' || !HEX.test(value.nonce) || !timestamp(value.expiresAt)) return false;
  if (value.version === 1)
    return exact(value, ['version', 'enabled', 'nonce', 'expiresAt']) && typeof value.enabled === 'boolean';
  if (value.version === 2) {
    const span = Date.parse(value.expiresAt) - Date.parse(value.startsAt);
    return exact(value, ['version', 'enabled', 'nonce', 'startsAt', 'expiresAt']) && value.enabled === true && timestamp(value.startsAt) && span > 0 && span <= MAX_DEBUG_WINDOW_MS;
  }
  return false;
}
function isDebugActive(control, now = Date.now()) {
  if (!Number.isFinite(now) || !validControl(control) || !control.enabled) return false;
  if (control.version === 2)
    return Date.parse(control.startsAt) <= now && now < Date.parse(control.expiresAt);
  const remaining = Date.parse(control?.expiresAt) - now;
  return remaining > 0 && remaining <= MAX_DEBUG_DURATION_MS;
}
function validRecord(value) {
  return exact(value, ['at', 'eventAt', 'provider', 'state', 'phase', 'workspace']) && timestamp(value.at) && (value.eventAt === null || timestamp(value.eventAt)) && PROVIDERS.has(value.provider) && (['main-state', 'renderer-state'].includes(value.phase) ? STATES : ACTIVITY_STATES).has(value.state) && PHASES.has(value.phase)
    && (value.workspace === null || (HOOK_PHASES.has(value.phase) && typeof value.workspace === 'string' && HEX.test(value.workspace)));
}
async function checkDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error('debug-directory');
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('debug-directory');
}
async function readText(directory, name, limit) {
  await checkDirectory(directory);
  const filename = path.join(directory, name), before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new Error('debug-file');
  let handle;
  try {
    handle = await fs.open(filename, 'r');
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > limit || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('debug-file');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit || (await handle.stat()).size > limit) throw new Error('debug-file');
    return buffer.subarray(0, length).toString('utf8');
  } finally { await handle?.close().catch(() => {}); }
}
async function readDebugControl(directory) {
  try {
    const value = JSON.parse(await readText(directory, CONTROL, 1024));
    return validControl(value) ? value : null;
  } catch { return null; }
}
async function readDebug(directory) {
  try {
    const text = await readText(directory, JOURNAL, MAX_DEBUG_BYTES);
    if (!text) return [];
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    if (lines.length > MAX_DEBUG_RECORDS || lines.some(line => Buffer.byteLength(line) > 256)) return null;
    const records = lines.map(line => JSON.parse(line));
    return records.every(validRecord) ? records : null;
  } catch (error) { return error.code === 'ENOENT' ? [] : null; }
}
async function atomicWrite(directory, name, text, limit) {
  if (Buffer.byteLength(text) > limit) throw new Error('debug-size');
  await checkDirectory(directory);
  const target = path.join(directory, name);
  async function checkTarget() {
    try {
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('debug-file');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await checkTarget();
  // Called only under our exclusive lock. Fixed reserved temporary names keep
  // interrupted hook processes from accumulating unbounded orphaned files.
  const temporary = path.join(directory, `.${name}.tmp`);
  try {
    const previous = await fs.lstat(temporary);
    if (!previous.isFile() || previous.isSymbolicLink() || previous.size > limit) throw new Error('debug-file');
    await fs.unlink(temporary);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let handle, created = false;
  try {
    handle = await fs.open(temporary, 'wx', 0o600); created = true;
    await handle.writeFile(text, 'utf8'); await handle.close(); handle = null;
    await checkTarget();
    await fs.rename(temporary, target);
  } finally {
    await handle?.close().catch(() => {});
    if (created) await fs.unlink(temporary).catch(() => {});
  }
}
async function clearStaleLock(directory) {
  try {
    const filename = path.join(directory, LOCK), before = await fs.lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 1024 || Date.now() - before.mtimeMs < 5000) return;
    const value = JSON.parse(await readText(directory, LOCK, 1024));
    if (!exact(value, ['pid', 'nonce', 'at']) || !Number.isSafeInteger(value.pid) || value.pid < 1 || !HEX.test(value.nonce) || !timestamp(value.at)) return;
    try { process.kill(value.pid, 0); return; } catch (error) { if (error.code !== 'ESRCH') return; }
    if (stamp(await fs.lstat(filename)) === stamp(before)) await fs.unlink(filename);
  } catch {}
}
async function withLock(directory, callback) {
  await checkDirectory(directory);
  const nonce = randomBytes(16).toString('hex'), filename = path.join(directory, LOCK), deadline = Date.now() + 100;
  let handle, identity;
  do {
    try { handle = await fs.open(filename, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await clearStaleLock(directory);
      if (Date.now() >= deadline) throw new Error('debug-busy');
      await sleep(8);
    }
  } while (!handle);
  try {
    identity = await handle.stat();
    await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, at: new Date().toISOString() }));
    await handle.close(); handle = null;
    return await callback();
  } finally {
    await handle?.close().catch(() => {});
    try {
      const current = await fs.lstat(filename);
      if (identity && current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await fs.unlink(filename);
    } catch {}
  }
}
async function setDebug(directory, { enabled, nonce, durationMs = MAX_DEBUG_DURATION_MS }, now = Date.now()) {
  if (typeof enabled !== 'boolean' || typeof nonce !== 'string' || !HEX.test(nonce) || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > MAX_DEBUG_DURATION_MS || !Number.isFinite(now)) throw new Error('debug-request');
  const control = { version: 1, enabled, nonce, expiresAt: new Date(now + (enabled ? durationMs : 0)).toISOString() };
  return withLock(directory, async () => {
    if (enabled) await atomicWrite(directory, JOURNAL, '', MAX_DEBUG_BYTES);
    await atomicWrite(directory, CONTROL, JSON.stringify(control) + '\n', 1024);
    return control;
  });
}
async function setDebugWindow(directory, { nonce, startsAt, expiresAt }, now = Date.now()) {
  const control = { version: 2, enabled: true, nonce, startsAt, expiresAt };
  const start = Date.parse(startsAt);
  if (!validControl(control) || !Number.isFinite(now) || start < now || start > now + 24 * 60 * 60 * 1000) throw new Error('debug-request');
  return withLock(directory, async () => {
    await atomicWrite(directory, JOURNAL, '', MAX_DEBUG_BYTES);
    await atomicWrite(directory, CONTROL, JSON.stringify(control) + '\n', 1024);
    return control;
  });
}
async function appendDebug(directory, input, now = Date.now()) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !['phase', 'provider', 'state'].every(key => Object.hasOwn(input, key)) || Object.keys(input).some(key => !['phase', 'provider', 'state', 'workspace', 'eventAt'].includes(key))) return false;
    const elapsedSince = Date.now(), effectiveNow = () => now + Date.now() - elapsedSince;
    const record = { at: new Date(now).toISOString(), eventAt: input.eventAt ?? null, provider: input.provider, state: input.state, phase: input.phase, workspace: input.workspace ?? null };
    if (!validRecord(record)) return false;
    const initial = await readDebugControl(directory);
    if (!isDebugActive(initial, now)) return false;
    return await withLock(directory, async () => {
      const control = await readDebugControl(directory);
      if (!isDebugActive(control, effectiveNow()) || control.nonce !== initial.nonce) return false;
      const previous = await readDebug(directory);
      if (!previous) return false;
      if (!isDebugActive(control, effectiveNow())) return false;
      const records = [...previous, record].slice(-MAX_DEBUG_RECORDS);
      await atomicWrite(directory, JOURNAL, records.map(item => JSON.stringify(item)).join('\n') + '\n', MAX_DEBUG_BYTES);
      return true;
    });
  } catch { return false; }
}

module.exports = { MAX_DEBUG_BYTES, MAX_DEBUG_RECORDS, MAX_DEBUG_DURATION_MS, MAX_DEBUG_WINDOW_MS, isDebugActive, workspaceScope, readDebugControl, readDebug, setDebug, setDebugWindow, appendDebug };
