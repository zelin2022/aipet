'use strict';

const PROVIDERS = new Set(['claude', 'codex']);
const STATES = new Set(['idle', 'offline', 'thinking', 'reading', 'coding', 'tool', 'success', 'error', 'waiting']);
const BUSY = new Set(['thinking', 'reading', 'coding', 'tool', 'waiting']);
const EVENT_TTL = 15 * 60 * 1000;
const SETTLED_TTL = 12 * 1000;

function validateEvent(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(',') !== 'at,provider,session,state,version') return null;
  if (value.version !== 1 || !PROVIDERS.has(value.provider) || !STATES.has(value.state)) return null;
  if (typeof value.session !== 'string' || !/^[a-f0-9]{16,64}$/.test(value.session)) return null;
  if (typeof value.at !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value.at)) return null;
  const time = Date.parse(value.at);
  if (!Number.isFinite(time) || time > now + 60000 || now - time > EVENT_TTL) return null;
  return { version: 1, provider: value.provider, state: value.state, session: value.session, at: value.at, time };
}

class Activity {
  constructor(now = Date.now()) { this.sessions = new Map(); this.foreground = null; this.runningProviders = []; this.lastProvider = null; this.lastInteraction = now; this.providerInteractions = new Map([...PROVIDERS].map(provider => [provider, now])); }
  ingest(raw, now = Date.now()) {
    const event = validateEvent(raw, now);
    if (!event) return false;
    const key = `${event.provider}:${event.session}`;
    const previous = this.sessions.get(key);
    if (previous && previous.time >= event.time) return false;
    this.sessions.set(key, event);
    this.lastInteraction = now;
    this.providerInteractions.set(event.provider, now);
    while (this.sessions.size > 32) {
      const oldest = [...this.sessions].sort((a, b) => a[1].time - b[1].time)[0][0];
      this.sessions.delete(oldest);
    }
    return true;
  }
  setForeground(provider) { this.foreground = PROVIDERS.has(provider) ? provider : null; if (this.foreground) this.lastProvider = this.foreground; }
  setRunning(providers) { this.runningProviders = [...new Set(providers.filter(p => PROVIDERS.has(p)))]; }
  touch(now = Date.now()) { this.lastInteraction = now; }
  touchProvider(provider, now = Date.now()) {
    if (!PROVIDERS.has(provider)) return false;
    this.providerInteractions.set(provider, now);
    this.lastInteraction = now;
    return true;
  }
  presentProviders(now = Date.now(), maxAge = EVENT_TTL) { return [...new Set([...this.sessions.values()].filter(e => e.state !== 'offline' && now - e.time <= maxAge).map(e => e.provider))]; }
  events(now) {
    for (const [key, event] of this.sessions) if (now - event.time > EVENT_TTL) this.sessions.delete(key);
    return [...this.sessions.values()].sort((a, b) => b.time - a.time);
  }
  snapshot(settings, characters, now = Date.now()) {
    const events = this.events(now);
    const selected = characters.find(c => c.id === settings.character) || characters[0];
    let provider = selected.provider;
    if (settings.followActivity) provider = this.foreground || events.find(e => e.state !== 'offline')?.provider || (this.runningProviders.length === 1 ? this.runningProviders[0] : this.lastProvider) || provider;
    const character = (settings.followActivity && provider !== selected.provider ? characters.find(c => !c.egg && c.provider === provider) : selected) || selected;
    return this.snapshotValue(provider, character, events, this.lastInteraction, now);
  }
  snapshotForProvider(provider, characters, now = Date.now()) {
    if (!PROVIDERS.has(provider)) return null;
    const character = characters.find(c => !c.egg && c.provider === provider);
    if (!character) return null;
    const events = this.events(now).filter(e => e.provider === provider);
    return this.snapshotValue(provider, character, events, this.providerInteractions.get(provider), now);
  }
  snapshotValue(provider, character, events, lastInteraction, now) {
    const providerEvents = events.filter(e => e.provider === provider);
    // One session finishing must not make another session's ongoing work look idle.
    const recent = providerEvents.find(e => BUSY.has(e.state)) || providerEvents[0];
    let state = recent?.state || 'idle';
    if (state === 'offline') state = 'idle';
    if (recent && !BUSY.has(state) && now - recent.time > SETTLED_TTL) state = 'idle';
    if (state === 'idle' && now - lastInteraction > 5 * 60 * 1000) state = 'sleeping';
    return {
      character: character.id, provider, state, foreground: this.foreground,
      sessions: events.map(e => ({ provider: e.provider, state: e.state === 'offline' || (!BUSY.has(e.state) && now - e.time > SETTLED_TTL) ? 'idle' : e.state, at: e.at })),
      concurrent: events.filter(e => e.provider === provider && BUSY.has(e.state)).length,
      lastEventAt: events[0]?.at || null
    };
  }
}
module.exports = { Activity, validateEvent, PROVIDERS, STATES, EVENT_TTL };
