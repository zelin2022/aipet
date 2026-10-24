'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, sanitizeSettings, clampBounds } = require('../src/core/settings.cjs');
const ids = ['claude', 'gpt'];

test('untrusted persisted preferences cannot enable flags through coercion or keep arbitrary keys', () => {
  const input = JSON.parse('{"__proto__":{"edgeDock":true}}');
  Object.assign(input, { character: '../secret', followActivity: 'false', showBoth: 'true', foregroundEnabled: 0,
    alwaysOnTop: 'true', reducedMotion: [], size: '120', position: { x: NaN, y: 0 },
    command: 'run anything', prompt: 'private' });
  const settings = sanitizeSettings(input, ids);
  assert.deepEqual(settings, DEFAULTS);
  assert.deepEqual(sanitizeSettings(null, ids), DEFAULTS);
  const valid = sanitizeSettings({ character: 'gpt', showBoth: false, foregroundEnabled: false, reducedMotion: true, size: 112.6 }, ids);
  assert.equal(valid.character, 'gpt');
  assert.equal(valid.showBoth, false);
  assert.equal(valid.foregroundEnabled, false);
  assert.equal(valid.reducedMotion, true);
  assert.equal(valid.size, 113);
});

test('finite size bounds and desktop coordinates cannot overflow native window APIs', () => {
  assert.equal(sanitizeSettings({ size: -1e100 }, ids).size, 70);
  assert.equal(sanitizeSettings({ size: 1e100 }, ids).size, 140);
  assert.equal(sanitizeSettings({ size: Infinity }, ids).size, DEFAULTS.size);
  assert.equal(sanitizeSettings({ size: NaN }, ids).size, DEFAULTS.size);
  for (const position of [{ x: 1e99, y: 0 }, { x: 2147483648, y: 0 }, { x: 0, y: -2147483649 }, { x: 1.5, y: 0 }]) {
    assert.equal(sanitizeSettings({ position }, ids).position, null);
  }
  assert.deepEqual(sanitizeSettings({ position: { x: -1920, y: 400, extra: 'discard' } }, ids).position, { x: -1920, y: 400 });
});

test('lost displays and oversized windows recover within work area including negative-origin monitors', () => {
  const workArea = { x: -1920, y: -200, width: 1920, height: 1040 };
  assert.deepEqual(clampBounds({ x: 99999, y: -99999 }, workArea, 340, 410), { x: -340, y: -200 });
  assert.deepEqual(clampBounds({ x: -1700, y: 100 }, workArea, 340, 410), { x: -1700, y: 100 });
  assert.deepEqual(clampBounds({ x: 0, y: 0 }, { x: 20, y: 30, width: 100, height: 80 }, 340, 410), { x: 20, y: 30 });
});
