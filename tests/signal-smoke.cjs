'use strict';
const { app } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const targetRoot = process.env.AIPET_SMOKE_APP_ROOT || root;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const noSignalLine = 'I can see the app, but I’m waiting for an activity signal.';
let instance, pet, stamp = Date.now() - 1000;

async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(50); }
  throw new Error('Timed out: ' + label);
}

async function slot(provider) {
  return pet.webContents.executeJavaScript(`(() => {
    const slot = document.querySelector('.companion-slot[data-provider=${provider}]');
    if (!slot || slot.hidden) return null;
    return {state: slot.dataset.state, stageState: slot.querySelector('.art-stage').dataset.state,
      badge: slot.querySelector('.companion-state').textContent, speech: slot.querySelector('.speech').textContent,
      aria: slot.getAttribute('aria-label'), statusAria: slot.querySelector('.status').getAttribute('aria-label'),
      imageAlt: slot.querySelector('img').alt, image: slot.querySelector('img').getAttribute('src'),
      missing: slot.classList.contains('missing-signal')};
  })()`);
}

function presence(running, foreground = 'claude') {
  assert.equal(instance.acceptPresence({running, foreground, fullscreen: null}), true);
}

function ingest(provider, state, ageMs = 0) {
  stamp = ageMs ? Date.now() - ageMs : Math.max(stamp + 1, Date.now());
  const session = provider === 'claude' ? '11111111111111111111111111111111' : '22222222222222222222222222222222';
  assert.equal(instance.activity.ingest({version: 1, provider, state, session, at: new Date(stamp).toISOString()}), true);
  instance.refreshVisibility();
}

function clearProvider(provider) {
  for (const [key, event] of instance.activity.sessions) if (event.provider === provider) instance.activity.sessions.delete(key);
}

async function expectBadge(provider, badge, missing) {
  await until(async () => (await slot(provider))?.badge === badge, `${provider} badge ${badge}`);
  const value = await slot(provider);
  assert.equal(value.missing, missing);
  assert.equal(value.stageState, value.state, 'presentation must preserve the real/local animation state');
  if (missing) {
    assert.equal(value.speech, noSignalLine);
    for (const text of [value.aria, value.statusAria, value.imageAlt]) assert.ok(text.includes('No signal'));
  }
  return value;
}

(async () => {
  assert.equal(process.env.AIPET_DESKTOP_TEST, '1');
  assert.ok(process.env.AIPET_TEST_DATA);
  instance = await require(path.join(targetRoot, 'src/main.cjs')).ready;
  instance.updateSettings({reducedMotion: true});
  presence(['claude', 'codex']);
  pet = instance.getPet();
  pet.setOpacity(0);
  await until(() => !pet.webContents.isLoading() && pet.isVisible(), 'own renderer load');

  for (const provider of ['claude', 'codex']) {
    const value = await expectBadge(provider, 'No signal', true);
    assert.equal(value.state, 'idle');
    assert.ok(value.image.includes('/idle.webp'), 'missing signal leaves the original idle artwork in place');
  }
  instance.activity.lastInteraction = Date.now() - 8 * 3600000;
  for (const provider of ['claude', 'codex']) instance.activity.providerInteractions.set(provider, Date.now() - 8 * 3600000);
  instance.refreshVisibility();
  for (const provider of ['claude', 'codex']) {
    const value = await expectBadge(provider, 'No signal', true);
    await until(async () => (await slot(provider))?.state === 'sleeping', `${provider} sleeping pose`);
    assert.ok((await slot(provider)).image.includes('/sleeping'), 'sleeping artwork remains unchanged');
  }

  ingest('codex', 'thinking');
  await expectBadge('codex', 'Thinking', false);
  await expectBadge('claude', 'No signal', true);
  ingest('codex', 'idle');
  await expectBadge('codex', 'At ease', false);
  ingest('codex', 'success');
  await expectBadge('codex', 'Complete', false);
  clearProvider('codex');
  ingest('codex', 'success', 13000);
  await expectBadge('codex', 'At ease', false);

  await pet.webContents.executeJavaScript('window.aipet.preview("sleeping")');
  await expectBadge('claude', 'Resting · preview', false);
  await pet.webContents.executeJavaScript('window.aipet.interact("pat", "claude")');
  await expectBadge('claude', 'Happy', false);
  await pet.webContents.executeJavaScript('window.aipet.interact("poke", "claude")');
  await expectBadge('claude', 'Hello', false);
  await expectBadge('claude', 'No signal', true);

  ingest('claude', 'idle');
  await expectBadge('claude', 'At ease', false);
  clearProvider('codex');
  instance.updateSettings({followActivity: false, character: 'gpt'});
  presence(['claude', 'codex']);
  await expectBadge('codex', 'No signal', true);
  assert.equal(instance.snapshot().companions.length, 1, 'single pinned companion still identifies its missing provider signal');
  presence([], 'unknown');
  instance.showPet();
  await expectBadge('codex', 'At ease', false);

  console.log('Signal smoke passed: detected apps without activity show No signal; original poses and diagnostic states remain intact; actual activity, idle, settled completion, previews and local interactions retain their labels.');
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
