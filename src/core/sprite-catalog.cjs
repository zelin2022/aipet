'use strict';
const { poses, candidates } = require('../../renderer/pose-selector.js');
const valid = value => typeof value === 'string' && /^(?:crosspet\/characters|custom)\/(claude|gpt)\/[a-zA-Z0-9_-]+\.(?:png|webp)$/.test(value);

function createSpriteCatalog({ characters, originals, custom }) {
  const entries = new Map();
  function add(id, hash) {
    if (!valid(id) || !/^[a-f0-9]{64}$/.test(hash)) return;
    const character = id.split('/').at(-2);
    entries.set(id, { id, hash, character, name: id.split('/').at(-1), url: '../assets/' + id, states: [], eligible: false, blink: false });
  }
  for (const pin of originals) add('crosspet/' + pin.destination, pin.sha256);
  for (const pin of custom) add('custom/' + pin.path, pin.sha256);
  for (const character of characters) {
    for (const state of Object.keys(poses)) {
      for (const url of candidates(character, state, false)) {
        const entry = entries.get(url.slice('../assets/'.length));
        if (entry?.character !== character.id) continue;
        entry.eligible = true;
        if (!entry.states.includes(state)) entry.states.push(state);
      }
    }
    // Classify archived blinks too, but only the currently compatible one is selectable.
    for (const image of [character.poses['idle-blink'], ...(character.poseVariants?.['idle-blink'] || [])]) {
      const entry = entries.get('crosspet/' + image);
      if (entry) entry.blink = true;
    }
    const blinkId = character.customMode === 'replace' ? 'custom/' + character.customBlink : 'crosspet/' + character.poses['idle-blink'];
    const blink = entries.get(blinkId);
    if (blink) { blink.blink = true; blink.eligible = true; blink.states.push('idle-blink'); }
  }
  return [...entries.values()].map(entry => ({ ...entry, states: entry.states.sort() })).sort((a, b) => a.id.localeCompare(b.id));
}
module.exports = { createSpriteCatalog };
