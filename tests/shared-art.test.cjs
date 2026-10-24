'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PetPoses = require('../renderer/pose-selector.js');
const original = require('../assets/crosspet/manifest.json').characters.find(character => character.id === 'gpt');

function fixture(failed = []) {
  const timers = [], requests = [];
  class Image {
    set src(value) { this.target = value; requests.push(value); }
    decode() { return failed.includes(this.target) ? Promise.reject(new Error('Unavailable local art')) : Promise.resolve(); }
  }
  const window = { PetPoses };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/shared.js'), 'utf8'), { window, Image, setTimeout: callback => timers.push(callback) });
  const attributes = new Map();
  const img = {
    style: { transform: 'rotate(1deg)', removeProperty(name) { if (name === 'object-view-box') delete this.objectViewBox; } },
    getAttribute: name => attributes.get(name) ?? null,
    removeAttribute: name => attributes.delete(name),
    set src(value) { attributes.set('src', value); },
    naturalWidth: 1000, naturalHeight: 1200,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 300, bottom: 320 }),
  };
  const character = { ...original, customMode: 'replace', customPoses: { idle: ['gpt/idle.png'], thinking: ['gpt/thinking.png'] }, customBlink: 'gpt/blink.png', customFraming: {
    'gpt/idle.png': { x: 200, y: 100, width: 600, height: 1000, canvasWidth: 1000, canvasHeight: 1200 },
    'gpt/blink.png': { x: 200, y: 100, width: 600, height: 1000, canvasWidth: 1000, canvasHeight: 1200 },
  } };
  return { art: window.PetArt, img, character, timers, requests };
}

test('default previews and failed-image fallback honor the replacement style and reject external selections', async () => {
  const { art, img, character, requests } = fixture(['../assets/custom/gpt/thinking.png']);
  assert.equal(art.imagePath(character, 'idle'), '../assets/custom/gpt/idle.png');
  assert.equal(await art.setImage(img, character, 'thinking', 'https://example.com/art.png'), true);
  assert.equal(img.getAttribute('src'), '../assets/custom/gpt/idle.png');
  assert.deepEqual(requests, ['../assets/custom/gpt/thinking.png', '../assets/custom/gpt/idle.png']);
  assert.equal(requests.some(value => value.includes('crosspet') || value.startsWith('https:')), false);
  await art.setImage(img, { ...character, customPoses: {} }, 'idle');
  assert.equal(img.getAttribute('src'), null, 'an invalid empty replacement never reverts to an old costume');
});

test('framing normalizes transparent margins and maps source alpha without using the motion transform', async () => {
  const { art, img, character } = fixture();
  await art.setImage(img, character, 'idle');
  assert.match(img.style.objectViewBox, /^inset\(/);
  assert.equal(img.style.transform, 'rotate(1deg)');
  const geometry = art.sourceGeometry(img);
  assert.equal(geometry.scale, 0.3);
  assert.equal(geometry.left, -40);
  assert.equal(geometry.top, -10);
  assert.equal(geometry.crop.x, 200);
  assert.equal(geometry.crop.y, 100);
  assert.equal(geometry.crop.height, 1000);
  await art.setImage(img, original, 'idle');
  assert.equal(img.style.objectViewBox, undefined, 'switching back to an unframed image clears the crop');
  assert.equal(art.sourceGeometry(img).crop.width, 1000);
});

test('only the canonical new idle can blink and the new style survives restoration', async () => {
  const { art, img, character, timers, requests } = fixture();
  let commits=0;
  await art.setImage(img, character, 'idle', undefined, () => commits++);
  art.blink(img, character);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(img.getAttribute('src'), '../assets/custom/gpt/blink.png');
  assert.equal(timers.length, 1);
  assert.equal(commits, 2, 'blink invalidates the previous source-alpha mask before changing source');
  timers.shift()();
  assert.equal(img.getAttribute('src'), '../assets/custom/gpt/idle.png');
  assert.equal(commits, 3, 'restoring canonical idle also invalidates the closed-eye alpha mask');
  art.blink(img, { ...character, customBlink: '../outside.png' });
  assert.equal(timers.length, 0, 'an escaping blink path is never loaded');
  await art.setImage(img, character, 'thinking');
  art.blink(img, character);
  assert.equal(timers.length, 0);
  assert.equal(requests.some(value => value.includes('/crosspet/')), false);
});

test('a slow image request cannot overwrite a newer state or its crop', async () => {
  const { art, img, character } = fixture();
  const old = art.setImage(img, character, 'thinking');
  const current = art.setImage(img, character, 'idle');
  await Promise.all([old, current]);
  assert.equal(img.getAttribute('src'), '../assets/custom/gpt/idle.png');
  assert.match(img.style.objectViewBox, /^inset\(/);
});
