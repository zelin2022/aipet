'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpriteCatalog } = require('../src/core/sprite-catalog.cjs');
const { readCustomArtwork } = require('../src/core/artwork.cjs');
const manifest = require('../assets/crosspet/manifest.json');
const originals = require('../assets/crosspet/provenance.json').files;
test('usage inventory includes every original/custom sprite, merges aliases and distinguishes unused artwork', () => {
  const artwork = readCustomArtwork(require('node:path').join(__dirname, '../assets/custom'), { strict: true });
  const characters = manifest.characters.map(character => ({ ...character, customPoses: artwork.customPoses[character.id], customMode: artwork.customModes[character.id], customBlink: artwork.customBlink[character.id] }));
  const catalog = createSpriteCatalog({ characters, originals, custom: artwork.imagePins });
  assert.equal(catalog.length, 176);
  assert.equal(new Set(catalog.map(row => row.id)).size, catalog.length);
  const wink = catalog.find(row => row.id === 'custom/gpt/greet-morning-v1.png');
  assert.deepEqual(wink.states, ['greet', 'wink']);
  assert.equal(wink.eligible, true);
  assert.equal(catalog.find(row => row.id === 'crosspet/characters/gpt/idle.webp').eligible, false);
  assert.equal(catalog.find(row => row.id === 'crosspet/characters/claude/proud.webp').eligible, true);
  assert.equal(catalog.find(row => row.id === 'custom/gpt/idle-blink-v1.png').blink, true);
  assert.ok(catalog.every(row => row.url === '../assets/' + row.id && /^[a-f0-9]{64}$/.test(row.hash)));
  assert.ok(catalog.some(row => !row.eligible && !row.states.length));
});
test('usage inventory retains original artwork when custom art is unavailable', () => {
  const catalog = createSpriteCatalog({ characters: manifest.characters, originals, custom: [] });
  assert.equal(catalog.length, 119);
  assert.ok(catalog.every(row => row.id.startsWith('crosspet/')));
  assert.equal(catalog.filter(row => row.blink && row.eligible).length, 2);
});
