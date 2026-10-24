'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { readBounded } = require('./inbox.cjs');
const { STATES: ACTIVITY_STATES } = require('./activity.cjs');

const MAX_STATUS_BYTES = 8192;
const REQUEST_ID = /^[a-f0-9]{32}$/;
const PROVIDERS = ['claude', 'codex'];
const STATES = new Set(['idle', 'offline', 'thinking', 'reading', 'coding', 'tool', 'success', 'error', 'waiting', 'sleeping', 'pat', 'poke', 'hum', 'stretch', 'yawn', 'greet', 'coaxed', 'puffed', 'hairplay', 'aloof', 'wink', 'smug', 'sip']);
const PROBES = new Set(['ok', 'absent', 'not-ready', 'timeout', 'failed']);
const REASONS = new Set(['dormant', 'ai-present', 'settling', 'manual', 'hidden', 'fullscreen']);
const DOM_PROBE = "Array.from(document.querySelectorAll('.companion-slot[data-provider]')).filter(slot => !slot.hidden).slice(0, 2).map(slot => ({provider: slot.dataset.provider, state: slot.dataset.state}))";
const exact = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const timestamp = value => value === null || (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)));
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
const provider = value => PROVIDERS.includes(value);
const state = value => STATES.has(value);
const activityItem = (value, withCharacter = false) => exact(value, withCharacter ? ['provider', 'character', 'state'] : ['provider', 'state']) && provider(value.provider) && state(value.state) && (!withCharacter || value.character === (value.provider === 'claude' ? 'claude' : 'gpt'));
const items = (value, withCharacter = false) => Array.isArray(value) && value.length <= 2 && value.every(item => activityItem(item, withCharacter)) && new Set(value.map(item => item.provider)).size === value.length;

function hasStatusArgument(args) { return args.some(arg => typeof arg === 'string' && (arg === '--status' || arg.startsWith('--status='))); }
function requestIdFromArguments(args) {
  const values = args.filter(arg => typeof arg === 'string' && (arg === '--status' || arg.startsWith('--status=')));
  return values.length === 1 && REQUEST_ID.test(values[0].slice(9)) ? values[0].slice(9) : null;
}

function validateStatus(value, requestId = value?.requestId) {
  return REQUEST_ID.test(requestId || '') && exact(value, ['version', 'requestId', 'pid', 'at', 'poll', 'providers', 'companions', 'renderer', 'visibility', 'windowCount'])
    && value.version === 1 && value.requestId === requestId && Number.isSafeInteger(value.pid) && value.pid > 0 && timestamp(value.at) && value.at !== null
    && exact(value.poll, ['lastStartedAt', 'lastFinishedAt', 'accepted', 'failure']) && timestamp(value.poll.lastStartedAt) && timestamp(value.poll.lastFinishedAt)
    && exact(value.poll.accepted, PROVIDERS) && PROVIDERS.every(name => count(value.poll.accepted[name])) && ['none', 'poll-error'].includes(value.poll.failure)
    && Array.isArray(value.providers) && value.providers.length === 2 && value.providers.every((item, index) => exact(item, ['provider', 'lastEventAt', 'state']) && item.provider === PROVIDERS[index] && timestamp(item.lastEventAt) && ACTIVITY_STATES.has(item.state))
    && items(value.companions, true)
    && exact(value.renderer, ['exists', 'destroyed', 'loading', 'crashed', 'probe', 'companions']) && ['exists', 'destroyed', 'loading', 'crashed'].every(key => typeof value.renderer[key] === 'boolean') && PROBES.has(value.renderer.probe) && items(value.renderer.companions)
    && exact(value.visibility, ['show', 'reason', 'mode', 'providers']) && typeof value.visibility.show === 'boolean' && REASONS.has(value.visibility.reason) && ['auto', 'shown', 'hidden'].includes(value.visibility.mode) && Array.isArray(value.visibility.providers) && value.visibility.providers.length <= 2 && value.visibility.providers.every(provider) && new Set(value.visibility.providers).size === value.visibility.providers.length
    && Number.isInteger(value.windowCount) && value.windowCount >= 0 && value.windowCount <= 2;
}

async function probeRenderer(pet) {
  const value = { exists: !!pet, destroyed: false, loading: false, crashed: false, probe: 'absent', companions: [] };
  if (!pet) return value;
  try {
    value.destroyed = pet.isDestroyed();
    if (value.destroyed || pet.webContents.isDestroyed()) { value.destroyed = true; return value; }
    value.loading = pet.webContents.isLoading();
    value.crashed = typeof pet.webContents.isCrashed === 'function' && pet.webContents.isCrashed();
    if (value.loading || value.crashed) { value.probe = 'not-ready'; return value; }
    let timer;
    try {
      const result = await Promise.race([
        pet.webContents.executeJavaScript(DOM_PROBE).then(companions => ({ companions })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), 750); }),
      ]);
      if (result.timeout) value.probe = 'timeout';
      else if (items(result.companions)) { value.probe = 'ok'; value.companions = result.companions; }
      else value.probe = 'failed';
    } finally { clearTimeout(timer); }
  } catch { value.probe = 'failed'; }
  return value;
}

async function collectDiagnostics({ requestId, pid = process.pid, now = Date.now(), pollHealth, providerEvents = [], companions = [], pet = null, visibility, windowCount = 0 }) {
  if (!REQUEST_ID.test(requestId || '')) throw new Error('invalid-request');
  const providers = PROVIDERS.map(name => {
    const latest = providerEvents.filter(item => item?.provider === name && timestamp(item.at) && item.at !== null && ACTIVITY_STATES.has(item.state)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    return { provider: name, lastEventAt: latest?.at || null, state: latest?.state || 'idle' };
  });
  const value = {
    version: 1, requestId, pid, at: new Date(now).toISOString(),
    poll: { lastStartedAt: pollHealth.lastStartedAt, lastFinishedAt: pollHealth.lastFinishedAt, accepted: { claude: pollHealth.accepted.claude, codex: pollHealth.accepted.codex }, failure: pollHealth.failure },
    providers,
    companions: companions.map(item => ({ provider: item.provider, character: item.character, state: item.state })),
    renderer: await probeRenderer(pet),
    visibility: { show: visibility.show, reason: visibility.reason, mode: visibility.mode, providers: [...visibility.providers] },
    windowCount,
  };
  if (!validateStatus(value)) throw new Error('invalid-status');
  return value;
}

async function writeStatus(directory, value) {
  if (!path.isAbsolute(directory) || !validateStatus(value)) throw new Error('invalid-status');
  const encoded = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(encoded) > MAX_STATUS_BYTES) throw new Error('invalid-status');
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('invalid-directory');
  const destination = path.join(directory, 'status.json');
  async function checkDestination() {
    try {
      const stat = await fs.lstat(destination);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATUS_BYTES) throw new Error('invalid-file');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await checkDestination();
  const temporary = path.join(directory, `.status-${value.requestId}.tmp`);
  let file, created = false;
  try {
    file = await fs.open(temporary, 'wx', 0o600);
    created = true;
    await file.writeFile(encoded, 'utf8');
    await file.close(); file = null;
    await checkDestination();
    await fs.rename(temporary, destination);
  } finally {
    await file?.close().catch(() => {});
    if (created) await fs.unlink(temporary).catch(() => {});
  }
}

async function readStatus(directory, requestId) {
  if (!path.isAbsolute(directory) || !REQUEST_ID.test(requestId || '')) return null;
  try {
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null;
    const filename = path.join(directory, 'status.json'), stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_STATUS_BYTES) return null;
    const value = await readBounded(fs, filename, stat, MAX_STATUS_BYTES);
    return validateStatus(value, requestId) ? value : null;
  } catch { return null; }
}

module.exports = { MAX_STATUS_BYTES, hasStatusArgument, requestIdFromArguments, validateStatus, collectDiagnostics, writeStatus, readStatus };
