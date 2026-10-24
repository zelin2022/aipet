/* Independent pose scheduling. No application logic from CrossPet is executed. */
(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.PetPoses = value;
})(typeof window === 'object' ? window : globalThis, () => {
  'use strict';
  const poses = Object.freeze({ idle: 'idle', thinking: 'thinking', reading: 'reading', coding: 'writing', tool: 'running', success: 'happy', error: 'oops', waiting: 'asking', sleeping: 'sleeping', pat: 'pat', poke: 'surprised', hum: 'hum', stretch: 'stretch', yawn: 'yawn', greet: 'greet_morning', coaxed: 'coaxed', puffed: 'puffed', hairplay: 'hairplay', aloof: 'aloof', wink: 'wink', smug: 'proud', sip: 'sip' });
  const extras = { pat: ['forgiven'], waiting: ['listening'], greet: ['greet_afternoon', 'greet_evening'] };
  const safePath = value => typeof value === 'string' && /^(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_.-]+\.(?:webp|png)$/.test(value) && !value.split('/').some(part => part === '.' || part === '..');
  function candidates(character, state, fallback = true) {
    const result = [];
    // A complete approved restyle is one visual identity. Its verified pools
    // replace the originals rather than alternating between two costumes.
    if (character.customMode !== 'replace') {
      for (const pose of [poses[state] || state, ...(extras[state] || [])]) {
        const primary = character.poses?.[pose];
        for (const path of [primary, ...(character.poseVariants?.[pose] || [])]) {
          if (safePath(path)) result.push('../assets/crosspet/' + path);
        }
      }
    }
    for (const path of character.customPoses?.[state] || []) if (safePath(path)) result.push('../assets/custom/' + path);
    const unique = [...new Set(result)];
    return unique.length || !fallback || state === 'idle' ? unique : candidates(character, 'idle', false);
  }
  function createController(options = {}) {
    const now = options.now || (() => Date.now()), random = options.random || Math.random;
    const records = new Map();
    const between = (min, max) => min + Math.max(0, Math.min(0.999999, random())) * (max - min);
    function choose(pool, previous) {
      const available = pool.filter(item => item !== previous);
      const choices = available.length ? available : pool;
      return choices[Math.floor(between(0, choices.length))] || null;
    }
    function record(provider) {
      if (!records.has(provider)) records.set(provider, { character: null, base: null, visible: false, local: null, state: null, path: null, history: new Map(), rotateAt: Infinity, nextAntic: Infinity, previousAntic: null, observedAt: now(), idleTime: 0, nextPout: 120000, activityAt: null });
      return records.get(provider);
    }
    function update(provider, character, baseState, settings = {}) {
      const entry = record(provider), time = now(), visible = settings.visible !== false, reduced = Boolean(settings.reducedMotion);
      const base = poses[baseState] ? baseState : 'idle';
      if (entry.character !== character.id) {
        Object.assign(entry, { character: character.id, base: null, visible: false, local: null, state: null, path: null, history: new Map(), nextAntic: Infinity, previousAntic: null, observedAt: time, idleTime: 0, nextPout: 120000, activityAt: null });
      }
      const appeared = visible && !entry.visible;
      const woke = entry.base === 'sleeping' && base === 'idle';
      const changed = entry.base !== base;
      // Existing event timestamps can reset a local attention timer without
      // inspecting messages, user activity elsewhere, or persisting attention.
      const activityAt = typeof settings.activityAt === 'string' && settings.activityAt.length <= 32 ? settings.activityAt : null;
      const newActivity = entry.activityAt !== activityAt;
      if (!visible || reduced || changed || newActivity) { entry.idleTime = 0; entry.nextPout = 120000; }
      else if (entry.visible && base === 'idle') entry.idleTime += Math.max(0, time - entry.observedAt);
      entry.observedAt = time; entry.activityAt = activityAt;
      if (!visible || (reduced && entry.local?.kind !== 'interaction') || (entry.local?.kind === 'idle' && (base !== 'idle' || newActivity)) || (entry.local?.kind === 'greet' && base !== 'idle') || (changed && ['error', 'waiting', 'success'].includes(base))) entry.local = null;
      if (entry.local && time >= entry.local.until) entry.local = null;
      if (appeared || ((changed || newActivity) && base === 'idle')) entry.nextAntic = time + between(45000, 75000);
      if (visible && !reduced && base === 'idle' && (appeared || woke) && options.allowWelcome !== false && candidates(character, 'greet', false).length) {
        entry.local = { state: 'greet', kind: 'greet', until: time + 2600 };
      }
      if (visible && !reduced && base === 'idle' && !entry.local && entry.idleTime >= entry.nextPout && options.allowAntics !== false && candidates(character, 'puffed', false).length) {
        entry.local = { state: 'puffed', kind: 'idle', until: time + between(3600, 4800) };
        entry.nextPout = entry.idleTime + 120000;
        entry.nextAntic = time + between(45000, 75000);
      }
      if (visible && !reduced && base === 'idle' && !entry.local && time >= entry.nextAntic && options.allowAntics !== false) {
        const pool = ['hum', 'stretch', 'yawn', 'coaxed', 'hairplay', 'aloof', 'wink', 'smug', 'sip'].filter(state => candidates(character, state, false).length);
        const action = choose(pool, entry.previousAntic);
        if (action) { entry.previousAntic = action; entry.local = { state: action, kind: 'idle', until: time + between(3600, 4800) }; }
        entry.nextAntic = time + between(45000, 75000);
      }
      const state = entry.local?.state || base;
      const pool = candidates(character, state);
      const stateChanged = state !== entry.state;
      const rotate = visible && !reduced && ['idle', 'thinking', 'reading', 'coding', 'tool'].includes(state) && time >= entry.rotateAt;
      if (stateChanged || rotate || !pool.includes(entry.path)) {
        entry.path = choose(pool, entry.history.get(state));
        entry.history.set(state, entry.path);
        entry.rotateAt = time + between(18000, 26000);
      }
      entry.base = base; entry.visible = visible; entry.state = state;
      return { state, path: entry.path };
    }
    function attend(provider) {
      const entry = record(provider);
      entry.idleTime = 0; entry.nextPout = 120000; entry.observedAt = now();
      if (entry.local?.state === 'puffed') entry.local = null;
    }
    function interact(provider, action) {
      if (!['pat', 'poke'].includes(action)) return false;
      attend(provider);
      const entry = record(provider);
      entry.local = { state: action, kind: 'interaction', until: now() + 3000 };
      return true;
    }
    return Object.freeze({ update, interact });
  }
  return Object.freeze({ poses, candidates, createController, safePath });
});
