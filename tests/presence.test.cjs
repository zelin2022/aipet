'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Presence, validatePresence, GRACE_MS } = require('../src/core/presence.cjs');
const settings = { autoDormant:true, fullscreenHide:true };
const bounds = { x:100, y:100, width:340, height:410 };
const metadata = (running = [], fullscreen = null) => ({ foreground:'unknown', running, fullscreen });
test('tray dormancy wakes only for allowlisted process names or live metadata, then settles back', () => {
  const presence = new Presence();
  assert.equal(presence.decide({settings,bounds,now:0}).reason, 'dormant');
  presence.update(metadata(['codex']));
  assert.equal(presence.decide({settings,bounds,now:10}).show, true);
  presence.update(metadata());
  assert.equal(presence.decide({settings,bounds,now:11}).reason, 'settling');
  assert.equal(presence.decide({settings,bounds,now:11+GRACE_MS}).show, false);
  assert.equal(presence.decide({settings,bounds,activityProviders:['claude'],now:20000}).show, true);
});
test('manual hide survives new work and explicit resume/preview do not change saved settings', () => {
  const presence = new Presence(); presence.update(metadata(['codex']));
  presence.setMode('hidden');
  assert.equal(presence.decide({settings,bounds}).reason, 'hidden');
  presence.setMode('auto'); assert.equal(presence.decide({settings,bounds}).show,true);
  presence.update(metadata()); presence.lastSeen = -Infinity;
  assert.equal(presence.decide({settings,bounds,preview:true}).reason,'manual');
  assert.equal(presence.decide({settings,bounds}).show,false);
  presence.setMode('shown'); assert.equal(presence.decide({settings,bounds}).show,true);
  assert.equal(presence.setMode('execute'),false);
});
test('fullscreen suppression is limited to the pet monitor and restores automatically', () => {
  const presence = new Presence(); presence.update(metadata(['codex'],{x:0,y:0,width:1920,height:1080}));
  assert.equal(presence.decide({settings,bounds}).reason,'fullscreen');
  assert.equal(presence.decide({settings,bounds:{...bounds,x:-1800}}).show,true);
  assert.equal(presence.decide({settings:{...settings,fullscreenHide:false},bounds}).show,true);
  presence.update(metadata(['codex'])); assert.equal(presence.decide({settings,bounds}).show,true);
});
test('helper output cannot expose arbitrary names, command lines or malformed rectangles', () => {
  for (const value of [null,{},metadata(['node']),{...metadata(),pid:123},metadata([],{}),metadata([],{x:0,y:0,width:Infinity,height:100}),{...metadata(),foreground:'private title'}]) assert.equal(validatePresence(value),null);
  assert.deepEqual(validatePresence(metadata(['codex','codex'])).running,['codex']);
});
